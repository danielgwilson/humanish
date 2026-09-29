import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DESKTOP_RECORDING_MAX_BYTES,
  type DesktopRecordingMetadata,
} from "./desktop-recording-types.js";

export type DesktopRecordingAudioSource = "microphone-input" | "speaker-output";

const PULSE_DEVICE: Readonly<Record<DesktopRecordingAudioSource, string>> = Object.freeze({
  "microphone-input": "humanish_mic.monitor",
  "speaker-output": "humanish_speaker.monitor",
});
const COMBINED_PULSE_DEVICE = "humanish_recording.monitor";
const RECORDING_FILE_LIMIT_BYTES = DESKTOP_RECORDING_MAX_BYTES - 1024 * 1024;

export interface DesktopRecorderCommandOptions {
  display: string;
  width: number;
  height: number;
  outputPath: string;
  frameRate?: number;
  audioSources?: readonly DesktopRecordingAudioSource[];
}

interface DesktopRecorderResult {
  metadata: DesktopRecordingMetadata;
  outputPath: string;
}

export interface DesktopRecorderHandle {
  readonly env: Readonly<Record<string, string>>;
  readonly outputPath: string;
  finish(): Promise<DesktopRecorderResult>;
}

function validInteger(value: number, maximum: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= maximum;
}

function validate(options: DesktopRecorderCommandOptions): readonly DesktopRecordingAudioSource[] {
  if (
    !/^:[0-9]{1,5}$/.test(options.display) ||
    !validInteger(options.width, 4096) ||
    !validInteger(options.height, 4096) ||
    !validInteger(options.frameRate ?? 15, 60) ||
    !isAbsolute(options.outputPath) ||
    normalize(options.outputPath) !== options.outputPath ||
    !/^\/[A-Za-z0-9._/-]+$/.test(options.outputPath)
  )
    throw new Error("Invalid desktop recording configuration.");
  const sources = options.audioSources ?? [];
  if (
    sources.length > 2 ||
    new Set(sources).size !== sources.length ||
    sources.some((source) => !Object.hasOwn(PULSE_DEVICE, source))
  )
    throw new Error("Invalid desktop recording audio sources.");
  return sources;
}

/** One fixed, ordinary FFmpeg recipe. Adapters own process transport and the output path. */
export function buildDesktopRecorderCommand(
  options: DesktopRecorderCommandOptions,
  startedAtMs: number,
): { binary: "/usr/bin/ffmpeg"; args: string[] } {
  const sources = validate(options);
  if (!Number.isSafeInteger(startedAtMs) || startedAtMs < 1)
    throw new Error("Invalid desktop recording start time.");
  // Both live inputs use wall-clock timestamps; one output origin preserves their offset.
  // Bound raw video buffering separately from the much smaller audio packets.
  // The shared spelling supports E2B's FFmpeg 4.4 as well as the local runtime.
  // Explicit VFR prevents older FFmpeg defaults from filling gaps with duplicates.
  const args = [
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-copyts",
    "-vsync",
    "vfr",
    "-thread_queue_size",
    "32",
    "-probesize",
    "32",
    "-analyzeduration",
    "0",
    "-f",
    "x11grab",
    "-framerate",
    String(options.frameRate ?? 15),
    "-video_size",
    `${options.width}x${options.height}`,
    "-i",
    options.display,
  ];
  const devices =
    sources.length === 2 ? [COMBINED_PULSE_DEVICE] : sources.map((source) => PULSE_DEVICE[source]);
  for (const device of devices)
    args.push(
      "-thread_queue_size",
      "512",
      "-probesize",
      "32",
      "-analyzeduration",
      "0",
      "-fflags",
      "nobuffer",
      "-f",
      "pulse",
      "-sample_rate",
      "48000",
      "-channels",
      "2",
      "-i",
      device,
    );
  if (devices.length === 1) args.push("-map", "0:v", "-map", "1:a");
  else args.push("-map", "0:v");
  // X11 timestamps are microseconds. The encoder's default 1/framerate grid
  // rounds those times and drops distinct captures after an input stall.
  args.push(
    "-vf",
    "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v",
    "libx264",
    "-enc_time_base:v",
    "1:1000000",
    "-preset",
    "ultrafast",
    "-crf",
    "28",
    "-pix_fmt",
    "yuv420p",
  );
  if (sources.length > 0) args.push("-c:a", "aac");
  args.push(
    "-fs",
    String(RECORDING_FILE_LIMIT_BYTES),
    "-movflags",
    "+faststart",
    "-output_ts_offset",
    String(-startedAtMs / 1000),
    options.outputPath,
  );
  return { binary: "/usr/bin/ffmpeg", args };
}

export function buildDesktopRecorderPulseSetupCommands(): Array<{
  binary: "/usr/bin/pactl";
  args: string[];
}> {
  // The capture mix needs no playback rewinds. Bound its cold buffer to 50 ms
  // instead of the null sink's default two seconds, which stalls initial capture.
  return [
    [
      "load-module",
      "module-null-sink",
      "sink_name=humanish_recording",
      "sink_properties=device.description=HumanishRecordingMix",
      "norewinds=true",
    ],
    ["set-sink-volume", "humanish_recording", "0.5"],
    [
      "load-module",
      "module-loopback",
      "source=humanish_mic.monitor",
      "sink=humanish_recording",
      "latency_msec=20",
    ],
    [
      "load-module",
      "module-loopback",
      "source=humanish_speaker.monitor",
      "sink=humanish_recording",
      "latency_msec=20",
    ],
  ].map((args) => ({ binary: "/usr/bin/pactl" as const, args }));
}

export function buildDesktopRecorderProbeCommand(outputPath: string): {
  binary: "/usr/bin/ffprobe";
  args: string[];
} {
  validate({ display: ":0", width: 1, height: 1, outputPath });
  return {
    binary: "/usr/bin/ffprobe",
    args: [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      outputPath,
    ],
  };
}

export function parseDesktopRecorderDuration(output: string): number {
  if (!/^[0-9]+(?:\.[0-9]+)?\s*$/.test(output))
    throw new Error("Desktop recording duration was invalid.");
  const durationMs = Math.round(Number(output.trim()) * 1000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1)
    throw new Error("Desktop recording duration was invalid.");
  return durationMs;
}

function waitForClose(
  child: ChildProcess,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function run(
  binary: string,
  args: string[],
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const child = spawn(binary, args, { env, stdio: "ignore" });
  const abort = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await waitForClose(child);
    if (result.code !== 0) throw new Error("Desktop recording audio setup failed.");
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function startPulse(
  env: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<{ child: ChildProcess; closed: Promise<unknown> }> {
  const pulse = spawn(
    "/usr/bin/pulseaudio",
    ["--daemonize=no", "--exit-idle-time=-1", "--disallow-exit", "--log-target=stderr"],
    { env, stdio: "ignore" },
  );
  const closed = waitForClose(pulse);
  void closed.catch(() => {});
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await run("/usr/bin/pactl", ["info"], env, signal);
        ready = true;
        break;
      } catch {
        await delay(50, undefined, { signal });
      }
    }
    if (!ready) throw new Error("Desktop recording audio setup failed.");
    await run(
      "/usr/bin/pactl",
      [
        "load-module",
        "module-null-sink",
        "sink_name=humanish_mic",
        "sink_properties=device.description=HumanishSyntheticMicrophone",
      ],
      env,
      signal,
    );
    await run(
      "/usr/bin/pactl",
      [
        "load-module",
        "module-remap-source",
        "master=humanish_mic.monitor",
        "source_name=humanish_input",
        "source_properties=device.description=HumanishSyntheticMicrophone",
      ],
      env,
      signal,
    );
    await run(
      "/usr/bin/pactl",
      [
        "load-module",
        "module-null-sink",
        "sink_name=humanish_speaker",
        "sink_properties=device.description=HumanishSyntheticSpeaker",
      ],
      env,
      signal,
    );
    await run("/usr/bin/pactl", ["set-default-source", "humanish_input"], env, signal);
    await run("/usr/bin/pactl", ["set-default-sink", "humanish_speaker"], env, signal);
    return { child: pulse, closed };
  } catch (error) {
    await stopPulse({ child: pulse, closed });
    throw error;
  }
}

async function stopPulse(
  pulse: { child: ChildProcess; closed: Promise<unknown> } | undefined,
): Promise<void> {
  if (!pulse) return;
  if (pulse.child.exitCode === null && pulse.child.signalCode === null) pulse.child.kill("SIGTERM");
  let settled = false;
  await Promise.race([
    pulse.closed
      .catch(() => {})
      .finally(() => {
        settled = true;
      }),
    delay(1500),
  ]);
  if (!settled && pulse.child.exitCode === null && pulse.child.signalCode === null)
    pulse.child.kill("SIGKILL");
  await Promise.race([pulse.closed.catch(() => {}), delay(500)]);
}

async function probeDuration(
  outputPath: string,
  env: Readonly<Record<string, string>>,
): Promise<number> {
  const command = buildDesktopRecorderProbeCommand(outputPath);
  const child = spawn(command.binary, command.args, { env, stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    if (output.length < 256) output += chunk.toString("utf8").slice(0, 256 - output.length);
  });
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    waitForClose(child),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        reject(new Error("Desktop recording probe timed out."));
      }, 3000);
    }),
  ]).finally(() => clearTimeout(timer));
  if (result.code !== 0) throw new Error("Desktop recording probe failed.");
  return parseDesktopRecorderDuration(output);
}

/** Guest-local lifecycle. Recorder faults are reported only when evidence is finalized. */
export async function startDesktopRecorder(
  options: DesktopRecorderCommandOptions & {
    env: Readonly<Record<string, string>>;
    signal: AbortSignal;
    pulseReady?: boolean;
  },
): Promise<DesktopRecorderHandle> {
  const sources = validate(options);
  const outputPath = options.outputPath;
  const pulseServer = `unix:${options.env.XDG_RUNTIME_DIR ?? "/run/humanish/xdg"}/pulse/native`;
  const env =
    sources.length === 0
      ? options.env
      : {
          ...options.env,
          PULSE_SERVER: pulseServer,
          PULSE_SOURCE: "humanish_input",
          PULSE_SINK: "humanish_speaker",
        };
  const ownedPulse =
    sources.length > 0 && options.pulseReady !== true
      ? await startPulse(env, options.signal)
      : undefined;
  if (sources.length === 2) {
    try {
      for (const setup of buildDesktopRecorderPulseSetupCommands())
        await run(setup.binary, setup.args, env, options.signal);
    } catch (error) {
      await stopPulse(ownedPulse);
      throw error;
    }
  }
  const startedAtMs = Date.now();
  const command = buildDesktopRecorderCommand(options, startedAtMs);
  const child = spawn(command.binary, command.args, { env, stdio: "ignore" });
  const closed = waitForClose(child);
  void closed.catch(() => {});
  let finishing: Promise<DesktopRecorderResult> | undefined;
  let abort: (() => void) | undefined;
  const finish = (): Promise<DesktopRecorderResult> =>
    (finishing ??= (async () => {
      let forced = false,
        requestedStop = false;
      try {
        if (child.exitCode === null && child.signalCode === null) {
          requestedStop = child.kill("SIGINT");
        }
        let timer: NodeJS.Timeout | undefined,
          settled = false;
        await Promise.race([
          closed
            .catch(() => undefined)
            .finally(() => {
              settled = true;
            }),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 3000);
          }),
        ]).finally(() => clearTimeout(timer));
        if (!settled && child.exitCode === null && child.signalCode === null) {
          forced = true;
          child.kill("SIGKILL");
        }
        if (!settled) await Promise.race([closed.catch(() => undefined), delay(500)]);
        const file = await stat(outputPath);
        if (!file.isFile() || file.size < 1 || file.size > DESKTOP_RECORDING_MAX_BYTES)
          throw new Error("Desktop recorder produced invalid output.");
        const durationMs = await probeDuration(outputPath, env);
        return {
          outputPath,
          metadata: {
            mimeType: "video/mp4",
            startedAt: new Date(startedAtMs).toISOString(),
            durationMs,
            bytes: file.size,
            audioSources: [...sources],
            complete: requestedStop && !forced && file.size < RECORDING_FILE_LIMIT_BYTES,
          },
        };
      } catch {
        throw new Error("Desktop recording failed.");
      } finally {
        if (abort) options.signal.removeEventListener("abort", abort);
        await stopPulse(ownedPulse);
      }
    })());
  try {
    await Promise.race([
      closed.then(() => {
        throw new Error("Desktop recorder exited during startup.");
      }),
      delay(150, undefined, { signal: options.signal }),
    ]);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([closed.catch(() => {}), delay(500)]);
    await stopPulse(ownedPulse);
    throw new Error("Desktop recording failed.");
  }
  abort = (): void => {
    void finish().catch(() => {});
  };
  options.signal.addEventListener("abort", abort, { once: true });
  return { env, outputPath, finish };
}
