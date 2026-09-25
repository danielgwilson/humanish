import type { Duplex } from "node:stream";
import { validateBrowserControlIdentity, sameBrowserControlIdentity, type BrowserControlIdentity } from "./browser-control-protocol.js";
import { CuaExecutorError } from "./cua-executor-error.js";
import { createBrowserControlClient } from "./browser-control-client.js";

export const GUEST_BOOTSTRAP_VERSION = 1;
export const GUEST_BOOTSTRAP_LIMITS = Object.freeze({ bytes: 65_536 + 1024, readyBytes: 1024, initialUrlBytes: 65_536,
  admissionMs: 5000, readyMs: 35_000, navigationMs: 30_000, paintMs: 5000, connectMs: 3000, port: 5251 });
const refused = (): CuaExecutorError => new CuaExecutorError("protocol_mismatch", "not_dispatched");
/** Same entry authority as the local desktop's opaque app-port forward. */
export function validateGuestInitialUrl(value: string): string {
  try {
    if (typeof value !== "string") throw refused();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname)
      || url.username || url.password || !/^\d+$/.test(url.port) || Number(url.port) < 1024
      || Buffer.byteLength(url.href) > GUEST_BOOTSTRAP_LIMITS.initialUrlBytes) throw refused();
    return url.href;
  } catch { throw refused(); }
}
export function guestReadyTimeoutMs(initialUrl?: string): number {
  return GUEST_BOOTSTRAP_LIMITS.readyMs + (initialUrl === undefined ? 0 : GUEST_BOOTSTRAP_LIMITS.navigationMs + GUEST_BOOTSTRAP_LIMITS.paintMs);
}
function canonical(identity: BrowserControlIdentity, ready: boolean, initialUrl?: string): string {
  const { generation, challenge, runtimeRevision } = validateBrowserControlIdentity(identity);
  const fixed = { generation, challenge, runtimeRevision };
  if (initialUrl !== undefined && (ready || validateGuestInitialUrl(initialUrl) !== initialUrl)) throw refused();
  return JSON.stringify(ready ? { version: 1, ready: true, identity: fixed }
    : { version: 1, identity: fixed, ...(initialUrl === undefined ? {} : { initialUrl }) });
}
export function encodeGuestBootstrap(identity: BrowserControlIdentity, ready = false, initialUrl?: string): Buffer {
  const bytes = Buffer.from(canonical(identity, ready, initialUrl));
  if (bytes.length > (ready ? GUEST_BOOTSTRAP_LIMITS.readyBytes : GUEST_BOOTSTRAP_LIMITS.bytes)) throw refused();
  const frame = Buffer.alloc(4 + bytes.length);
  frame.writeUInt32BE(bytes.length); bytes.copy(frame, 4);
  return frame;
}
export function parseGuestBootstrap(bytes: Buffer, revision: string, ready = false): BrowserControlIdentity {
  return parseBootstrap(bytes, revision, ready).identity;
}
function parseBootstrap(bytes: Buffer, revision: string, ready: boolean): { identity: BrowserControlIdentity; initialUrl?: string } {
  if (!bytes.length || bytes.length > (ready ? GUEST_BOOTSTRAP_LIMITS.readyBytes : GUEST_BOOTSTRAP_LIMITS.bytes) || bytes.some(byte => byte > 127)) throw refused();
  try {
    const value: unknown = JSON.parse(bytes.toString("ascii"));
    if (typeof value !== "object" || value === null || !("identity" in value)) throw refused();
    const identity = validateBrowserControlIdentity(value.identity);
    const initialUrl = "initialUrl" in value ? value.initialUrl : undefined;
    if (initialUrl !== undefined && typeof initialUrl !== "string") throw refused();
    if (identity.runtimeRevision !== revision || canonical(identity, ready, initialUrl) !== bytes.toString("ascii")) throw refused();
    return { identity, ...(initialUrl === undefined ? {} : { initialUrl }) };
  } catch { throw refused(); }
}

/** Own the first frame and continue refusing early bytes until synchronous handoff. */
export class GuestBootstrapReader {
  readonly identity: Promise<BrowserControlIdentity>;
  initialUrl: string | undefined;
  private resolve!: (identity: BrowserControlIdentity) => void;
  private reject!: (error: CuaExecutorError) => void;
  private readonly header = Buffer.alloc(4);
  private headerUsed = 0;
  private body: Buffer | undefined;
  private used = 0;
  private admitted = false;
  private terminal = false;
  private timer: NodeJS.Timeout;
  constructor(private readonly stream: Duplex, private readonly revision: string, private readonly signal: AbortSignal,
    private readonly ready = false, private readonly onFailure: () => void = () => {}, readyTimeoutMs: number = GUEST_BOOTSTRAP_LIMITS.readyMs) {
    this.identity = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    // A later factory rejection must not leave the admission rejection unconsumed.
    void this.identity.catch(() => {});
    this.timer = setTimeout(() => this.fail("deadline_exceeded"), ready ? readyTimeoutMs : GUEST_BOOTSTRAP_LIMITS.admissionMs);
    stream.on("error", this.error); stream.on("close", this.end); stream.on("end", this.end); stream.on("data", this.data);
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted || stream.destroyed || stream.readableEnded || stream.writableEnded || stream.readableObjectMode || stream.writableObjectMode) this.abort();
    else stream.resume();
  }
  private data = (value: unknown): void => {
    if (this.terminal) return;
    if (!Buffer.isBuffer(value) || this.admitted) { this.fail(); return; }
    let offset = 0;
    if (!this.body) {
      const count = Math.min(4 - this.headerUsed, value.length);
      value.copy(this.header, this.headerUsed, 0, count); this.headerUsed += count; offset += count;
      if (this.headerUsed < 4) return;
      const length = this.header.readUInt32BE(0);
      if (!length || length > (this.ready ? GUEST_BOOTSTRAP_LIMITS.readyBytes : GUEST_BOOTSTRAP_LIMITS.bytes)) { this.fail(); return; }
      this.body = Buffer.alloc(length);
    }
    const count = Math.min(value.length - offset, this.body.length - this.used);
    value.copy(this.body, this.used, offset, offset + count); this.used += count; offset += count;
    if (offset !== value.length) { this.fail(); return; }
    if (this.used === this.body.length) {
      try {
        const parsed = parseBootstrap(this.body, this.revision, this.ready);
        this.initialUrl = parsed.initialUrl;
        this.admitted = true; clearTimeout(this.timer); this.resolve(parsed.identity);
      } catch { this.fail(); }
    }
  };
  private error = (): void => this.fail("transport_failed");
  private end = (): void => this.fail("transport_failed");
  private abort = (): void => this.fail("session_revoked");
  private release(): void {
    clearTimeout(this.timer);
    this.stream.off("data", this.data); this.stream.off("end", this.end); this.stream.off("close", this.end);
    this.signal.removeEventListener("abort", this.abort);
    // Retain a safe listener until queued native error/close events have drained.
    const stream = this.stream, error = this.error;
    const off = (): void => { stream.off("error", error); stream.off("close", off); };
    stream.once("close", off);
    if (stream.closed) setImmediate(off);
  }
  private fail(code: "protocol_mismatch" | "deadline_exceeded" | "transport_failed" | "session_revoked" = "protocol_mismatch"): void {
    if (this.terminal) return;
    this.terminal = true; this.release(); this.reject(new CuaExecutorError(code, "not_dispatched"));
    this.stream.destroy(); this.onFailure();
  }
  /** Must be followed synchronously by installing the sole next stream owner. */
  handoff(): void {
    if (this.terminal || !this.admitted || this.signal.aborted || this.stream.destroyed || this.stream.readableLength !== 0) throw refused();
    this.stream.pause(); this.terminal = true; this.release();
  }
  close(): void { this.fail("session_revoked"); }
}

/** Fixed preface on an already acquired Firecracker stream; no path discovery/retry. */
export async function connectGuestBootstrap(stream: Duplex, identity: BrowserControlIdentity, signal: AbortSignal, initialUrl?: string): Promise<ReturnType<typeof createBrowserControlClient>> {
  validateBrowserControlIdentity(identity);
  const request = encodeGuestBootstrap(identity, false, initialUrl);
  await new Promise<void>((resolve, reject) => {
    let bytes = Buffer.alloc(0), done = false;
    const timer = setTimeout(() => finish(new CuaExecutorError("deadline_exceeded", "not_dispatched")), GUEST_BOOTSTRAP_LIMITS.connectMs);
    const finish = (error?: CuaExecutorError): void => {
      if (done) return; done = true; clearTimeout(timer);
      stream.pause(); stream.off("data", data); stream.off("end", end); stream.off("close", end); signal.removeEventListener("abort", abort);
      const release = (): void => { stream.off("error", end); stream.off("close", release); };
      stream.once("close", release);
      if (stream.closed) setImmediate(release);
      if (error) { stream.destroy(); reject(error); } else resolve();
    };
    const end = (): void => {
      if (done) stream.destroy();
      finish(new CuaExecutorError("transport_failed", "not_dispatched"));
    };
    const abort = (): void => finish(new CuaExecutorError("session_revoked", "not_dispatched"));
    const data = (chunk: Buffer): void => {
      if (!Buffer.isBuffer(chunk) || bytes.length + chunk.length > 64 + 1028) { finish(refused()); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) { if (bytes.length > 64) finish(refused()); return; }
      const line = bytes.subarray(0, newline + 1).toString("ascii");
      if (newline >= 64 || bytes.subarray(0, newline + 1).some(byte => byte > 127)
        || !/^OK [1-9][0-9]{0,9}\n$/.test(line) || Number(line.slice(3)) > 0xffffffff) { finish(refused()); return; }
      const tail = bytes.subarray(newline + 1);
      if (tail.length) { stream.pause(); stream.unshift(tail); }
      finish();
    };
    stream.on("error", end); stream.on("end", end); stream.on("close", end); stream.on("data", data);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted || stream.destroyed) abort();
    else { stream.resume(); stream.write("CONNECT 5251\n", error => { if (error) end(); }); }
  });
  const reader = new GuestBootstrapReader(stream, identity.runtimeRevision, signal, true, undefined, guestReadyTimeoutMs(initialUrl));
  try {
    stream.write(request, error => { if (error) reader.close(); });
    const actual = await reader.identity;
    if (!sameBrowserControlIdentity(actual, identity)) throw refused();
    reader.handoff();
  } catch (error) { reader.close(); stream.destroy(); throw error; }
  const client = createBrowserControlClient({ transport: stream, identity });
  stream.resume();
  return client;
}
