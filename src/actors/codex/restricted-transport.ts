import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  CODEX_MAX_EVENTS,
  CODEX_MAX_OUTPUT_BYTES,
  CODEX_MAX_STDOUT_BYTES,
  codexRecord,
  type RestrictedCodexAnalysisErrorCode,
} from "./restricted-policy.js";

export type RestrictedCodexSpawn = (
  file: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & {
    stdio: ["pipe", "pipe", "pipe"];
    detached: false;
  },
) => ChildProcessWithoutNullStreams;

/** No raw provider prose, stderr, path, or cause is attached to this error. */
export class RestrictedCodexStop extends Error {
  /** `detectedVersion`: the release an unadmitted CLI reported, so a refusal can name it. */
  constructor(
    readonly code: RestrictedCodexAnalysisErrorCode,
    readonly detectedVersion?: string,
  ) {
    super(code);
  }
}

export class RestrictedCodexDeadline {
  private deadlineAt: number;
  code: RestrictedCodexAnalysisErrorCode | null = null;
  private readonly stopped: Promise<never>;
  private rejectStopped!: (reason: RestrictedCodexStop) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private paused = false;
  private readonly onAbort = (): void => this.stop("cancelled");

  constructor(
    private readonly timeoutMs: number,
    private readonly signal?: AbortSignal,
  ) {
    this.deadlineAt = performance.now() + timeoutMs;
    this.stopped = new Promise<never>((_resolve, reject) => {
      this.rejectStopped = reject;
    });
    void this.stopped.catch(() => undefined);
    this.arm(timeoutMs);
    signal?.addEventListener("abort", this.onAbort, { once: true });
    if (signal?.aborted) this.stop("cancelled");
  }
  stop(code: RestrictedCodexAnalysisErrorCode): void {
    if (this.code !== null) return;
    this.code = code;
    this.rejectStopped(new RestrictedCodexStop(code));
  }
  get expiresAt(): number {
    return this.deadlineAt;
  }
  private arm(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.stop("timeout"), Math.max(1, ms));
  }
  /** Host tool execution is outside model time. A response starts a fresh inference slice. */
  pause(): void {
    this.check();
    if (this.paused) throw new RestrictedCodexStop("codex_protocol_error");
    clearTimeout(this.timer);
    this.timer = undefined;
    this.paused = true;
  }
  resume(): void {
    if (!this.paused || this.code !== null) return;
    this.paused = false;
    this.deadlineAt = performance.now() + this.timeoutMs;
    this.arm(this.timeoutMs);
  }
  check(): void {
    if (!this.paused && this.code === null && performance.now() >= this.deadlineAt)
      this.stop("timeout");
    if (this.code !== null) throw new RestrictedCodexStop(this.code);
  }
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.check();
    const result = await Promise.race([promise, this.stopped]);
    this.check();
    return result;
  }
  close(): void {
    clearTimeout(this.timer);
    this.signal?.removeEventListener("abort", this.onAbort);
  }
}

// Codex processes that did not confirm closing. A session refuses new work while any remain.
const unclosedChildren = new Set<Promise<void>>();
export function retainUnclosedChild(closed: Promise<void>): void {
  unclosedChildren.add(closed);
  void closed.then(() => {
    unclosedChildren.delete(closed);
  });
}
export const hasUnclosedChildren = (): boolean => unclosedChildren.size > 0;

export interface OwnedCodexProcess {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  isClosed(): boolean;
  hasExited(): boolean;
  /** humanish began stopping the process (closeOwnedCodexProcess): its stdin ended, signals follow. */
  stopRequested(): boolean;
  requestStop(): void;
}
export function ownCodexProcess(child: ChildProcessWithoutNullStreams): OwnedCodexProcess {
  let closed = false,
    exited = false,
    stopping = false;
  child.once("exit", () => {
    exited = true;
  });
  const completion = new Promise<void>((resolve) => {
    child.once("close", () => {
      closed = true;
      resolve();
    });
  });
  return {
    child,
    closed: completion,
    isClosed: () => closed,
    hasExited: () => exited,
    stopRequested: () => stopping,
    requestStop: () => {
      stopping = true;
    },
  };
}

async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Own only the directly spawned native process. Never signal a stored PID/PGID
 * after exit; it can have been recycled. This is not a whole-process-tree lease. */
function signalOwnedChild(owned: OwnedCodexProcess, signal: NodeJS.Signals): void {
  if (owned.hasExited() || owned.isClosed()) return;
  try {
    owned.child.kill(signal);
  } catch {
    /* Closing is still checked below. */
  }
}
export async function closeOwnedCodexProcess(owned: OwnedCodexProcess): Promise<boolean> {
  owned.requestStop();
  owned.child.stdin.end();
  signalOwnedChild(owned, "SIGTERM");
  if (!owned.isClosed()) await settlesWithin(owned.closed, 1500);
  signalOwnedChild(owned, "SIGKILL");
  if (!owned.isClosed()) await settlesWithin(owned.closed, 1000);
  const closed = owned.isClosed();
  owned.child.stdin.destroy();
  owned.child.stdout.destroy();
  owned.child.stderr.destroy();
  return closed;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

type Pending = {
  resolve(value: Record<string, unknown>): void;
  reject(error: RestrictedCodexStop): void;
};

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
  /** Notifications after the deadline stopped or close began: no turn handles them, only the policy. */
  onPolicyOnlyNotification: (method: string, params: Record<string, unknown>) => void = () =>
    undefined;
  /** A server request with no handler, or output that could not be checked (failUninspected). */
  onPolicyFailure: (code: RestrictedCodexAnalysisErrorCode) => void = () => undefined;
  /** The size of a last frame cut off after humanish stopped the process: a warning only. */
  onTruncatedFrame: (bytes: number) => void = () => undefined;
  onRequest:
    | ((method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>)
    | undefined;
  onRequestComplete: (() => void) | undefined;

  constructor(
    readonly owned: OwnedCodexProcess,
    private deadline: RestrictedCodexDeadline,
    private frameLimit = CODEX_MAX_OUTPUT_BYTES,
  ) {
    const child = owned.child;
    child.on("error", () => this.fail("codex_process_failed"));
    child.stdin.on("error", () => this.fail("codex_process_failed"));
    child.on("close", () => this.fail("codex_process_failed"));
    // Output is read until the process exits. Once the deadline stops or close begins, it is read
    // for the item policy only (message); only the byte and frame limits stop reading, and they
    // count as unchecked output.
    child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBytes += chunk.length;
      if (
        this.stdoutBytes >
        Math.max(CODEX_MAX_STDOUT_BYTES, this.frameLimit * 2 + CODEX_MAX_OUTPUT_BYTES * 2)
      ) {
        this.failUninspected("response_too_large");
        return;
      }
      this.line += this.decoder.write(chunk);
      if (Buffer.byteLength(this.line) > this.frameLimit) {
        this.failUninspected("response_too_large");
        return;
      }
      while (this.line.includes("\n")) {
        const split = this.line.indexOf("\n");
        const line = this.line.slice(0, split);
        this.line = this.line.slice(split + 1);
        this.frame(line);
      }
    });
    // A last frame without its newline is parsed when it is whole JSON. One cut off after humanish
    // stopped the process was cut by that stop, so it is a warning with its size; any other cut-off
    // frame went unchecked.
    child.stdout.on("end", () => {
      const rest = this.line + this.decoder.end();
      this.line = "";
      const lines = rest.split("\n").filter((line) => line.length > 0);
      const last = lines.pop();
      for (const line of lines) this.frame(line);
      if (last === undefined) return;
      if (this.owned.stopRequested() && !isJson(last))
        this.onTruncatedFrame(Buffer.byteLength(last));
      else this.frame(last);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBytes += chunk.length;
      if (this.stderrBytes > CODEX_MAX_OUTPUT_BYTES) this.fail("response_too_large");
    });
  }
  /** A completed turn releases its deadline and wire budget, not its conversation. */
  beginRequest(deadline: RestrictedCodexDeadline, frameLimit: number): void {
    if (this.deadline.code !== null) throw new RestrictedCodexStop(this.deadline.code);
    if (this.closing || this.owned.isClosed() || this.pending.size)
      throw new RestrictedCodexStop("codex_process_failed");
    this.deadline = deadline;
    this.frameLimit = frameLimit;
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.eventCount = 0;
  }
  /** One line of output: a malformed line could not be checked. */
  private frame(line: string): void {
    let parsed: unknown;
    try {
      parsed = line.length === 0 ? undefined : (JSON.parse(line) as unknown);
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) {
      this.failUninspected("codex_protocol_error");
      return;
    }
    try {
      this.message(parsed);
    } catch {
      this.fail("codex_protocol_error");
    }
  }
  /**
   * Output that could not be checked: past a byte, frame or event limit, malformed, or cut off.
   * The session records it through onPolicyFailure, whatever state the transport is in.
   */
  private failUninspected(code: RestrictedCodexAnalysisErrorCode): void {
    this.onPolicyFailure(code);
    this.fail(code);
  }
  /**
   * Refuses the session with `code`: stops the current deadline and rejects pending requests.
   * Between requests the stopped deadline makes the next beginRequest throw the code.
   */
  refuse(code: RestrictedCodexAnalysisErrorCode): void {
    this.fail(code);
  }
  private fail(code: RestrictedCodexAnalysisErrorCode): void {
    if (!this.closing) this.deadline.stop(code);
    for (const pending of this.pending.values()) pending.reject(new RestrictedCodexStop(code));
    this.pending.clear();
  }
  private message(raw: unknown): void {
    const value = codexRecord(raw);
    if (Object.keys(value).length === 0) {
      this.failUninspected("codex_protocol_error");
      return;
    }
    // After the deadline stopped or close began, output is read for the item policy only.
    const policyOnly = this.closing || this.deadline.code !== null;
    if (value.id !== undefined && typeof value.method === "string") {
      // A server request is then declined unhandled: its turn is over or being interrupted, so a
      // tool call that crossed the stop runs nothing and is not a policy refusal.
      if (policyOnly) {
        try {
          this.write({
            id: value.id,
            error: { code: -32601, message: "Host request is disabled" },
          });
        } catch {
          /* The process is already closing. */
        }
        return;
      }
      if (!this.onRequest || ++this.eventCount > CODEX_MAX_EVENTS) {
        const code = this.eventCount > CODEX_MAX_EVENTS ? "response_too_large" : "codex_tool_call";
        this.onPolicyFailure(code);
        this.write({ id: value.id, error: { code: -32601, message: "Host request is disabled" } });
        this.fail(code);
        return;
      }
      const id = value.id;
      void this.onRequest(value.method, codexRecord(value.params)).then(
        (result) => {
          try {
            if (this.closing || this.deadline.code !== null) return;
            this.write({ id, result });
            this.deadline.resume();
            this.stdoutBytes = 0;
            this.eventCount = 0;
            this.onRequestComplete?.();
          } catch {
            this.fail("codex_process_failed");
          }
        },
        (error) => {
          try {
            if (!this.closing && this.deadline.code === null)
              this.write({ id, error: { code: -32000, message: "Host request failed" } });
          } catch {
            /* The owned process is already failing. */
          }
          this.fail(error instanceof RestrictedCodexStop ? error.code : "codex_tool_call");
        },
      );
      return;
    }
    if (typeof value.id === "number" && value.method === undefined) {
      const pending = this.pending.get(value.id);
      if (!pending) {
        // A late reply, such as an interrupt's after its wait, carries no item.
        if (!policyOnly) this.fail("codex_protocol_error");
        return;
      }
      this.pending.delete(value.id);
      if (value.error !== undefined)
        pending.reject(new RestrictedCodexStop("codex_protocol_error"));
      else if (
        value.result === null ||
        typeof value.result !== "object" ||
        Array.isArray(value.result)
      )
        pending.reject(new RestrictedCodexStop("codex_protocol_error"));
      else pending.resolve(codexRecord(value.result));
      return;
    }
    if (
      typeof value.method !== "string" ||
      value.id !== undefined ||
      ++this.eventCount > CODEX_MAX_EVENTS
    ) {
      this.failUninspected(
        this.eventCount > CODEX_MAX_EVENTS ? "response_too_large" : "codex_protocol_error",
      );
      return;
    }
    if (policyOnly) this.onPolicyOnlyNotification(value.method, codexRecord(value.params));
    else this.onNotification(value.method, codexRecord(value.params));
  }
  private write(value: unknown): void {
    if (this.owned.isClosed() || this.owned.child.stdin.destroyed)
      throw new RestrictedCodexStop("codex_process_failed");
    this.owned.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  notify(method: string, params: Record<string, unknown>): void {
    this.deadline.check();
    this.write({ method, params });
  }
  private request(
    method: string,
    params: Record<string, unknown>,
  ): { id: number; result: Promise<Record<string, unknown>> } {
    const id = ++this.nextId;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ id, method, params });
      } catch {
        this.pending.delete(id);
        reject(new RestrictedCodexStop("codex_process_failed"));
      }
    });
    void result.catch(() => undefined);
    return { id, result };
  }
  async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.deadline.check();
    const { id, result } = this.request(method, params);
    const timer = setTimeout(
      () => this.deadline.stop("timeout"),
      Math.min(15_000, Math.max(1, this.deadline.expiresAt - performance.now())),
    );
    try {
      return await this.deadline.wait(result);
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
  async close(interrupt?: { threadId: string; turnId: string }): Promise<boolean> {
    this.closing = true;
    // Shutdown output gets its own byte and event budget.
    this.stdoutBytes = 0;
    this.eventCount = 0;
    if (interrupt && !this.owned.isClosed()) {
      const { id, result } = this.request("turn/interrupt", interrupt);
      await settlesWithin(result, 1000);
      this.pending.delete(id);
    }
    this.fail("codex_process_failed");
    return closeOwnedCodexProcess(this.owned);
  }
}
