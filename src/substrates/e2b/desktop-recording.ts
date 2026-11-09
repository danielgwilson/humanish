import { Readable, type Writable } from "node:stream";
import {
  buildDesktopRecorderPulseSetupCommands,
  buildFragmentedRecorderCommand,
  FRAGMENTED_RECORDING,
} from "../../evidence/desktop-recorder.js";
import {
  createRecordingSpool,
  type RecordingPieces,
  type RecordingSpool,
} from "../../evidence/desktop-recording-spool.js";
import {
  HOSTED_DESKTOP_RECORDING_MAX_BYTES,
  type DesktopRecordingAudioSource,
  type DesktopRecordingMetadata,
} from "../../evidence/desktop-recording-types.js";
import { runOrThrow, shellQuote, type Shell } from "../shell.js";
import type { E2BCommandResult, E2BDesktopSandbox } from "./sdk.js";
import { e2bShell } from "./shell.js";

const OUTPUT_DIRECTORY = "/tmp/humanish-desktop-recording";
const PID_PATH = "/tmp/humanish-desktop-recording.pid";
const PULSE_RUNTIME = "/tmp/humanish-recording-runtime";
const FINALIZE_TIMEOUT_MS = 10_000;
/** Shorter than a segment, so a lost sandbox costs about one segment of video. */
const PULL_INTERVAL_MS = 10_000;
const FORCE_REAP_TIMEOUT_MS = 5_000;

const baseEnv = Object.freeze({
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/user",
  USER: "user",
  LOGNAME: "user",
  LANG: "C.UTF-8",
  DISPLAY: ":0",
});

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const commandLine = (command: { binary: string; args: readonly string[] }): string =>
  `${shellQuote(command.binary)} ${command.args.map(shellQuote).join(" ")}`;

async function stopPulse(
  shell: Shell,
  env: Readonly<Record<string, string>>,
  requestTimeoutMs: number,
): Promise<void> {
  await shell.run("pulseaudio --kill", { env, timeoutMs: 5_000, requestTimeoutMs }).catch(() => {});
}

async function preparePulse(
  shell: Shell,
  requestTimeoutMs: number,
): Promise<Readonly<Record<string, string>>> {
  const env = {
    ...baseEnv,
    XDG_RUNTIME_DIR: PULSE_RUNTIME,
    PULSE_SERVER: `unix:${PULSE_RUNTIME}/pulse/native`,
    PULSE_SOURCE: "humanish_input",
    PULSE_SINK: "humanish_speaker",
  };
  try {
    await runOrThrow(
      shell,
      "install -d -m 0700 /tmp/humanish-recording-runtime && " +
        "pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr && " +
        "pactl load-module module-null-sink sink_name=humanish_mic sink_properties=device.description=HumanishSyntheticMicrophone >/dev/null && " +
        "pactl load-module module-remap-source master=humanish_mic.monitor source_name=humanish_input source_properties=device.description=HumanishSyntheticMicrophone >/dev/null && " +
        "pactl load-module module-null-sink sink_name=humanish_speaker sink_properties=device.description=HumanishSyntheticSpeaker >/dev/null && " +
        "pactl set-default-source humanish_input && pactl set-default-sink humanish_speaker",
      {
        env,
        timeoutMs: 30_000,
        requestTimeoutMs,
      },
    );
    return env;
  } catch (error) {
    await stopPulse(shell, env, requestTimeoutMs);
    throw error;
  }
}

async function runRecorderPulseSetup(
  shell: Shell,
  env: Readonly<Record<string, string>>,
  requestTimeoutMs: number,
): Promise<void> {
  for (const setup of buildDesktopRecorderPulseSetupCommands()) {
    await runOrThrow(shell, commandLine(setup), { env, timeoutMs: 5_000, requestTimeoutMs });
  }
}

interface RecordingOptions {
  desktop: E2BDesktopSandbox;
  width: number;
  height: number;
  audio: boolean;
  pulseEnv?: Readonly<Record<string, string>>;
  requestTimeoutMs: number;
  maxBytes?: number;
}

async function launchRecorder(
  options: RecordingOptions,
  env: Readonly<Record<string, string>>,
  audioSources: DesktopRecordingAudioSource[],
): Promise<{ handle: E2BCommandResult; startedAt: string }> {
  const startedAtMs = Date.now();
  const command = buildFragmentedRecorderCommand(
    {
      display: ":0",
      width: options.width,
      height: options.height,
      directory: OUTPUT_DIRECTORY,
      audioSources,
    },
    startedAtMs,
  );
  const launch =
    `set -eu; rm -f ${shellQuote(PID_PATH)}; rm -rf ${shellQuote(OUTPUT_DIRECTORY)}; install -d -m 0700 ${shellQuote(OUTPUT_DIRECTORY)}; /usr/bin/env --default-signal=INT,TERM ${commandLine(command)} & ` +
    `child=$!; printf '%s\\n' "$child" > ${shellQuote(PID_PATH)}; wait "$child"`;
  // The host launch boundary is the only clock shared with later run events. Capture it before
  // the provider RPC so startup transport latency is not silently removed from the timeline.
  const startedAt = new Date(startedAtMs).toISOString();
  // A background run returns the process handle finish() needs, so it bypasses the Shell.
  const handle = await options.desktop.commands.run(launch, {
    background: true,
    envs: { ...baseEnv, ...env },
    timeoutMs: 0,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  return { handle, startedAt };
}

/** The launched recorder: its exit, and whether that exit came before finish asked for it. */
interface RecorderProcess {
  readonly exited: Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
  exitedEarly(): boolean;
  markStopping(): void;
}

function watchRecorder(
  wait: () => Promise<E2BCommandResult>,
  kill: () => Promise<boolean>,
): RecorderProcess {
  let stopping = false,
    exitedEarly = false;
  const exited = wait().then(
    (result) => {
      if (!stopping) exitedEarly = true;
      return result;
    },
    (error) => {
      if (!stopping) exitedEarly = true;
      return error as E2BCommandResult;
    },
  );
  void exited.catch(() => {});
  return {
    exited,
    kill,
    exitedEarly: () => exitedEarly,
    markStopping: () => {
      stopping = true;
    },
  };
}

async function readRecorderPid(shell: Shell, requestTimeoutMs: number): Promise<number> {
  const pidResult = await runOrThrow(shell, `cat ${shellQuote(PID_PATH)}`, {
    timeoutMs: 5_000,
    requestTimeoutMs,
  });
  const recorderPid = Number(pidResult.stdout.trim());
  if (!Number.isSafeInteger(recorderPid) || recorderPid < 1)
    throw new Error("E2B desktop recorder did not report its owned process ID.");
  return recorderPid;
}

/** Interrupt the recorder so FFmpeg finalizes the file; kill it if it does not exit in time. */
async function stopRecorder(
  shell: Shell,
  recorder: RecorderProcess,
  recorderPid: number,
  requestTimeoutMs: number,
): Promise<{ forced: boolean }> {
  recorder.markStopping();
  if (!recorder.exitedEarly()) {
    await runOrThrow(shell, `kill -INT -- ${recorderPid}`, {
      timeoutMs: 5_000,
      requestTimeoutMs,
    });
  }
  let forced = false;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    recorder.exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        forced = true;
        resolve();
      }, FINALIZE_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (forced) {
    await recorder.kill().catch(() => {});
    if (!(await settlesWithin(recorder.exited, FORCE_REAP_TIMEOUT_MS)))
      throw new Error("E2B recorder process did not stop.");
  }
  return { forced };
}

/** Rejects when a sandbox call outlives its deadline: some providers ignore their own timeouts. */
async function withinDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Sandbox call timed out.")), deadlineMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Reads one piece of the recording into memory; a piece is one short segment of video. */
async function readPiece(
  desktop: E2BDesktopSandbox,
  name: string,
  maxBytes: number,
  requestTimeoutMs: number,
): Promise<Buffer> {
  const web = await desktop.files.read!(`${OUTPUT_DIRECTORY}/${name}`, {
    format: "stream",
    requestTimeoutMs,
    streamIdleTimeoutMs: requestTimeoutMs,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of Readable.fromWeb(web)) {
    const piece = Buffer.from(chunk as Uint8Array);
    bytes += piece.length;
    if (bytes > maxBytes) throw new Error("Recording segment exceeds the size limit.");
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

function sandboxPieces(
  desktop: E2BDesktopSandbox,
  shell: Shell,
  maxBytes: number,
  requestTimeoutMs: number,
): RecordingPieces {
  const options = { timeoutMs: 15_000, requestTimeoutMs };
  return {
    playlist: async () =>
      (
        await withinDeadline(
          runOrThrow(
            shell,
            `cat ${shellQuote(`${OUTPUT_DIRECTORY}/${FRAGMENTED_RECORDING.playlist}`)}`,
            options,
          ),
          requestTimeoutMs,
        )
      ).stdout,
    read: (name) =>
      withinDeadline(readPiece(desktop, name, maxBytes, requestTimeoutMs), requestTimeoutMs),
    remove: async (names) => {
      await withinDeadline(
        runOrThrow(
          shell,
          `rm -f -- ${names.map((name) => shellQuote(`${OUTPUT_DIRECTORY}/${name}`)).join(" ")}`,
          options,
        ),
        requestTimeoutMs,
      );
    },
  };
}

/** Copies finished segments off the sandbox on a timer, and stops the recorder at the size limit. */
function startPulling(
  spool: RecordingSpool,
  stopForSize: () => Promise<unknown>,
): { stop(): void; pull(): Promise<void> } {
  let stopped = false;
  const pull = async (): Promise<void> => {
    const { full } = await spool.pull();
    if (full && !stopped) {
      await stopForSize().then(
        () => {
          stopped = true;
        },
        () => {},
      );
    }
  };
  // A sandbox slower than the timer would otherwise queue pulls that finish must then drain.
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    await pull().finally(() => {
      running = false;
    });
  };
  const timer = setInterval(() => void tick(), PULL_INTERVAL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer), pull };
}

export interface E2BDesktopRecording {
  readonly env: Readonly<Record<string, string>>;
  finish(destination: Writable): Promise<DesktopRecordingMetadata>;
}

/** Starts the shared FFmpeg recipe through E2B's command transport; retrieval remains host-owned. */
export async function startE2BDesktopRecording(
  options: RecordingOptions,
): Promise<E2BDesktopRecording> {
  if (!options.desktop.files.read)
    throw new Error("Installed @e2b/desktop does not support streamed recording retrieval.");
  const audioSources: DesktopRecordingAudioSource[] = options.audio
    ? ["microphone-input", "speaker-output"]
    : [];
  const requestTimeoutMs = options.requestTimeoutMs;
  const maxBytes = options.maxBytes ?? HOSTED_DESKTOP_RECORDING_MAX_BYTES;
  // Recorder setup and finalization fail on any non-zero exit; runOrThrow says so with the tail.
  const shell = e2bShell(options.desktop);
  const ownsPulse = options.audio && options.pulseEnv === undefined;
  const env = options.audio
    ? (options.pulseEnv ?? (await preparePulse(shell, requestTimeoutMs)))
    : baseEnv;
  const stopOwnedPulse = async (): Promise<void> => {
    if (ownsPulse) await stopPulse(shell, env, requestTimeoutMs);
  };
  const failStartup = async (error: unknown, recorder?: RecorderProcess): Promise<never> => {
    await recorder?.kill().catch(() => {});
    await stopOwnedPulse();
    throw error;
  };
  if (options.audio)
    await runRecorderPulseSetup(shell, env, requestTimeoutMs).catch((error: unknown) =>
      failStartup(error),
    );
  const { handle, startedAt } = await launchRecorder(options, env, audioSources).catch(
    (error: unknown) => failStartup(error),
  );
  if (!handle.wait || !handle.kill || !Number.isSafeInteger(handle.pid) || handle.pid! < 1) {
    await handle.kill?.().catch(() => {});
    await stopOwnedPulse();
    throw new Error("Installed @e2b/desktop does not expose an owned recording process handle.");
  }
  const recorder = watchRecorder(handle.wait.bind(handle), handle.kill.bind(handle));
  await options.desktop.wait(150);
  if (recorder.exitedEarly())
    await failStartup(new Error("E2B desktop recorder exited during startup."));
  const recorderPid = await readRecorderPid(shell, requestTimeoutMs).catch((error: unknown) =>
    failStartup(error, recorder),
  );
  const spool = await createRecordingSpool({
    pieces: sandboxPieces(options.desktop, shell, maxBytes, requestTimeoutMs),
    maxBytes,
  }).catch((error: unknown) => failStartup(error, recorder));
  const pulling = startPulling(spool, () =>
    runOrThrow(shell, `kill -INT -- ${recorderPid}`, { timeoutMs: 5_000, requestTimeoutMs }),
  );
  let finishing: Promise<DesktopRecordingMetadata> | undefined;
  return {
    env,
    finish: (destination) =>
      (finishing ??= (async () => {
        pulling.stop();
        try {
          // A sandbox that is already gone cannot stop or list anything, and what was copied
          // before it went is still the participant's video.
          const stopped = await stopRecorder(shell, recorder, recorderPid, requestTimeoutMs).catch(
            () => ({ forced: true }),
          );
          await pulling.pull();
          const { bytes, durationMs, ended } = await spool.finish(destination);
          return {
            mimeType: "video/mp4" as const,
            startedAt,
            durationMs,
            bytes,
            audioSources,
            complete: ended && !recorder.exitedEarly() && !stopped.forced,
          };
        } catch {
          throw new Error("E2B desktop recording failed.");
        } finally {
          await stopOwnedPulse();
        }
      })()),
  };
}
