// JSON-RPC over a Codex app-server's stdio, for the codex-app-server actor. Every message in either
// direction goes to the caller's envelope handler first, so the run's trace sees it before it is
// acted on. The restricted launcher has its own bounded transport (restricted-transport.ts).
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

import { redactText } from "../../evidence/redaction.js";
import {
  formatJsonRpcError,
  isRecord,
  type JsonObject,
  type JsonRpcId,
} from "./app-server-trace.js";

export interface CodexStdioHandlers {
  /** Every message sent or received, before it is acted on. */
  envelope(direction: "client" | "server", message: JsonObject): void;
  /** A request from the server; the return value is sent back as its result. */
  serverRequest(message: JsonObject): JsonObject;
  /** A server message that carries a method and no id. */
  notification(message: JsonObject): void;
  /** Stderr output, unparseable stdout and stdin failures, already redacted and capped. */
  warning(source: string, message: string): void;
  /** A process-level failure, already redacted and capped. */
  error(source: string, message: string): void;
}

export class CodexStdioClient {
  /** Resolves when the child process has closed. */
  readonly closed: Promise<void>;
  exitCode: number | undefined;
  signal: NodeJS.Signals | undefined;
  private processError: Error | undefined;
  private stdinError: Error | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve(value: JsonObject): void; reject(error: Error): void }
  >();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    /** The command line, named in the error when the process exits mid-request. */
    private readonly commandName: string,
    private readonly handlers: CodexStdioHandlers,
  ) {
    this.closed = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        this.processError = error;
        handlers.error("process", redactText(error.message).slice(0, 1_000));
      });
      child.once("close", (code, signal) => {
        this.exitCode = code === null ? undefined : code;
        this.signal = signal === null ? undefined : signal;
        resolve();
      });
    });
    child.stdin.on("error", (error) => {
      this.stdinError = error;
      handlers.warning("stdin", redactText(error.message).slice(0, 1_000));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = redactText(chunk.toString("utf8"));
      if (text.trim()) handlers.warning("stderr", text.trim().slice(0, 1_000));
    });
    readline.createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
  }

  request(method: string, params: JsonObject | undefined): Promise<JsonObject> {
    const id = this.nextId;
    this.nextId += 1;
    const message: JsonObject = params === undefined ? { method, id } : { method, id, params };
    const promise = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.send(message);
    return promise;
  }

  notify(method: string, params: JsonObject): void {
    this.send({ method, params });
  }

  /** The response to a request, or an error naming the request if the process closes first. */
  response(promise: Promise<JsonObject>, method: string): Promise<JsonObject> {
    return Promise.race([
      promise,
      this.closed.then(() => {
        const detail =
          this.processError?.message ??
          this.stdinError?.message ??
          (this.exitCode === undefined ? "without an exit code" : `with code ${this.exitCode}`);
        throw new Error(
          `Codex app-server command '${this.commandName}' exited during ${method} ${detail}.`,
        );
      }),
    ]);
  }

  /** Rejects every request still waiting for a response. */
  rejectPending(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(new Error(reason));
    this.pending.clear();
  }

  private send(message: JsonObject): void {
    this.handlers.envelope("client", message);
    if (this.child.stdin.destroyed || this.stdinError || this.processError) {
      throw this.stdinError ?? this.processError ?? new Error("Codex app-server stdin is closed.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error && !this.stdinError) {
        this.stdinError = error;
        this.handlers.warning("stdin", redactText(error.message).slice(0, 1_000));
      }
    });
  }

  private receive(line: string): void {
    let parsed: JsonObject;
    try {
      parsed = JSON.parse(line) as JsonObject;
    } catch {
      this.handlers.warning("parse", "Received non-JSON app-server output line.");
      return;
    }
    this.handlers.envelope("server", parsed);
    const id = parsed.id;
    if (typeof id === "number" || typeof id === "string") {
      if (typeof parsed.method === "string") {
        this.send({ id, result: this.handlers.serverRequest(parsed) });
        return;
      }
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        if (isRecord(parsed.error)) pending.reject(new Error(formatJsonRpcError(parsed.error)));
        else pending.resolve(isRecord(parsed.result) ? parsed.result : {});
      }
      return;
    }
    if (typeof parsed.method === "string") this.handlers.notification(parsed);
  }
}
