import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildDesktopRecorderCommand,
  buildDesktopRecorderPulseSetupCommands,
  buildDesktopRecorderProbeCommand,
  parseDesktopRecorderDuration,
} from "../../evidence/desktop-recorder.js";
import {
  DESKTOP_RECORDING_MAX_BYTES,
  type DesktopRecordingAudioSource,
  type DesktopRecordingMetadata,
} from "../../evidence/desktop-recording-types.js";
import { runOrThrow, shellQuote, type Shell } from "../shell.js";
import type { E2BCommandResult, E2BDesktopSandbox } from "./sdk.js";
import { e2bShell } from "./shell.js";

const OUTPUT_PATH = "/tmp/humanish-desktop-recording.mp4";
const PID_PATH = "/tmp/humanish-desktop-recording.pid";
const PULSE_RUNTIME = "/tmp/humanish-recording-runtime";
const FINALIZE_TIMEOUT_MS = 10_000;
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
}

async function launchRecorder(
  options: RecordingOptions,
  env: Readonly<Record<string, string>>,
  audioSources: DesktopRecordingAudioSource[],
): Promise<{ handle: E2BCommandResult; startedAt: string }> {
  const startedAtMs = Date.now();
  const command = buildDesktopRecorderCommand(
    {
      display: ":0",
      width: options.width,
      height: options.height,
      outputPath: OUTPUT_PATH,
      audioSources,
    },
    startedAtMs,
  );
  const launch =
    `set -eu; rm -f ${shellQuote(PID_PATH)}; /usr/bin/env --default-signal=INT,TERM ${commandLine(command)} & ` +
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

async function probeDuration(shell: Shell, requestTimeoutMs: number): Promise<number> {
  const probe = await runOrThrow(
    shell,
    commandLine(buildDesktopRecorderProbeCommand(OUTPUT_PATH)),
    {
      timeoutMs: 30_000,
      requestTimeoutMs,
    },
  );
  return parseDesktopRecorderDuration(probe.stdout);
}

/** Stream the finished file to the destination under the size limit; returns the byte count. */
async function transferRecording(
  desktop: E2BDesktopSandbox,
  destination: Writable,
  requestTimeoutMs: number,
): Promise<number> {
  const transferSignal = AbortSignal.timeout(requestTimeoutMs);
  const web = await desktop.files.read!(OUTPUT_PATH, {
    format: "stream",
    requestTimeoutMs,
    streamIdleTimeoutMs: requestTimeoutMs,
    signal: transferSignal,
  });
  let transferred = 0;
  const count = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (transferred + chunk.length > DESKTOP_RECORDING_MAX_BYTES) {
        callback(new Error("E2B recording exceeds the size limit."));
        return;
      }
      transferred += chunk.length;
      callback(undefined, chunk);
    },
  });
  await pipeline(Readable.fromWeb(web), count, destination, { signal: transferSignal });
  if (transferred < 1) throw new Error("E2B desktop recorder produced empty output.");
  return transferred;
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
  let finishing: Promise<DesktopRecordingMetadata> | undefined;
  return {
    env,
    finish: (destination) =>
      (finishing ??= (async () => {
        try {
          const { forced } = await stopRecorder(shell, recorder, recorderPid, requestTimeoutMs);
          const durationMs = await probeDuration(shell, requestTimeoutMs);
          const bytes = await transferRecording(options.desktop, destination, requestTimeoutMs);
          return {
            mimeType: "video/mp4" as const,
            startedAt,
            durationMs,
            bytes,
            audioSources,
            complete: !recorder.exitedEarly() && !forced,
          };
        } catch {
          throw new Error("E2B desktop recording failed.");
        } finally {
          await stopOwnedPulse();
        }
      })()),
  };
}
