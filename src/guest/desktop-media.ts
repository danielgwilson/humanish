import { spawn, type ChildProcess } from "node:child_process";
import type { CuaExecutor, CuaObservation } from "../actors/computer-use/loop.js";
import { CUA_SPEECH_LIMITS, type HeardSpeech } from "../actors/computer-use/speech.js";
import { ComputerUseExecutorError } from "../actors/computer-use/executor-error.js";

const WORKER_LINE_BYTES = 8_192;
const READY_TIMEOUT_MS = 35_000;
const SPEAK_TIMEOUT_MS = 30_000;
const HEARD_QUEUE = 8;
const HEARD_PER_OBSERVATION = CUA_SPEECH_LIMITS.utterances;

interface GuestDesktopMediaDeclaration {
  camera?: { source: string };
  microphone?: { source: string };
}

export interface DesktopMediaWorkerTransport {
  start(options: {
    env: Readonly<Record<string, string>>;
    data(bytes: Buffer): void;
    exit(): void;
  }): Promise<void>;
  write(bytes: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface GuestDesktopMediaOptions {
  media: GuestDesktopMediaDeclaration;
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  onTerminal(): void;
  transport?: DesktopMediaWorkerTransport;
  workerPath?: string;
}

export interface GuestDesktopMedia {
  readonly env: Readonly<Record<string, string>>;
  wrap(executor: CuaExecutor): CuaExecutor;
  close(): Promise<void>;
}

/** Speech text the worker may speak or report: non-blank, valid UTF-8, within the limits. */
export function isSpeakableText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= CUA_SPEECH_LIMITS.characters &&
    Buffer.byteLength(value) <= CUA_SPEECH_LIMITS.bytes &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

/** A heard utterance from the worker, or undefined when any field is out of contract. */
export function parseHeardSpeech(value: unknown): HeardSpeech | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<HeardSpeech>;
  if (
    typeof item.id !== "string" ||
    !/^[-A-Za-z0-9._]+$/.test(item.id) ||
    item.id.length > 128 ||
    item.source !== "speaker_audio" ||
    !isSpeakableText(item.text) ||
    !Number.isSafeInteger(item.durationMs) ||
    item.durationMs! < 1 ||
    item.durationMs! > CUA_SPEECH_LIMITS.durationMs
  )
    return undefined;
  return item as HeardSpeech;
}

class ChildMediaWorkerTransport implements DesktopMediaWorkerTransport {
  private child: ChildProcess | undefined;
  constructor(private readonly path: string) {}
  async start(options: {
    env: Readonly<Record<string, string>>;
    data(bytes: Buffer): void;
    exit(): void;
  }): Promise<void> {
    const child = spawn(process.execPath, [this.path], {
      env: options.env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.child = child;
    child.stdout!.on("data", options.data);
    child.once("error", options.exit);
    child.once("close", options.exit);
  }
  write(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.exitCode !== null || !child.stdin || child.stdin.destroyed) {
        reject(new Error("media worker closed"));
        return;
      }
      child.stdin.write(bytes, (error) => (error ? reject(error) : resolve()));
    });
  }
  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin?.end();
    });
  }
}

type MediaDeclaration = GuestDesktopMediaOptions["media"];

/** The guest has a synthetic camera and a speech microphone, and a declaration needs at least one. */
export function isSupportedMediaDeclaration(media: MediaDeclaration): boolean {
  return (
    (media.camera === undefined || media.camera.source === "synthetic") &&
    (media.microphone === undefined || media.microphone.source === "speech") &&
    (media.camera !== undefined || media.microphone !== undefined)
  );
}

/** The worker's env: device switches, plus Pulse routing when the microphone is on. */
export function desktopMediaEnv(
  env: Readonly<Record<string, string>>,
  media: MediaDeclaration,
): Readonly<Record<string, string>> {
  const pulse = media.microphone !== undefined;
  return {
    ...env,
    HUMANISH_MEDIA_CAMERA: media.camera === undefined ? "0" : "1",
    HUMANISH_MEDIA_MICROPHONE: pulse ? "1" : "0",
    ...(pulse
      ? {
          PULSE_SERVER: `unix:${env.XDG_RUNTIME_DIR ?? "/run/humanish/xdg"}/pulse/native`,
          PULSE_SOURCE: "humanish_input",
          PULSE_SINK: "humanish_speaker",
        }
      : {}),
  };
}

/** Checked before each line is taken: buffered bytes with no newline past the limit can't form a line. */
export function workerBufferOverflow(buffer: Buffer): boolean {
  return buffer.length > WORKER_LINE_BYTES && !buffer.includes(10);
}

/** The next newline-terminated line, or why there is none. A partial tail stays incomplete. */
export function nextWorkerLine(
  buffer: Buffer,
): { line: Buffer; rest: Buffer } | "incomplete" | "overflow" {
  const end = buffer.indexOf(10);
  if (end < 0) return "incomplete";
  if (end > WORKER_LINE_BYTES) return "overflow";
  return { line: buffer.subarray(0, end), rest: buffer.subarray(end + 1) };
}

export type WorkerMessage =
  | { kind: "ready" }
  | { kind: "heard"; utterance: HeardSpeech }
  | { kind: "reply"; id: string; ok: boolean }
  | { kind: "terminal" };

/** What one worker message means. Before the first `ready`, anything else breaks the protocol. */
export function classifyWorkerMessage(value: unknown, ready: boolean): WorkerMessage {
  if (!value || typeof value !== "object") return { kind: "terminal" };
  const item = value as { type?: unknown; id?: unknown; ok?: unknown; utterance?: unknown };
  if (item.type === "ready" && !ready) return { kind: "ready" };
  if (!ready) return { kind: "terminal" };
  if (item.type === "heard") {
    const utterance = parseHeardSpeech(item.utterance);
    return utterance ? { kind: "heard", utterance } : { kind: "terminal" };
  }
  if (item.type === "reply" && typeof item.id === "string" && typeof item.ok === "boolean")
    return { kind: "reply", id: item.id, ok: item.ok };
  return { kind: "terminal" };
}

/** Once a speak command is written, its outcome is unknown unless the worker replies. */
export function dispositionAfterWrite(written: boolean): "outcome_uncertain" | "not_dispatched" {
  return written ? "outcome_uncertain" : "not_dispatched";
}

/** A failed speak keeps its own executor error; anything else is an execution failure. */
export function speakFailure(error: unknown, written: boolean): ComputerUseExecutorError {
  return error instanceof ComputerUseExecutorError
    ? error
    : new ComputerUseExecutorError("execution_failed", dispositionAfterWrite(written));
}

interface PendingCommand {
  resolve(): void;
  reject(error: ComputerUseExecutorError): void;
  timer: NodeJS.Timeout;
}

/** What changes after setup: the read buffer, lifecycle flags, queued speech and commands in flight. */
interface MediaWorkerState {
  buffer: Buffer;
  ready: boolean;
  closed: boolean;
  expectedExit: boolean;
  wrapped: boolean;
  nextCommand: number;
  closing?: Promise<void>;
  readonly heard: HeardSpeech[];
  readonly pending: Map<string, PendingCommand>;
}

interface Readiness {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
}

/** What the speak path needs besides the state: the transport, the owner and the shared close. */
interface SpeechChannel {
  readonly pulse: boolean;
  readonly transport: DesktopMediaWorkerTransport;
  readonly ownerSignal: AbortSignal;
  close(): Promise<void>;
}

function rejectPending(state: MediaWorkerState, error: ComputerUseExecutorError): void {
  for (const command of state.pending.values()) {
    clearTimeout(command.timer);
    command.reject(error);
  }
  state.pending.clear();
}

/** The worker failed or broke protocol: fail readiness and commands in flight, then tell the owner once. */
function terminateMedia(
  state: MediaWorkerState,
  readiness: Readiness,
  onTerminal: () => void,
): void {
  if (state.closed || state.expectedExit) return;
  state.closed = true;
  const error = new ComputerUseExecutorError("execution_failed", "outcome_uncertain");
  readiness.reject(error);
  rejectPending(state, error);
  try {
    onTerminal();
  } catch {
    /* The media owner remains terminal. */
  }
}

function applyWorkerMessage(
  state: MediaWorkerState,
  value: unknown,
  readiness: Readiness,
  terminate: () => void,
): void {
  const message = classifyWorkerMessage(value, state.ready);
  switch (message.kind) {
    case "ready":
      state.ready = true;
      readiness.resolve();
      return;
    case "heard":
      if (state.heard.length === HEARD_QUEUE) {
        terminate();
        return;
      }
      state.heard.push(message.utterance);
      return;
    case "reply": {
      const command = state.pending.get(message.id);
      if (!command) {
        terminate();
        return;
      }
      state.pending.delete(message.id);
      clearTimeout(command.timer);
      if (message.ok) command.resolve();
      else command.reject(new ComputerUseExecutorError("execution_failed", "outcome_uncertain"));
      return;
    }
    case "terminal":
      terminate();
  }
}

/** Frames worker stdout into JSON lines. Runs synchronously for every chunk and stops at a terminal. */
function receiveWorkerBytes(
  state: MediaWorkerState,
  bytes: Buffer,
  onMessage: (value: unknown) => void,
  terminate: () => void,
): void {
  if (state.closed) return;
  state.buffer = Buffer.concat([state.buffer, bytes]);
  while (!state.closed) {
    if (workerBufferOverflow(state.buffer)) {
      terminate();
      return;
    }
    const next = nextWorkerLine(state.buffer);
    if (next === "incomplete") return;
    if (next === "overflow") {
      terminate();
      return;
    }
    state.buffer = next.rest;
    try {
      onMessage(JSON.parse(next.line.toString("utf8")));
    } catch {
      terminate();
      return;
    }
  }
}

/** Expected stop: commands in flight are revoked, no terminal is reported, the worker closes once. */
async function closeDesktopMedia(
  state: MediaWorkerState,
  transport: DesktopMediaWorkerTransport,
  detach: () => void,
): Promise<void> {
  if (state.closing) return state.closing;
  state.expectedExit = true;
  state.closed = true;
  detach();
  rejectPending(state, new ComputerUseExecutorError("session_revoked", "outcome_uncertain"));
  state.closing = Promise.resolve().then(() => transport.close());
  return state.closing;
}

async function awaitWorkerReady(
  readiness: Readiness,
  signal: AbortSignal,
  close: () => Promise<void>,
  readyTimer: NodeJS.Timeout,
): Promise<void> {
  const readinessAbort = (): void => {
    readiness.reject(new ComputerUseExecutorError("session_revoked", "not_dispatched"));
  };
  signal.addEventListener("abort", readinessAbort, { once: true });
  try {
    await readiness.promise;
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(readyTimer);
    signal.removeEventListener("abort", readinessAbort);
  }
}

/** Adds queued heard speech to each observation, at most HEARD_PER_OBSERVATION at a time. */
async function observeWithHeardSpeech(
  state: MediaWorkerState,
  executor: CuaExecutor,
): Promise<CuaObservation> {
  if (state.closed) throw new ComputerUseExecutorError("execution_failed", "not_dispatched");
  const observation = await executor.observe();
  if (state.closed) throw new ComputerUseExecutorError("execution_failed", "not_dispatched");
  const items = state.heard.splice(0, HEARD_PER_OBSERVATION);
  return items.length ? { ...observation, heardSpeech: items } : observation;
}

/** Passes every action but `speak` to the executor; `speak` goes to the worker and waits for its reply. */
async function executeWithSpeech(
  state: MediaWorkerState,
  executor: CuaExecutor,
  channel: SpeechChannel,
  action: Parameters<CuaExecutor["execute"]>[0],
  signal?: AbortSignal,
): Promise<void> {
  if (state.closed) throw new ComputerUseExecutorError("execution_failed", "not_dispatched");
  const candidate = action as { kind?: unknown; text?: unknown };
  if (candidate.kind !== "speak") return executor.execute(action, signal);
  if (
    !channel.pulse ||
    !isSpeakableText(candidate.text) ||
    state.closed ||
    channel.ownerSignal.aborted ||
    signal?.aborted
  ) {
    throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
  }
  const id = `speak-${state.nextCommand++}`;
  const combined = signal ? AbortSignal.any([channel.ownerSignal, signal]) : channel.ownerSignal;
  let written = false;
  const operation = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new ComputerUseExecutorError("deadline_exceeded", dispositionAfterWrite(written)));
      void channel.close().catch(() => {});
    }, SPEAK_TIMEOUT_MS);
    state.pending.set(id, { resolve, reject, timer });
  });
  void operation.catch(() => {});
  const cancelled = (): void => {
    const command = state.pending.get(id);
    if (!command) return;
    state.pending.delete(id);
    clearTimeout(command.timer);
    command.reject(new ComputerUseExecutorError("session_revoked", dispositionAfterWrite(written)));
    void channel.close().catch(() => {});
  };
  combined.addEventListener("abort", cancelled, { once: true });
  try {
    written = true;
    await channel.transport.write(
      Buffer.from(JSON.stringify({ id, operation: "speak", text: candidate.text }) + "\n"),
    );
    await operation;
  } catch (error) {
    if (written) await channel.close();
    throw speakFailure(error, written);
  } finally {
    combined.removeEventListener("abort", cancelled);
    const command = state.pending.get(id);
    if (command) {
      state.pending.delete(id);
      clearTimeout(command.timer);
    }
  }
}

function wrapMediaExecutor(
  state: MediaWorkerState,
  executor: CuaExecutor,
  channel: SpeechChannel,
): CuaExecutor {
  if (state.wrapped) throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  state.wrapped = true;
  const wrapped = {
    ...executor,
    speechEnabled: channel.pulse,
    observe: () => observeWithHeardSpeech(state, executor),
    execute: (action: Parameters<CuaExecutor["execute"]>[0], signal?: AbortSignal) =>
      executeWithSpeech(state, executor, channel, action, signal),
  };
  return wrapped;
}

/** Starts optional native guest media before Chromium and later decorates its finite executor. */
export async function startDesktopMedia(
  options: GuestDesktopMediaOptions,
): Promise<GuestDesktopMedia> {
  if (!isSupportedMediaDeclaration(options.media))
    throw new ComputerUseExecutorError("invalid_request", "not_dispatched");
  options.signal.throwIfAborted();
  const env = desktopMediaEnv(options.env, options.media);
  const transport =
    options.transport ??
    new ChildMediaWorkerTransport(
      options.workerPath ?? "/opt/humanish/media/guest-media-worker.js",
    );
  const state: MediaWorkerState = {
    buffer: Buffer.alloc(0),
    ready: false,
    closed: false,
    expectedExit: false,
    wrapped: false,
    nextCommand: 1,
    heard: [],
    pending: new Map(),
  };
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const readiness: Readiness = {
    promise: new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
    resolve: () => resolveReady(),
    reject: (error) => rejectReady(error),
  };
  void readiness.promise.catch(() => {});
  const terminate = (): void => terminateMedia(state, readiness, options.onTerminal);
  const onMessage = (value: unknown): void =>
    applyWorkerMessage(state, value, readiness, terminate);
  try {
    await transport.start({
      env,
      data: (bytes) => receiveWorkerBytes(state, bytes, onMessage, terminate),
      exit: terminate,
    });
    options.signal.throwIfAborted();
  } catch (error) {
    state.expectedExit = true;
    state.closed = true;
    await transport.close().catch(() => {});
    throw error;
  }
  const readyTimer = setTimeout(
    () => readiness.reject(new ComputerUseExecutorError("deadline_exceeded", "not_dispatched")),
    READY_TIMEOUT_MS,
  );
  const abort = (): void => {
    void close();
  };
  const close = (): Promise<void> =>
    closeDesktopMedia(state, transport, () => {
      clearTimeout(readyTimer);
      options.signal.removeEventListener("abort", abort);
    });
  options.signal.addEventListener("abort", abort, { once: true });
  await awaitWorkerReady(readiness, options.signal, close, readyTimer);
  const channel: SpeechChannel = {
    pulse: options.media.microphone !== undefined,
    transport,
    ownerSignal: options.signal,
    close,
  };
  return { env, close, wrap: (executor) => wrapMediaExecutor(state, executor, channel) };
}
