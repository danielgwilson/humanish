import type { Duplex, Writable } from "node:stream";
import type { CuaAction, CuaExecutor, CuaObservation } from "../actors/computer-use/loop.js";
import {
  ComputerUseExecutorError,
  type CuaExecutorErrorCode,
} from "../actors/computer-use/executor-error.js";
import {
  BROWSER_CONTROL_LIMITS,
  BROWSER_CONTROL_VERSION,
  decodeBrowserControlObservation,
  parseBrowserControlReply,
  sameBrowserControlIdentity,
  validateBrowserControlAction,
  validateBrowserControlIdentity,
  type BrowserControlIdentity,
  type BrowserControlReply,
  type BrowserControlRequest,
} from "./protocol.js";
import { BrowserControlTransport } from "./transport.js";
import { receiveBrowserControlRecording } from "./recording-transfer.js";
import type { DesktopRecordingMetadata } from "../evidence/desktop-recording-types.js";

export interface BrowserControlClientOptions {
  transport: Duplex;
  identity: BrowserControlIdentity;
  requestTimeoutMs?: number;
  /** Set only after the optional media runtime was admitted for this desktop. */
  speechEnabled?: boolean;
}
export interface BrowserControlClient {
  executor: CuaExecutor;
  ready(): Promise<void>;
  finishRecording(destination: Writable): Promise<DesktopRecordingMetadata>;
  close(): void;
}

/** The request in flight: at most one per client. */
interface PendingExchange {
  request: BrowserControlRequest;
  written: boolean;
  writeComplete: boolean;
  reply?: BrowserControlReply;
  destination?: Writable;
  raw?: Promise<void>;
  resolve: (reply: BrowserControlReply) => void;
  reject: (error: ComputerUseExecutorError) => void;
  dispose: () => void;
}

/** One client's connection state, shared by the command functions below. */
interface ClientState {
  identity: BrowserControlIdentity;
  timeoutMs: number;
  speechEnabled: boolean;
  seq: number;
  busy: boolean;
  ready: boolean;
  closed: boolean;
  rawStream: Duplex | undefined;
  pending: PendingExchange | undefined;
}
interface ClientSession extends ClientState {
  transport: BrowserControlTransport;
}

export function createBrowserControlClient(
  options: BrowserControlClientOptions,
): BrowserControlClient {
  const identity = validateBrowserControlIdentity(options.identity);
  const timeoutMs = options.requestTimeoutMs ?? BROWSER_CONTROL_LIMITS.requestTimeoutMs;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > BROWSER_CONTROL_LIMITS.maxRequestTimeoutMs
  )
    throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  const state: ClientState = {
    identity,
    timeoutMs,
    speechEnabled: options.speechEnabled === true,
    seq: 0,
    busy: false,
    ready: false,
    closed: false,
    rawStream: undefined,
    pending: undefined,
  };
  // The transport closes synchronously when its stream is already unusable, so its close handler
  // takes the state that exists before the transport does.
  const session: ClientSession = Object.assign(state, {
    transport: new BrowserControlTransport(
      options.transport,
      (value) => acceptReply(session, value),
      (code) => closeClient(state, code),
    ),
  });
  const executor: CuaExecutor & { readonly stallRecovery: "fail_closed" } = {
    stallRecovery: "fail_closed",
    ...(options.speechEnabled === true ? { speechEnabled: true as const } : {}),
    observe: () => withOperation(session, () => observe(session)),
    execute: (action, signal) => withOperation(session, () => execute(session, action, signal)),
  };
  return {
    executor,
    ready: () => withOperation(session, () => hello(session)),
    finishRecording: (destination) =>
      withOperation(session, () => finishRecording(session, destination)),
    close: () => {
      session.rawStream?.destroy();
      session.transport.close();
    },
  };
}

function closeClient(state: ClientState, code: CuaExecutorErrorCode): void {
  state.closed = true;
  const operation = state.pending;
  state.pending = undefined;
  if (operation) {
    operation.dispose();
    operation.reject(
      new ComputerUseExecutorError(
        code,
        operation.written ? "outcome_uncertain" : "not_dispatched",
      ),
    );
  }
}

/** Settles the pending exchange once both its reply has arrived and its request write finished. */
function finishExchange(session: ClientSession): void {
  if (!session.pending?.reply || !session.pending.writeComplete) return;
  const operation = session.pending;
  session.pending = undefined;
  operation.dispose();
  if (operation.reply!.ok && operation.raw) {
    void operation.raw.then(() => operation.resolve(operation.reply!), operation.reject);
  } else if (operation.reply!.ok) operation.resolve(operation.reply!);
  else {
    const { code, disposition, reason } = operation.reply!.error;
    if (
      operation.request.operation !== "EXECUTE" ||
      code !== "action_rejected" ||
      disposition !== "not_dispatched"
    )
      session.transport.close(code);
    operation.reject(new ComputerUseExecutorError(code, disposition, reason));
  }
}

/** Matches a reply frame to the pending request; any mismatch closes the channel. */
function acceptReply(session: ClientSession, value: unknown): void {
  const { transport } = session;
  if (!session.pending || session.pending.reply) {
    transport.close("invalid_response");
    return;
  }
  let reply: BrowserControlReply;
  try {
    reply = parseBrowserControlReply(value);
  } catch {
    transport.close("invalid_response");
    return;
  }
  const request = session.pending.request;
  if (
    !sameBrowserControlIdentity(session.identity, reply.identity) ||
    request.seq !== reply.seq ||
    request.requestId !== reply.requestId ||
    request.operation !== reply.operation ||
    (request.operation === "EXECUTE"
      ? request.actionId !== reply.actionId
      : reply.actionId !== undefined)
  ) {
    transport.close("protocol_mismatch");
    return;
  }
  if (request.operation === "FINISH_RECORDING" && reply.ok) {
    if (!reply.recording || !session.pending.destination) {
      transport.close("invalid_response");
      return;
    }
    try {
      session.rawStream = transport.handoff();
      session.closed = true;
      session.pending.raw = receiveBrowserControlRecording(
        session.rawStream,
        session.pending.destination,
        reply.recording.bytes,
      );
      void session.pending.raw.catch(() => {});
    } catch {
      transport.close("transport_failed");
      return;
    }
  }
  session.pending.reply = reply;
  finishExchange(session);
}

/** Sends one request and resolves with its matched reply. */
function exchange(
  session: ClientSession,
  operation: "HELLO" | "OBSERVE" | "EXECUTE" | "FINISH_RECORDING",
  action?: CuaAction,
  signal?: AbortSignal,
  destination?: Writable,
): Promise<BrowserControlReply> {
  const { transport } = session;
  if (session.closed)
    return Promise.reject(new ComputerUseExecutorError("executor_closed", "not_dispatched"));
  if (signal?.aborted)
    return Promise.reject(new ComputerUseExecutorError("cancelled", "not_dispatched"));
  if (session.seq >= Number.MAX_SAFE_INTEGER) {
    transport.close("protocol_mismatch");
    return Promise.reject(new ComputerUseExecutorError("protocol_mismatch", "not_dispatched"));
  }
  session.seq += 1;
  const seq = session.seq;
  const base = {
    version: BROWSER_CONTROL_VERSION as typeof BROWSER_CONTROL_VERSION,
    type: "request" as const,
    identity: session.identity,
    seq,
    requestId: `request-${seq}`,
  };
  const request: BrowserControlRequest =
    operation === "EXECUTE"
      ? { ...base, operation, actionId: `action-${seq}`, action: action! }
      : { ...base, operation };
  return new Promise((resolve, reject) => {
    const abort = (): void => transport.close("cancelled");
    const timer = setTimeout(() => transport.close("deadline_exceeded"), session.timeoutMs);
    const slot: PendingExchange = {
      request,
      written: false,
      writeComplete: false,
      resolve,
      reject,
      ...(destination ? { destination } : {}),
      dispose: () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      },
    };
    session.pending = slot;
    signal?.addEventListener("abort", abort, { once: true });
    void transport
      .send(request, () => {
        slot.written = true;
      })
      .then(
        () => {
          if (session.pending !== slot) return;
          slot.writeComplete = true;
          finishExchange(session);
        },
        () => {
          if (session.pending === slot) transport.close("transport_failed");
        },
      );
  });
}

/** Runs one public operation at a time on an open client. */
async function withOperation<T>(session: ClientSession, work: () => Promise<T>): Promise<T> {
  if (session.closed) throw new ComputerUseExecutorError("executor_closed", "not_dispatched");
  if (session.busy) throw new ComputerUseExecutorError("executor_busy", "not_dispatched");
  session.busy = true;
  try {
    return await work();
  } finally {
    session.busy = false;
  }
}

/** The handshake, sent once before the first other command. */
async function hello(session: ClientSession, signal?: AbortSignal): Promise<void> {
  if (session.ready) return;
  await exchange(session, "HELLO", undefined, signal);
  session.ready = true;
}

async function observe(session: ClientSession): Promise<CuaObservation> {
  await hello(session);
  const reply = await exchange(session, "OBSERVE");
  try {
    if (!reply.ok || !reply.observation) throw new Error();
    return decodeBrowserControlObservation(reply.observation);
  } catch {
    session.transport.close("invalid_response");
    throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
  }
}

async function execute(
  session: ClientSession,
  action: CuaAction,
  signal: AbortSignal | undefined,
): Promise<void> {
  const validAction = validateBrowserControlAction(action);
  if (validAction.kind === "speak" && !session.speechEnabled) {
    throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
  }
  if (signal?.aborted) throw new ComputerUseExecutorError("cancelled", "not_dispatched");
  try {
    await hello(session, signal);
  } catch (error) {
    if (error instanceof ComputerUseExecutorError)
      throw new ComputerUseExecutorError(error.code, "not_dispatched");
    throw error;
  }
  await exchange(session, "EXECUTE", validAction, signal);
}

async function finishRecording(
  session: ClientSession,
  destination: Writable,
): Promise<DesktopRecordingMetadata> {
  if (!destination || destination.destroyed)
    throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  try {
    await hello(session);
    const reply = await exchange(session, "FINISH_RECORDING", undefined, undefined, destination);
    if (!reply.ok || !reply.recording)
      throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
    return reply.recording;
  } catch (error) {
    destination.destroy();
    throw error;
  }
}
