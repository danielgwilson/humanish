import type { Duplex } from "node:stream";
import { TextDecoder } from "node:util";
import { BROWSER_CONTROL_LIMITS } from "./browser-control-protocol.js";
import { CuaExecutorError, type CuaExecutorErrorCode } from "./cua-executor-error.js";

/** Owned byte channel only. This module never discovers endpoints or reconnects. */
export class BrowserControlTransport {
  private header = Buffer.alloc(4);
  private headerUsed = 0;
  private payload: Buffer | undefined;
  private payloadUsed = 0;
  private ended = false;
  private sending = false;
  private pendingWrite: ((error: CuaExecutorError) => void) | undefined;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  constructor(private readonly stream: Duplex, private readonly onFrame: (value: unknown) => void,
    private readonly onClose: (code: CuaExecutorErrorCode) => void) {
    // destroy(error) queues its error event; even a rejected stream needs a listener
    // before inspecting its state. Never let the native error escape to the process.
    stream.on("error", this.error);
    if (stream.readableObjectMode || stream.writableObjectMode || stream.destroyed || stream.readableEnded || stream.writableEnded) {
      this.close("transport_failed"); return;
    }
    stream.on("data", this.data);
    stream.on("end", this.end);
    stream.on("close", this.end);
  }
  get closed(): boolean { return this.ended; }
  private data = (chunk: unknown): void => {
    if (this.ended) return;
    if (!Buffer.isBuffer(chunk)) { this.close("invalid_response"); return; }
    let offset = 0;
    while (offset < chunk.length && !this.ended) {
      if (!this.payload) {
        if (this.headerUsed === 0) this.frameTimer = setTimeout(() => this.close("deadline_exceeded"), BROWSER_CONTROL_LIMITS.requestTimeoutMs);
        const count = Math.min(4 - this.headerUsed, chunk.length - offset);
        chunk.copy(this.header, this.headerUsed, offset, offset + count);
        this.headerUsed += count; offset += count;
        if (this.headerUsed < 4) continue;
        const length = this.header.readUInt32BE(0);
        if (length === 0 || length > BROWSER_CONTROL_LIMITS.frameBytes) { this.close("invalid_response"); return; }
        this.payload = Buffer.allocUnsafe(length); this.payloadUsed = 0;
      }
      const count = Math.min(this.payload.length - this.payloadUsed, chunk.length - offset);
      chunk.copy(this.payload, this.payloadUsed, offset, offset + count);
      this.payloadUsed += count; offset += count;
      if (this.payloadUsed === this.payload.length) {
        const frame = this.payload;
        clearTimeout(this.frameTimer); this.frameTimer = undefined;
        this.payload = undefined; this.payloadUsed = 0; this.headerUsed = 0;
        try { this.onFrame(JSON.parse(this.decoder.decode(frame))); }
        catch { this.close("invalid_response"); }
      }
    }
  };
  private error = (): void => { this.close("transport_failed"); };
  private end = (): void => { this.close(this.payload || this.headerUsed ? "invalid_response" : "transport_failed"); };
  send(value: unknown, beforeWrite: () => void = () => {}): Promise<void> {
    if (this.ended) return Promise.reject(new CuaExecutorError("executor_closed", "not_dispatched"));
    if (this.sending) return Promise.reject(new CuaExecutorError("executor_busy", "not_dispatched"));
    let payload: Buffer;
    try {
      const json = JSON.stringify(value);
      if (typeof json !== "string" || Buffer.byteLength(json) > BROWSER_CONTROL_LIMITS.frameBytes) throw new Error();
      payload = Buffer.from(json);
    } catch { return Promise.reject(new CuaExecutorError("invalid_request", "not_dispatched")); }
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length); payload.copy(frame, 4);
    this.sending = true;
    return new Promise<void>((resolve, reject) => {
      const done = (error?: CuaExecutorError): void => {
        if (!this.pendingWrite) return;
        this.pendingWrite = undefined; this.sending = false;
        error ? reject(error) : resolve();
      };
      this.pendingWrite = done;
      try {
        beforeWrite();
        if (this.ended) { done(new CuaExecutorError("executor_closed", "not_dispatched")); return; }
        this.stream.write(frame, error => {
          if (error) { this.close("transport_failed"); return; }
          done();
        });
      } catch { this.close("transport_failed"); }
    });
  }
  close(code: CuaExecutorErrorCode = "executor_closed"): void {
    if (this.ended) return;
    this.ended = true; this.payload = undefined; this.headerUsed = 0; this.payloadUsed = 0;
    clearTimeout(this.frameTimer); this.frameTimer = undefined;
    this.stream.off("data", this.data); this.stream.off("end", this.end); this.stream.off("close", this.end);
    // Retain the safe error listener until close, including errors queued by a pending write.
    const releaseListeners = (): void => {
      this.stream.off("error", this.error);
      this.stream.off("close", releaseListeners);
    };
    this.stream.once("close", releaseListeners);
    this.pendingWrite?.(new CuaExecutorError(code, "outcome_uncertain"));
    this.stream.destroy();
    // A stream whose close event already happened will not emit it again. `closed`
    // can also precede queued error/close events, so defer removal past native ticks.
    if (this.stream.closed) setImmediate(releaseListeners);
    this.onClose(code);
  }
}
