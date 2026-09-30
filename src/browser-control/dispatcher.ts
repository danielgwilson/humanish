import type { Duplex, Readable } from "node:stream";
import type { CuaExecutor } from "../actors/computer-use/loop.js";
import { CuaExecutorError } from "../actors/computer-use/executor-error.js";
import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_VERSION,
  encodeBrowserControlObservation,
  parseBrowserControlRequest,
  safeBrowserControlFailure,
  sameBrowserControlIdentity,
  validateBrowserControlIdentity,
  type BrowserControlIdentity,
  type BrowserControlReply,
  type BrowserControlRequest,
} from "./protocol.js";
import { BrowserControlTransport } from "./transport.js";
import { sendBrowserControlRecording } from "./recording-transfer.js";
import {
  desktopRecordingMetadataSchema,
  type DesktopRecordingMetadata,
} from "../evidence/desktop-recording-types.js";

export interface BrowserControlDispatcherOptions {
  transport: Duplex;
  identity: BrowserControlIdentity;
  executor: CuaExecutor;
  isAuthorized: () => boolean;
  authoritySignal: AbortSignal;
  finishRecording?: () => Promise<{ metadata: DesktopRecordingMetadata; stream: Readable }>;
}
/** One dispatcher's channel state, shared by the command functions below. */
interface DispatcherState {
  options: BrowserControlDispatcherOptions;
  identity: BrowserControlIdentity;
  /** Registered on the authority signal; the same function is removed on close. */
  revoke: () => void;
  lastSeq: number;
  busy: boolean;
  ready: boolean;
  closed: boolean;
  rawStream: Duplex | undefined;
  active: AbortController | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}
interface DispatcherSession extends DispatcherState {
  transport: BrowserControlTransport;
}

/** Caller retains physical runtime ownership. Closing this channel does not claim the browser stopped. */
export function attachBrowserControlDispatcher(options: BrowserControlDispatcherOptions): {
  close(): void;
} {
  const state: DispatcherState = {
    options,
    identity: validateBrowserControlIdentity(options.identity),
    revoke: () => session.transport.close("session_revoked"),
    lastSeq: 0,
    busy: false,
    ready: false,
    closed: false,
    rawStream: undefined,
    active: undefined,
    timer: undefined,
  };
  // The transport closes synchronously when its stream is already unusable, so its close handler
  // takes the state that exists before the transport does.
  const session: DispatcherSession = Object.assign(state, {
    transport: new BrowserControlTransport(
      options.transport,
      (value) => acceptRequest(session, value),
      () => {
        state.closed = true;
        disposeRequest(state);
        options.authoritySignal.removeEventListener("abort", state.revoke);
      },
    ),
  });
  options.authoritySignal.addEventListener("abort", state.revoke, { once: true });
  if (!authorized(options)) session.transport.close("session_revoked");
  return {
    close: () => {
      session.rawStream?.destroy();
      session.transport.close();
    },
  };
}

function disposeRequest(state: DispatcherState): void {
  clearTimeout(state.timer);
  state.timer = undefined;
  state.active?.abort();
  state.active = undefined;
}

function authorized(options: BrowserControlDispatcherOptions): boolean {
  try {
    return !options.authoritySignal.aborted && options.isAuthorized() === true;
  } catch {
    return false;
  }
}

/** Admits the next in-sequence request frame and starts it; anything else closes the channel. */
function acceptRequest(session: DispatcherSession, value: unknown): void {
  const { transport } = session;
  if (session.closed) return;
  if (session.busy) {
    transport.close("executor_busy");
    return;
  }
  let request: BrowserControlRequest;
  try {
    request = parseBrowserControlRequest(value);
  } catch {
    transport.close("invalid_request");
    return;
  }
  if (
    !sameBrowserControlIdentity(session.identity, request.identity) ||
    request.seq !== session.lastSeq + 1 ||
    (request.operation === "HELLO" ? session.ready || request.seq !== 1 : !session.ready)
  ) {
    transport.close("protocol_mismatch");
    return;
  }
  // Reserve before invoking any async work: coalesced frames cannot race this boundary.
  session.busy = true;
  session.lastSeq = request.seq;
  session.active = new AbortController();
  session.timer = setTimeout(
    () => transport.close("deadline_exceeded"),
    BROWSER_CONTROL_LIMITS.requestTimeoutMs,
  );
  void dispatch(session, request, session.active.signal);
}

function replyCommon(identity: BrowserControlIdentity, request: BrowserControlRequest) {
  return {
    version: BROWSER_CONTROL_VERSION as typeof BROWSER_CONTROL_VERSION,
    type: "reply" as const,
    identity,
    seq: request.seq,
    requestId: request.requestId,
    operation: request.operation,
    ...(request.operation === "EXECUTE" ? { actionId: request.actionId } : {}),
  };
}
type ReplyCommon = ReturnType<typeof replyCommon>;
type ExecuteRequest = Extract<BrowserControlRequest, { operation: "EXECUTE" }>;

/** The failure reply; `invoked` says whether the executor already held the request. */
function failure(common: ReplyCommon, error: unknown, invoked: boolean): BrowserControlReply {
  return { ...common, ok: false, error: safeBrowserControlFailure(error, invoked) };
}

/**
 * Runs one admitted request. Each command sends its own reply through sendReply, which reaches
 * transport.send in the same turn as the command's last await, and sends nothing when the command
 * closed the channel or handed it off.
 */
async function dispatch(
  session: DispatcherSession,
  request: BrowserControlRequest,
  signal: AbortSignal,
): Promise<void> {
  const common = replyCommon(session.identity, request);
  if (!authorized(session.options) || signal.aborted) {
    const refusal = new CuaExecutorError("session_revoked", "not_dispatched");
    await sendReply(session, request, failure(common, refusal, false));
    return;
  }
  if (request.operation === "HELLO") await hello(session, request, common);
  else if (request.operation === "OBSERVE") await observe(session, request, common, signal);
  else if (request.operation === "EXECUTE") await execute(session, request, common, signal);
  else await finishRecording(session, request, common, signal);
}

async function sendReply(
  session: DispatcherSession,
  request: BrowserControlRequest,
  reply: BrowserControlReply,
): Promise<void> {
  if (session.closed) return;
  try {
    await session.transport.send(reply);
    if (
      !reply.ok &&
      (request.operation !== "EXECUTE" ||
        reply.error.code !== "action_rejected" ||
        reply.error.disposition !== "not_dispatched")
    ) {
      session.transport.close(reply.error.code);
      return;
    }
  } catch {
    session.transport.close("transport_failed");
  } finally {
    disposeRequest(session);
    session.busy = false;
  }
}

async function hello(
  session: DispatcherSession,
  request: BrowserControlRequest,
  common: ReplyCommon,
): Promise<void> {
  session.ready = true;
  await sendReply(session, request, { ...common, ok: true });
}

async function observe(
  session: DispatcherSession,
  request: BrowserControlRequest,
  common: ReplyCommon,
  signal: AbortSignal,
): Promise<void> {
  let reply: BrowserControlReply;
  try {
    const observation = await session.options.executor.observe();
    if (session.closed || signal.aborted || !authorized(session.options)) {
      session.transport.close("session_revoked");
      return;
    }
    reply = { ...common, ok: true, observation: encodeBrowserControlObservation(observation) };
  } catch (error) {
    reply = failure(common, error, true);
  }
  await sendReply(session, request, reply);
}

async function execute(
  session: DispatcherSession,
  request: ExecuteRequest,
  common: ReplyCommon,
  signal: AbortSignal,
): Promise<void> {
  let invoked = false,
    reply: BrowserControlReply;
  try {
    if (request.action.kind === "speak" && session.options.executor.speechEnabled !== true) {
      throw new CuaExecutorError("action_rejected", "not_dispatched");
    }
    // No await between the owner gate in dispatch and invocation. The physical driver must
    // check this signal again immediately before each actual input after preparation.
    invoked = true;
    await session.options.executor.execute(request.action, signal);
    if (session.closed || signal.aborted || !authorized(session.options)) {
      session.transport.close("session_revoked");
      return;
    }
    reply = { ...common, ok: true };
  } catch (error) {
    reply = failure(common, error, invoked);
  }
  await sendReply(session, request, reply);
}

/** Sends the recording's metadata, then hands the channel to the raw recording transfer. */
async function finishRecording(
  session: DispatcherSession,
  request: BrowserControlRequest,
  common: ReplyCommon,
  signal: AbortSignal,
): Promise<void> {
  const { options, transport } = session;
  let reply: BrowserControlReply;
  try {
    if (!options.finishRecording) throw new CuaExecutorError("action_rejected", "not_dispatched");
    const recording = await options.finishRecording();
    let metadata: DesktopRecordingMetadata;
    try {
      metadata = desktopRecordingMetadataSchema.parse(recording.metadata);
    } catch (error) {
      recording.stream.destroy();
      throw error;
    }
    if (session.closed || signal.aborted || !authorized(options)) {
      recording.stream.destroy();
      transport.close("session_revoked");
      return;
    }
    reply = { ...common, ok: true, recording: metadata };
    let rawStream: Duplex;
    try {
      await transport.send(reply);
      rawStream = session.rawStream = transport.handoff();
    } catch (error) {
      recording.stream.destroy();
      throw error;
    }
    session.closed = true;
    disposeRequest(session);
    options.authoritySignal.removeEventListener("abort", session.revoke);
    await sendBrowserControlRecording(recording.stream, rawStream, metadata.bytes).catch(() => {});
    return;
  } catch (error) {
    reply = failure(common, error, true);
  }
  await sendReply(session, request, reply);
}
