import { Readable, Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  buildDesktopRecorderCommand,
  buildDesktopRecorderPulseSetupCommands,
  buildDesktopRecorderProbeCommand,
  parseDesktopRecorderDuration,
  type DesktopRecordingAudioSource,
} from "../../desktop-recorder.js";
import {
  DESKTOP_RECORDING_MAX_BYTES,
  type DesktopRecordingMetadata,
} from "../../desktop-recording-types.js";
import type { E2BCommandResult, E2BDesktopSandbox } from "./desktop-launch.js";

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

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function preparePulse(
  desktop: E2BDesktopSandbox,
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
    await desktop.commands.run(
      "install -d -m 0700 /tmp/humanish-recording-runtime && " +
        "pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr && " +
        "pactl load-module module-null-sink sink_name=humanish_mic sink_properties=device.description=HumanishSyntheticMicrophone >/dev/null && " +
        "pactl load-module module-remap-source master=humanish_mic.monitor source_name=humanish_input source_properties=device.description=HumanishSyntheticMicrophone >/dev/null && " +
        "pactl load-module module-null-sink sink_name=humanish_speaker sink_properties=device.description=HumanishSyntheticSpeaker >/dev/null && " +
        "pactl set-default-source humanish_input && pactl set-default-sink humanish_speaker",
      {
        envs: env,
        timeoutMs: 30_000,
        requestTimeoutMs,
      },
    );
    return env;
  } catch (error) {
    await desktop.commands
      .run("pulseaudio --kill", { envs: env, timeoutMs: 5_000, requestTimeoutMs })
      .catch(() => {});
    throw error;
  }
}

export interface E2BDesktopRecording {
  readonly env: Readonly<Record<string, string>>;
  finish(destination: Writable): Promise<DesktopRecordingMetadata>;
}

/** Starts the shared FFmpeg recipe through E2B's command transport; retrieval remains host-owned. */
export async function startE2BDesktopRecording(options: {
  desktop: E2BDesktopSandbox;
  width: number;
  height: number;
  audio: boolean;
  pulseEnv?: Readonly<Record<string, string>>;
  requestTimeoutMs: number;
}): Promise<E2BDesktopRecording> {
  if (!options.desktop.files.read)
    throw new Error("Installed @e2b/desktop does not support streamed recording retrieval.");
  const audioSources: DesktopRecordingAudioSource[] = options.audio
    ? ["microphone-input", "speaker-output"]
    : [];
  const ownsPulse = options.audio && options.pulseEnv === undefined;
  const env = options.audio
    ? (options.pulseEnv ?? (await preparePulse(options.desktop, options.requestTimeoutMs)))
    : baseEnv;
  const stopOwnedPulse = async (): Promise<void> => {
    if (ownsPulse)
      await options.desktop.commands
        .run("pulseaudio --kill", {
          envs: { ...env },
          timeoutMs: 5_000,
          requestTimeoutMs: options.requestTimeoutMs,
        })
        .catch(() => {});
  };
  try {
    for (const setup of options.audio ? buildDesktopRecorderPulseSetupCommands() : []) {
      await options.desktop.commands.run(
        `${quote(setup.binary)} ${setup.args.map(quote).join(" ")}`,
        {
          envs: { ...env },
          timeoutMs: 5_000,
          requestTimeoutMs: options.requestTimeoutMs,
        },
      );
    }
  } catch (error) {
    await stopOwnedPulse();
    throw error;
  }
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
    `set -eu; rm -f ${quote(PID_PATH)}; /usr/bin/env --default-signal=INT,TERM ${quote(command.binary)} ${command.args.map(quote).join(" ")} & ` +
    `child=$!; printf '%s\\n' "$child" > ${quote(PID_PATH)}; wait "$child"`;
  let handle: E2BCommandResult;
  // The host launch boundary is the only clock shared with later run events. Capture it before
  // the provider RPC so startup transport latency is not silently removed from the timeline.
  const startedAt = new Date(startedAtMs).toISOString();
  try {
    handle = await options.desktop.commands.run(launch, {
      background: true,
      envs: { ...baseEnv, ...env },
      timeoutMs: 0,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  } catch (error) {
    await stopOwnedPulse();
    throw error;
  }
  if (!handle.wait || !handle.kill || !Number.isSafeInteger(handle.pid) || handle.pid! < 1) {
    await handle.kill?.().catch(() => {});
    await stopOwnedPulse();
    throw new Error("Installed @e2b/desktop does not expose an owned recording process handle.");
  }
  const wait = handle.wait.bind(handle);
  const kill = handle.kill.bind(handle);
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
  await options.desktop.wait(150);
  if (exitedEarly) {
    await stopOwnedPulse();
    throw new Error("E2B desktop recorder exited during startup.");
  }
  const pidResult = await options.desktop.commands
    .run(`cat ${quote(PID_PATH)}`, {
      timeoutMs: 5_000,
      requestTimeoutMs: options.requestTimeoutMs,
    })
    .catch(async (error) => {
      await kill().catch(() => {});
      await stopOwnedPulse();
      throw error;
    });
  const recorderPid = Number(pidResult.stdout?.trim());
  if (!Number.isSafeInteger(recorderPid) || recorderPid < 1) {
    await kill().catch(() => {});
    await stopOwnedPulse();
    throw new Error("E2B desktop recorder did not report its owned process ID.");
  }
  let finishing: Promise<DesktopRecordingMetadata> | undefined;
  return {
    env,
    finish: (destination) =>
      (finishing ??= (async () => {
        let forced = false;
        try {
          stopping = true;
          if (!exitedEarly) {
            await options.desktop.commands.run(`kill -INT -- ${recorderPid}`, {
              timeoutMs: 5_000,
              requestTimeoutMs: options.requestTimeoutMs,
            });
          }
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            exited,
            new Promise<void>((resolve) => {
              timer = setTimeout(() => {
                forced = true;
                resolve();
              }, FINALIZE_TIMEOUT_MS);
            }),
          ]).finally(() => clearTimeout(timer));
          if (forced) {
            await kill().catch(() => {});
            if (!(await settlesWithin(exited, FORCE_REAP_TIMEOUT_MS)))
              throw new Error("E2B recorder process did not stop.");
          }
          const probeCommand = buildDesktopRecorderProbeCommand(OUTPUT_PATH);
          const probe = await options.desktop.commands.run(
            `${quote(probeCommand.binary)} ${probeCommand.args.map(quote).join(" ")}`,
            {
              timeoutMs: 30_000,
              requestTimeoutMs: options.requestTimeoutMs,
            },
          );
          const durationMs = parseDesktopRecorderDuration(probe.stdout ?? "");
          const transferSignal = AbortSignal.timeout(options.requestTimeoutMs);
          const web = await options.desktop.files.read!(OUTPUT_PATH, {
            format: "stream",
            requestTimeoutMs: options.requestTimeoutMs,
            streamIdleTimeoutMs: options.requestTimeoutMs,
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
          return {
            mimeType: "video/mp4" as const,
            startedAt,
            durationMs,
            bytes: transferred,
            audioSources,
            complete: !exitedEarly && !forced,
          };
        } catch {
          throw new Error("E2B desktop recording failed.");
        } finally {
          await stopOwnedPulse();
        }
      })()),
  };
}
