import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CODEX_MAX_EVENTS, CODEX_MAX_OUTPUT_BYTES, CODEX_MAX_STDOUT_BYTES, codexRecord,
  type RestrictedCodexAnalysisErrorCode } from "./restricted-codex-policy.js";

export type RestrictedCodexSpawn = (file: string, args: string[], options: SpawnOptionsWithoutStdio & {
  stdio: ["pipe", "pipe", "pipe"]; detached: false;
}) => ChildProcessWithoutNullStreams;

/** No raw provider prose, stderr, path, or cause is attached to this error. */
export class RestrictedCodexStop extends Error {
  constructor(readonly code: RestrictedCodexAnalysisErrorCode) { super(code); }
}

export class RestrictedCodexDeadline {
  readonly expiresAt: number;
  code: RestrictedCodexAnalysisErrorCode | null = null;
  private readonly stopped: Promise<never>;
  private rejectStopped!: (reason: RestrictedCodexStop) => void;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onAbort = (): void => this.stop("cancelled");

  constructor(timeoutMs: number, private readonly signal?: AbortSignal) {
    this.expiresAt = performance.now() + timeoutMs;
    this.stopped = new Promise<never>((_resolve, reject) => { this.rejectStopped = reject; });
    void this.stopped.catch(() => undefined);
    this.timer = setTimeout(() => this.stop("timeout"), timeoutMs);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.stop("cancelled");
  }
  stop(code: RestrictedCodexAnalysisErrorCode): void {
    if (this.code !== null) return;
    this.code = code;
    this.rejectStopped(new RestrictedCodexStop(code));
  }
  check(): void {
    if (this.code === null && performance.now() >= this.expiresAt) this.stop("timeout");
    if (this.code !== null) throw new RestrictedCodexStop(this.code);
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.check();
    const result = await Promise.race([promise, this.stopped]);
    this.check();
    return result;
  }
  close(): void { clearTimeout(this.timer); this.signal?.removeEventListener("abort", this.onAbort); }
}

export interface OwnedCodexProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  isClosed(): boolean;
  hasExited(): boolean;
}
export function ownCodexProcess(child: ChildProcessWithoutNullStreams): OwnedCodexProcess {
  let closed = false, exited = false;
  child.once("exit", () => { exited = true; });
  const completion = new Promise<void>(resolve => {
    child.once("close", () => { closed = true; resolve(); });
  });
  return { child, closed: completion, isClosed: () => closed, hasExited: () => exited };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise.then(() => true, () => true), new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), ms);
  })]); } finally { clearTimeout(timer); }
}

/** Own only the directly spawned native process. Never signal a stored PID/PGID
 * after exit; it can have been recycled. This is not a whole-process-tree lease. */
function signalOwnedChild(owned: OwnedCodexProcess, signal: NodeJS.Signals): void {
  if (owned.hasExited() || owned.isClosed()) return;
  try { owned.child.kill(signal); } catch { /* Closing is still checked below. */ }
}
export async function closeOwnedCodexProcess(owned: OwnedCodexProcess): Promise<boolean> {
  owned.child.stdin.end();
  signalOwnedChild(owned, "SIGTERM");
  if (!owned.isClosed()) await settlesWithin(owned.closed, 1500);
  signalOwnedChild(owned, "SIGKILL");
  if (!owned.isClosed()) await settlesWithin(owned.closed, 1000);
  const closed = owned.isClosed();
  owned.child.stdin.destroy(); owned.child.stdout.destroy(); owned.child.stderr.destroy();
  return closed;
}

type Pending = { resolve(value: Record<string, unknown>): void; reject(error: RestrictedCodexStop): void };

export class RestrictedCodexTransport {
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private line = "";
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private eventCount = 0;
  private closing = false;
  onNotification: (method: string, params: Record<string, unknown>) => void = () => undefined;

  constructor(readonly owned: OwnedCodexProcess, private readonly deadline: RestrictedCodexDeadline,
    private readonly frameLimit = CODEX_MAX_OUTPUT_BYTES) {
    const child = owned.child;
    child.on("error", () => this.fail("codex_process_failed"));
    child.stdin.on("error", () => this.fail("codex_process_failed"));
    child.on("close", () => this.fail("codex_process_failed"));
    child.stdout.on("data", (chunk: Buffer) => {
      if ((!this.closing && deadline.code !== null) || (this.closing && this.pending.size === 0)) return;
      this.stdoutBytes += chunk.length;
      if (this.stdoutBytes > Math.max(CODEX_MAX_STDOUT_BYTES, this.frameLimit * 2 + CODEX_MAX_OUTPUT_BYTES * 2)) {
        this.fail("response_too_large"); return;
      }
      this.line += this.decoder.write(chunk);
      if (Buffer.byteLength(this.line) > this.frameLimit) { this.fail("response_too_large"); return; }
      while (this.line.includes("\n")) {
        const split = this.line.indexOf("\n"), line = this.line.slice(0, split);
        this.line = this.line.slice(split + 1);
        if (line.length === 0) { this.fail("codex_protocol_error"); return; }
        try { this.message(JSON.parse(line) as unknown); } catch { this.fail("codex_protocol_error"); }
        if (deadline.code !== null && !this.closing) return;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > CODEX_MAX_OUTPUT_BYTES) this.fail("response_too_large");
    });
  }
  private fail(code: RestrictedCodexAnalysisErrorCode): void {
    if (!this.closing) this.deadline.stop(code);
    for (const pending of this.pending.values()) pending.reject(new RestrictedCodexStop(code));
    this.pending.clear();
  }
  private message(raw: unknown): void {
    const value = codexRecord(raw);
    if (Object.keys(value).length === 0) { this.fail("codex_protocol_error"); return; }
    if (value.id !== undefined && typeof value.method === "string") {
      this.write({ id: value.id, error: { code: -32601, message: "Analyst host requests are disabled" } });
      this.fail("codex_tool_call"); return;
    }
    if (typeof value.id === "number" && value.method === undefined) {
      const pending = this.pending.get(value.id);
      if (!pending) { this.fail("codex_protocol_error"); return; }
      this.pending.delete(value.id);
      if (value.error !== undefined) pending.reject(new RestrictedCodexStop("codex_protocol_error"));
      else if (value.result === null || typeof value.result !== "object" || Array.isArray(value.result))
        pending.reject(new RestrictedCodexStop("codex_protocol_error"));
      else pending.resolve(codexRecord(value.result));
      return;
    }
    if (typeof value.method !== "string" || value.id !== undefined || ++this.eventCount > CODEX_MAX_EVENTS) {
      this.fail(this.eventCount > CODEX_MAX_EVENTS ? "response_too_large" : "codex_protocol_error"); return;
    }
    if (!this.closing) this.onNotification(value.method, codexRecord(value.params));
  }
  private write(value: unknown): void {
    if (this.owned.isClosed() || this.owned.child.stdin.destroyed) throw new RestrictedCodexStop("codex_process_failed");
    this.owned.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  notify(method: string, params: Record<string, unknown>): void { this.deadline.check(); this.write({ method, params }); }
  private request(method: string, params: Record<string, unknown>): { id: number; result: Promise<Record<string, unknown>> } {
    const id = ++this.nextId;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ id, method, params }); } catch {
        this.pending.delete(id); reject(new RestrictedCodexStop("codex_process_failed"));
      }
    });
    void result.catch(() => undefined);
    return { id, result };
  }
  async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.deadline.check();
    const { id, result } = this.request(method, params);
    const timer = setTimeout(() => this.deadline.stop("timeout"), Math.min(15_000, Math.max(1, this.deadline.expiresAt - performance.now())));
    try { return await this.deadline.wait(result); }
    finally { clearTimeout(timer); this.pending.delete(id); }
  }
  async close(interrupt?: { threadId: string; turnId: string }): Promise<boolean> {
    this.closing = true;
    if (interrupt && !this.owned.isClosed()) {
      const { id, result } = this.request("turn/interrupt", interrupt);
      await settlesWithin(result, 1000);
      this.pending.delete(id);
    }
    this.fail("codex_process_failed");
    return closeOwnedCodexProcess(this.owned);
  }
}
