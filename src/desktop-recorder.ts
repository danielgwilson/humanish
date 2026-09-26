import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DESKTOP_RECORDING_MAX_BYTES, type DesktopRecordingMetadata } from "./desktop-recording-types.js";

export type DesktopRecordingAudioSource = "microphone-input" | "speaker-output";

const PULSE_DEVICE: Readonly<Record<DesktopRecordingAudioSource, string>> = Object.freeze({
  "microphone-input": "humanish_mic.monitor",
  "speaker-output": "humanish_speaker.monitor"
});

export interface DesktopRecorderCommandOptions {
  display: string;
  width: number;
  height: number;
  outputPath: string;
  frameRate?: number;
  audioSources?: readonly DesktopRecordingAudioSource[];
}

export interface DesktopRecorderResult {
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
  if (!/^:[0-9]{1,5}$/.test(options.display)
    || !validInteger(options.width, 4096) || !validInteger(options.height, 4096)
    || !validInteger(options.frameRate ?? 15, 60)
    || !isAbsolute(options.outputPath) || normalize(options.outputPath) !== options.outputPath
    || !/^\/[A-Za-z0-9._/-]+$/.test(options.outputPath)) throw new Error("Invalid desktop recording configuration.");
  const sources = options.audioSources ?? [];
  if (sources.length > 2 || new Set(sources).size !== sources.length
    || sources.some(source => !Object.hasOwn(PULSE_DEVICE, source))) throw new Error("Invalid desktop recording audio sources.");
  return sources;
}

/** One fixed, ordinary FFmpeg recipe. Adapters own process transport and the output path. */
export function buildDesktopRecorderCommand(options: DesktopRecorderCommandOptions): { binary: "/usr/bin/ffmpeg"; args: string[] } {
  const sources = validate(options);
  const args = ["-nostdin", "-v", "error", "-y", "-f", "x11grab", "-framerate", String(options.frameRate ?? 15),
    "-video_size", `${options.width}x${options.height}`, "-i", options.display];
  for (const source of sources) args.push("-thread_queue_size", "512", "-f", "pulse", "-i", PULSE_DEVICE[source]);
  if (sources.length === 1) args.push("-map", "0:v", "-map", "1:a");
  else if (sources.length > 1) {
    const inputs = sources.map((_source, index) => `[${index + 1}:a]`).join("");
    args.push("-filter_complex", `${inputs}amix=inputs=${sources.length}:normalize=0[a]`, "-map", "0:v", "-map", "[a]");
  } else args.push("-map", "0:v");
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p");
  if (sources.length > 0) args.push("-c:a", "aac");
  args.push("-movflags", "+faststart", options.outputPath);
  return { binary: "/usr/bin/ffmpeg", args };
}

function waitForClose(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function run(binary: string, args: string[], env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const child = spawn(binary, args, { env, stdio: "ignore" });
  const abort = (): void => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const result = await waitForClose(child);
    if (result.code !== 0) throw new Error("Desktop recording audio setup failed.");
  } finally { signal.removeEventListener("abort", abort); }
}

async function startPulse(env: Readonly<Record<string, string>>, signal: AbortSignal): Promise<{ child: ChildProcess; closed: Promise<unknown> }> {
  const pulse = spawn("/usr/bin/pulseaudio", ["--daemonize=no", "--exit-idle-time=-1", "--disallow-exit", "--log-target=stderr"],
    { env, stdio: "ignore" });
  const closed = waitForClose(pulse);
  void closed.catch(() => {});
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await run("/usr/bin/pactl", ["info"], env, signal); ready = true; break; }
      catch { await delay(50, undefined, { signal }); }
    }
    if (!ready) throw new Error("Desktop recording audio setup failed.");
    await run("/usr/bin/pactl", ["load-module", "module-null-sink", "sink_name=humanish_mic", "sink_properties=device.description=HumanishSyntheticMicrophone"], env, signal);
    await run("/usr/bin/pactl", ["load-module", "module-remap-source", "master=humanish_mic.monitor", "source_name=humanish_input", "source_properties=device.description=HumanishSyntheticMicrophone"], env, signal);
    await run("/usr/bin/pactl", ["load-module", "module-null-sink", "sink_name=humanish_speaker", "sink_properties=device.description=HumanishSyntheticSpeaker"], env, signal);
    await run("/usr/bin/pactl", ["set-default-source", "humanish_input"], env, signal);
    await run("/usr/bin/pactl", ["set-default-sink", "humanish_speaker"], env, signal);
    return { child: pulse, closed };
  } catch (error) {
    if (pulse.exitCode === null && pulse.signalCode === null) pulse.kill("SIGKILL");
    await closed.catch(() => {});
    throw error;
  }
}

/** Guest-local lifecycle. Recorder faults are reported only when evidence is finalized. */
export async function startDesktopRecorder(options: DesktopRecorderCommandOptions & {
  env: Readonly<Record<string, string>>;
  signal: AbortSignal;
  pulseReady?: boolean;
}): Promise<DesktopRecorderHandle> {
  const sources = validate(options);
  const outputPath = options.outputPath;
  const pulseServer = `unix:${options.env.XDG_RUNTIME_DIR ?? "/run/humanish/xdg"}/pulse/native`;
  const env = sources.length === 0 ? options.env : { ...options.env, PULSE_SERVER: pulseServer, PULSE_SOURCE: "humanish_input", PULSE_SINK: "humanish_speaker" };
  const ownedPulse = sources.length > 0 && options.pulseReady !== true ? await startPulse(env, options.signal) : undefined;
  const command = buildDesktopRecorderCommand(options);
  const startedAtMs = Date.now();
  const child = spawn(command.binary, command.args, { env, stdio: "ignore" });
  const closed = waitForClose(child);
  void closed.catch(() => {});
  await Promise.race([closed.then(() => { throw new Error("Desktop recorder exited during startup."); }), delay(150, undefined, { signal: options.signal })]);
  let finishing: Promise<DesktopRecorderResult> | undefined;
  const finish = (): Promise<DesktopRecorderResult> => finishing ??= (async () => {
    let forced = false;
    try {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("Desktop recorder stopped before finalization.");
      child.kill("SIGINT");
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(() => {
        forced = true;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      }, 3000); })]).finally(() => clearTimeout(timer));
      if (forced) { await closed.catch(() => {}); throw new Error("Desktop recorder did not finalize."); }
      const file = await stat(outputPath);
      if (!file.isFile() || file.size < 1 || file.size > DESKTOP_RECORDING_MAX_BYTES) throw new Error("Desktop recorder produced invalid output.");
      return { outputPath, metadata: { mimeType: "video/mp4", startedAt: new Date(startedAtMs).toISOString(),
        durationMs: Math.max(1, Date.now() - startedAtMs), bytes: file.size, audioSources: [...sources], complete: true } };
    } catch {
      throw new Error("Desktop recording failed.");
    } finally {
      if (ownedPulse && ownedPulse.child.exitCode === null && ownedPulse.child.signalCode === null) ownedPulse.child.kill("SIGTERM");
      await ownedPulse?.closed.catch(() => {});
    }
  })();
  return { env, outputPath, finish };
}
