import type { Duplex } from "node:stream";
import type { CuaAction, CuaExecutor, CuaObservation } from "./computer-use.js";
import { CuaExecutorError } from "./cua-executor-error.js";
import {
  BROWSER_CONTROL_LIMITS, BROWSER_CONTROL_VERSION, decodeBrowserControlObservation,
  parseBrowserControlReply, sameBrowserControlIdentity, validateBrowserControlAction, validateBrowserControlIdentity,
  type BrowserControlIdentity, type BrowserControlReply, type BrowserControlRequest
} from "./browser-control-protocol.js";
import { BrowserControlTransport } from "./browser-control-transport.js";

export interface BrowserControlClientOptions { transport: Duplex; identity: BrowserControlIdentity; requestTimeoutMs?: number }
export interface BrowserControlClient { executor: CuaExecutor; ready(): Promise<void>; close(): void }

export function createBrowserControlClient(options: BrowserControlClientOptions): BrowserControlClient {
  const identity = validateBrowserControlIdentity(options.identity);
  const timeoutMs = options.requestTimeoutMs ?? BROWSER_CONTROL_LIMITS.requestTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > BROWSER_CONTROL_LIMITS.maxRequestTimeoutMs) throw new CuaExecutorError("invalid_request", "not_dispatched");
  let seq = 0, busy = false, ready = false, closed = false;
  let pending: { request: BrowserControlRequest; written: boolean; writeComplete: boolean; reply?: BrowserControlReply;
    resolve: (reply: BrowserControlReply) => void; reject: (error: CuaExecutorError) => void; dispose: () => void } | undefined;
  const finish = (): void => {
    if (!pending?.reply || !pending.writeComplete) return;
    const operation = pending; pending = undefined; operation.dispose();
    if (operation.reply!.ok) operation.resolve(operation.reply!);
    else {
      transport.close(operation.reply!.error.code);
      operation.reject(new CuaExecutorError(operation.reply!.error.code, operation.reply!.error.disposition));
    }
  };
  const transport = new BrowserControlTransport(options.transport, value => {
    if (!pending || pending.reply) { transport.close("invalid_response"); return; }
    let reply: BrowserControlReply;
    try { reply = parseBrowserControlReply(value); } catch { transport.close("invalid_response"); return; }
    const request = pending.request;
    if (!sameBrowserControlIdentity(identity, reply.identity) || request.seq !== reply.seq || request.requestId !== reply.requestId
      || request.operation !== reply.operation || (request.operation === "EXECUTE" ? request.actionId !== reply.actionId : reply.actionId !== undefined)) {
      transport.close("protocol_mismatch"); return;
    }
    pending.reply = reply; finish();
  }, code => {
    closed = true;
    const operation = pending; pending = undefined;
    if (operation) { operation.dispose(); operation.reject(new CuaExecutorError(code, operation.written ? "outcome_uncertain" : "not_dispatched")); }
  });
  const exchange = (operation: "HELLO" | "OBSERVE" | "EXECUTE", action?: CuaAction, signal?: AbortSignal): Promise<BrowserControlReply> => {
    if (closed) return Promise.reject(new CuaExecutorError("executor_closed", "not_dispatched"));
    if (signal?.aborted) return Promise.reject(new CuaExecutorError("cancelled", "not_dispatched"));
    if (seq >= Number.MAX_SAFE_INTEGER) { transport.close("protocol_mismatch"); return Promise.reject(new CuaExecutorError("protocol_mismatch", "not_dispatched")); }
    seq += 1;
    const base = { version: BROWSER_CONTROL_VERSION as typeof BROWSER_CONTROL_VERSION, type: "request" as const, identity, seq, requestId: `request-${seq}` };
    const request: BrowserControlRequest = operation === "EXECUTE"
      ? { ...base, operation, actionId: `action-${seq}`, action: action! } : { ...base, operation };
    return new Promise((resolve, reject) => {
      const abort = (): void => transport.close("cancelled");
      const timer = setTimeout(() => transport.close("deadline_exceeded"), timeoutMs);
      const slot = { request, written: false, writeComplete: false, resolve, reject,
        dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
      pending = slot; signal?.addEventListener("abort", abort, { once: true });
      void transport.send(request, () => { slot.written = true; }).then(() => {
        if (pending !== slot) return;
        slot.writeComplete = true; finish();
      }, () => { if (pending === slot) transport.close("transport_failed"); });
    });
  };
  const withOperation = async <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) throw new CuaExecutorError("executor_closed", "not_dispatched");
    if (busy) throw new CuaExecutorError("executor_busy", "not_dispatched");
    busy = true;
    try { return await work(); } finally { busy = false; }
  };
  const ensureReady = async (signal?: AbortSignal): Promise<void> => {
    if (ready) return;
    await exchange("HELLO", undefined, signal); ready = true;
  };
  const executor: CuaExecutor & { readonly stallRecovery: "fail_closed" } = {
    stallRecovery: "fail_closed",
    observe: () => withOperation(async (): Promise<CuaObservation> => {
      await ensureReady();
      const reply = await exchange("OBSERVE");
      try {
        if (!reply.ok || !reply.observation) throw new Error();
        return decodeBrowserControlObservation(reply.observation);
      } catch { transport.close("invalid_response"); throw new CuaExecutorError("invalid_response", "outcome_uncertain"); }
    }),
    execute: (action, signal) => withOperation(async () => {
      const validAction = validateBrowserControlAction(action);
      if (signal?.aborted) throw new CuaExecutorError("cancelled", "not_dispatched");
      try { await ensureReady(signal); }
      catch (error) {
        if (error instanceof CuaExecutorError) throw new CuaExecutorError(error.code, "not_dispatched");
        throw error;
      }
      await exchange("EXECUTE", validAction, signal);
    })
  };
  return { executor, ready: () => withOperation(ensureReady), close: () => transport.close() };
}
