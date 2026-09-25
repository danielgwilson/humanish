import { spawn, type ChildProcess } from "node:child_process";
import { CUA_SPEECH_LIMITS, type CuaExecutor, type CuaObservation, type HeardSpeech } from "./computer-use.js";
import { CuaExecutorError } from "./cua-executor-error.js";

const WORKER_LINE_BYTES = 8_192;
const READY_TIMEOUT_MS = 35_000;
const SPEAK_TIMEOUT_MS = 30_000;
const HEARD_QUEUE = 8;
const HEARD_PER_OBSERVATION = CUA_SPEECH_LIMITS.utterances;

export interface GuestDesktopMediaDeclaration {
  camera?: { source: string };
  microphone?: { source: string };
}

export interface DesktopMediaWorkerTransport {
  start(options: { env: Readonly<Record<string, string>>; data(bytes: Buffer): void; exit(): void }): Promise<void>;
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

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= CUA_SPEECH_LIMITS.characters
    && Buffer.byteLength(value) <= CUA_SPEECH_LIMITS.bytes
    && Buffer.from(value, "utf8").toString("utf8") === value;
}

function heard(value: unknown): HeardSpeech | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<HeardSpeech>;
  if (typeof item.id !== "string" || !/^[-A-Za-z0-9._]+$/.test(item.id) || item.id.length > 128
    || item.source !== "speaker_audio" || !validText(item.text)
    || !Number.isSafeInteger(item.durationMs) || item.durationMs! < 1 || item.durationMs! > CUA_SPEECH_LIMITS.durationMs) return undefined;
  return item as HeardSpeech;
}

class ChildMediaWorkerTransport implements DesktopMediaWorkerTransport {
  private child: ChildProcess | undefined;
  constructor(private readonly path: string) {}
  async start(options: { env: Readonly<Record<string, string>>; data(bytes: Buffer): void; exit(): void }): Promise<void> {
    const child = spawn(process.execPath, [this.path], { env: options.env, stdio: ["pipe", "pipe", "ignore"] });
    this.child = child;
    child.stdout!.on("data", options.data);
    child.once("error", options.exit); child.once("close", options.exit);
  }
  write(bytes: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.exitCode !== null || !child.stdin || child.stdin.destroyed) { reject(new Error("media worker closed")); return; }
      child.stdin.write(bytes, error => error ? reject(error) : resolve());
    });
  }
  async close(): Promise<void> {
    const child = this.child; this.child = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); }, 2000);
      child.once("close", () => { clearTimeout(timer); resolve(); });
      child.stdin?.end();
    });
  }
}

/** Starts optional native guest media before Chromium and later decorates its finite executor. */
export async function startDesktopMedia(options: GuestDesktopMediaOptions): Promise<GuestDesktopMedia> {
  if (options.media.camera !== undefined && options.media.camera.source !== "synthetic") {
    throw new CuaExecutorError("invalid_request", "not_dispatched");
  }
  if (options.media.microphone !== undefined && options.media.microphone.source !== "speech") {
    throw new CuaExecutorError("invalid_request", "not_dispatched");
  }
  if (options.media.camera === undefined && options.media.microphone === undefined) {
    throw new CuaExecutorError("invalid_request", "not_dispatched");
  }
  options.signal.throwIfAborted();
  const pulse = options.media.microphone !== undefined;
  const pulseServer = `unix:${options.env.XDG_RUNTIME_DIR ?? "/run/humanish/xdg"}/pulse/native`;
  const env = { ...options.env,
    HUMANISH_MEDIA_CAMERA: options.media.camera === undefined ? "0" : "1",
    HUMANISH_MEDIA_MICROPHONE: pulse ? "1" : "0",
    ...(pulse ? { PULSE_SERVER: pulseServer, PULSE_SOURCE: "humanish_input", PULSE_SINK: "humanish_speaker" } : {}) };
  const transport = options.transport ?? new ChildMediaWorkerTransport(options.workerPath ?? "/opt/humanish/media/guest-media-worker.js");
  let buffer = Buffer.alloc(0), ready = false, closed = false, expectedExit = false, wrapped = false, nextCommand = 1;
  let resolveReady!: () => void, rejectReady!: (error: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const queue: HeardSpeech[] = [], pending = new Map<string, { resolve(): void; reject(error: CuaExecutorError): void; timer: NodeJS.Timeout }>();
  const terminal = (): void => {
    if (closed || expectedExit) return;
    closed = true;
    const error = new CuaExecutorError("execution_failed", "outcome_uncertain");
    rejectReady(error);
    for (const command of pending.values()) { clearTimeout(command.timer); command.reject(error); }
    pending.clear();
    try { options.onTerminal(); } catch { /* The media owner remains terminal. */ }
  };
  const message = (value: unknown): void => {
    if (!value || typeof value !== "object") { terminal(); return; }
    const item = value as { type?: unknown; id?: unknown; ok?: unknown; utterance?: unknown };
    if (item.type === "ready" && !ready) { ready = true; resolveReady(); return; }
    if (!ready) { terminal(); return; }
    if (item.type === "heard") {
      const utterance = heard(item.utterance); if (!utterance) { terminal(); return; }
      if (queue.length === HEARD_QUEUE) { terminal(); return; }
      queue.push(utterance); return;
    }
    if (item.type === "reply" && typeof item.id === "string" && typeof item.ok === "boolean") {
      const command = pending.get(item.id); if (!command) { terminal(); return; }
      pending.delete(item.id); clearTimeout(command.timer);
      if (item.ok) command.resolve(); else command.reject(new CuaExecutorError("execution_failed", "outcome_uncertain"));
      return;
    }
    terminal();
  };
  try {
    await transport.start({ env, data(bytes) {
      if (closed) return;
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > WORKER_LINE_BYTES && !buffer.includes(10)) { terminal(); return; }
      for (;;) {
        const end = buffer.indexOf(10); if (end < 0) break;
        if (end > WORKER_LINE_BYTES) { terminal(); return; }
        const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
        try { message(JSON.parse(line.toString("utf8"))); } catch { terminal(); return; }
      }
    }, exit: terminal });
    options.signal.throwIfAborted();
  } catch (error) {
    expectedExit = true; closed = true; await transport.close().catch(() => {}); throw error;
  }
  const readyTimer = setTimeout(() => rejectReady(new CuaExecutorError("deadline_exceeded", "not_dispatched")), READY_TIMEOUT_MS);
  const abort = (): void => { void close(); };
  options.signal.addEventListener("abort", abort, { once: true });
  const close = async (): Promise<void> => {
    if (expectedExit) return;
    expectedExit = true; closed = true; clearTimeout(readyTimer); options.signal.removeEventListener("abort", abort);
    const error = new CuaExecutorError("session_revoked", "outcome_uncertain");
    for (const command of pending.values()) { clearTimeout(command.timer); command.reject(error); }
    pending.clear(); await transport.close();
  };
  const readinessAbort = (): void => { rejectReady(new CuaExecutorError("session_revoked", "not_dispatched")); };
  options.signal.addEventListener("abort", readinessAbort, { once: true });
  try { await readiness; }
  catch (error) { await close(); throw error; }
  finally { clearTimeout(readyTimer); options.signal.removeEventListener("abort", readinessAbort); }
  return { env, close, wrap(executor) {
    if (wrapped) throw new CuaExecutorError("invalid_request", "not_dispatched"); wrapped = true;
    const result = {
      ...executor, speechEnabled: pulse,
      async observe(): Promise<CuaObservation> {
        if (closed) throw new CuaExecutorError("execution_failed", "not_dispatched");
        const observation = await executor.observe();
        if (closed) throw new CuaExecutorError("execution_failed", "not_dispatched");
        const items = queue.splice(0, HEARD_PER_OBSERVATION);
        return items.length ? { ...observation, heardSpeech: items } : observation;
      },
      async execute(action: Parameters<CuaExecutor["execute"]>[0], signal?: AbortSignal): Promise<void> {
        if (closed) throw new CuaExecutorError("execution_failed", "not_dispatched");
        const candidate = action as { kind?: unknown; text?: unknown };
        if (candidate.kind !== "speak") return executor.execute(action, signal);
        if (!pulse || !validText(candidate.text) || closed || options.signal.aborted || signal?.aborted) {
          throw new CuaExecutorError("action_rejected", "not_dispatched");
        }
        const id = `speak-${nextCommand++}`, controller = new AbortController();
        const combined = signal ? AbortSignal.any([options.signal, signal, controller.signal]) : AbortSignal.any([options.signal, controller.signal]);
        let written = false;
        const operation = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { controller.abort(); reject(new CuaExecutorError("deadline_exceeded", written ? "outcome_uncertain" : "not_dispatched")); }, SPEAK_TIMEOUT_MS);
          pending.set(id, { resolve, reject, timer });
        });
        const cancelled = (): void => { const command = pending.get(id); if (!command) return; pending.delete(id); clearTimeout(command.timer); command.reject(new CuaExecutorError("session_revoked", written ? "outcome_uncertain" : "not_dispatched")); };
        combined.addEventListener("abort", cancelled, { once: true });
        try {
          written = true;
          await transport.write(Buffer.from(JSON.stringify({ id, operation: "speak", text: candidate.text }) + "\n"));
          await operation;
        } catch (error) {
          if (written) await close();
          throw error instanceof CuaExecutorError ? error : new CuaExecutorError("execution_failed", written ? "outcome_uncertain" : "not_dispatched");
        } finally { combined.removeEventListener("abort", cancelled); const command = pending.get(id); if (command) { pending.delete(id); clearTimeout(command.timer); } }
      }
    };
    return result;
  } };
}
