import type { Duplex } from "node:stream";
import type { CuaExecutor } from "./computer-use.js";
import { CuaExecutorError } from "./cua-executor-error.js";
import {
  BROWSER_CONTROL_LIMITS, BROWSER_CONTROL_VERSION, encodeBrowserControlObservation, parseBrowserControlRequest,
  safeBrowserControlFailure, sameBrowserControlIdentity, validateBrowserControlIdentity,
  type BrowserControlIdentity, type BrowserControlReply, type BrowserControlRequest
} from "./browser-control-protocol.js";
import { BrowserControlTransport } from "./browser-control-transport.js";

export interface BrowserControlDispatcherOptions {
  transport: Duplex; identity: BrowserControlIdentity; executor: CuaExecutor;
  isAuthorized: () => boolean; authoritySignal: AbortSignal;
}
/** Caller retains physical runtime ownership. Closing this channel does not claim the browser stopped. */
export function attachBrowserControlDispatcher(options: BrowserControlDispatcherOptions): { close(): void } {
  const identity = validateBrowserControlIdentity(options.identity);
  let lastSeq = 0, busy = false, ready = false, closed = false;
  let active: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dispose = (): void => { clearTimeout(timer); timer = undefined; active?.abort(); active = undefined; };
  const authorized = (): boolean => {
    try { return !options.authoritySignal.aborted && options.isAuthorized() === true; } catch { return false; }
  };
  const transport = new BrowserControlTransport(options.transport, value => {
    if (closed) return;
    if (busy) { transport.close("executor_busy"); return; }
    let request: BrowserControlRequest;
    try { request = parseBrowserControlRequest(value); } catch { transport.close("invalid_request"); return; }
    if (!sameBrowserControlIdentity(identity, request.identity) || request.seq !== lastSeq + 1
      || (request.operation === "HELLO" ? ready || request.seq !== 1 : !ready)) { transport.close("protocol_mismatch"); return; }
    // Reserve before invoking any async work: coalesced frames cannot race this boundary.
    busy = true; lastSeq = request.seq; active = new AbortController();
    timer = setTimeout(() => transport.close("deadline_exceeded"), BROWSER_CONTROL_LIMITS.requestTimeoutMs);
    void dispatch(request, active.signal);
  }, () => {
    closed = true; dispose(); options.authoritySignal.removeEventListener("abort", revoke);
  });
  function revoke(): void { transport.close("session_revoked"); }
  async function dispatch(request: BrowserControlRequest, signal: AbortSignal): Promise<void> {
    const common = { version: BROWSER_CONTROL_VERSION as typeof BROWSER_CONTROL_VERSION, type: "reply" as const, identity, seq: request.seq,
      requestId: request.requestId, operation: request.operation,
      ...(request.operation === "EXECUTE" ? { actionId: request.actionId } : {}) };
    let invoked = false, reply: BrowserControlReply;
    try {
      if (!authorized() || signal.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
      if (request.operation === "HELLO") { ready = true; reply = { ...common, ok: true }; }
      else if (request.operation === "OBSERVE") {
        invoked = true;
        const observation = await options.executor.observe();
        if (closed || signal.aborted || !authorized()) { transport.close("session_revoked"); return; }
        reply = { ...common, ok: true, observation: encodeBrowserControlObservation(observation) };
      } else {
        if (request.action.kind === "speak" && options.executor.speechEnabled !== true) {
          throw new CuaExecutorError("action_rejected", "not_dispatched");
        }
        // No await between the owner gate above and invocation. The physical driver must
        // check this signal again immediately before each actual input after preparation.
        invoked = true;
        await options.executor.execute(request.action, signal);
        if (closed || signal.aborted || !authorized()) { transport.close("session_revoked"); return; }
        reply = { ...common, ok: true };
      }
    } catch (error) { reply = { ...common, ok: false, error: safeBrowserControlFailure(error, invoked) }; }
    if (closed) return;
    try {
      await transport.send(reply);
      if (!reply.ok && (request.operation !== "EXECUTE" || reply.error.code !== "action_rejected" || reply.error.disposition !== "not_dispatched")) {
        transport.close(reply.error.code); return;
      }
    } catch { transport.close("transport_failed"); }
    finally { dispose(); busy = false; }
  }
  options.authoritySignal.addEventListener("abort", revoke, { once: true });
  if (!authorized()) transport.close("session_revoked");
  return { close: () => transport.close() };
}
