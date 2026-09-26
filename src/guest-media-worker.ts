import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";

const PATH = "/usr/bin:/bin";
const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const FRAME_BYTES = SAMPLE_RATE * 2 * FRAME_MS / 1000;
const MAX_LINE_BYTES = 8_192;
const MAX_SPEECH_BYTES = 1_600;
const MAX_AUDIO_BYTES = SAMPLE_RATE * 2 * 15;
const SILENCE_FRAMES = 35;
const PRE_ROLL_FRAMES = 10;
const MIN_VOICE_FRAMES = 10;
const VOICE_THRESHOLD = 350;
const TRANSCRIPTION_QUEUE = 4;
const WHISPER_PORT = 8178;

interface WorkerConfig {
  camera: boolean;
  microphone: boolean;
  pulseServer: string;
  whisperModel: string;
  whisperServer: string;
}

interface Command { id: string; operation: "speak"; text: string }

const config: WorkerConfig = {
  camera: process.env.HUMANISH_MEDIA_CAMERA === "1",
  microphone: process.env.HUMANISH_MEDIA_MICROPHONE === "1",
  pulseServer: process.env.PULSE_SERVER ?? "unix:/run/humanish/xdg/pulse/native",
  whisperModel: process.env.HUMANISH_WHISPER_MODEL ?? "/opt/humanish/media/ggml-tiny.en.bin",
  whisperServer: process.env.HUMANISH_WHISPER_SERVER ?? "/opt/humanish/media/whisper-server"
};
const env = { PATH, HOME: process.env.HOME ?? "/home/humanish", USER: process.env.USER ?? "humanish",
  LANG: "C.UTF-8", LC_ALL: "C.UTF-8", XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "/run/humanish/xdg",
  PULSE_SERVER: config.pulseServer, PULSE_SOURCE: "humanish_input", PULSE_SINK: "humanish_speaker" };
const children = new Set<ChildProcess>();
let closing = false;

function emit(value: unknown): void { process.stdout.write(JSON.stringify(value) + "\n"); }
function boundedText(value: string): string {
  let text = value.trim().slice(0, 400);
  while (Buffer.byteLength(text) > MAX_SPEECH_BYTES) text = text.slice(0, -1);
  return text;
}
function child(binary: string, args: string[], options: { stdin?: "pipe"; stdout?: "pipe"; stderr?: "pipe" } = {}): ChildProcess {
  const process = spawn(binary, args, { env, stdio: [options.stdin ?? "ignore", options.stdout ?? "ignore", options.stderr ?? "ignore"] });
  children.add(process); process.once("close", () => children.delete(process));
  return process;
}
function persistent(childProcess: ChildProcess): ChildProcess {
  childProcess.once("close", () => {
    if (!closing) { close(); process.exit(1); }
  });
  return childProcess;
}
function waitExit(process: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("close", code => code === 0 ? resolve() : reject(new Error("media subprocess failed")));
  });
}
async function retry(action: () => Promise<boolean>, attempts = 100): Promise<void> {
  for (let n = 0; n < attempts; n++) {
    if (closing) throw new Error("media worker closed");
    if (await action()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("media subprocess was not ready");
}
function run(binary: string, args: string[]): Promise<void> { return waitExit(child(binary, args)); }

async function startPulse(): Promise<ChildProcess> {
  const pulse = persistent(child("/usr/bin/pulseaudio", ["--daemonize=no", "--exit-idle-time=-1", "--disallow-exit", "--log-target=stderr"]));
  await retry(async () => {
    try { await run("/usr/bin/pactl", ["info"]); return true; } catch { return false; }
  });
  await run("/usr/bin/pactl", ["load-module", "module-null-sink", "sink_name=humanish_mic", "sink_properties=device.description=HumanishSyntheticMicrophone"]);
  await run("/usr/bin/pactl", ["load-module", "module-remap-source", "master=humanish_mic.monitor", "source_name=humanish_input", "source_properties=device.description=HumanishSyntheticMicrophone"]);
  await run("/usr/bin/pactl", ["load-module", "module-null-sink", "sink_name=humanish_speaker", "sink_properties=device.description=HumanishSyntheticSpeaker"]);
  await run("/usr/bin/pactl", ["set-default-source", "humanish_input"]);
  await run("/usr/bin/pactl", ["set-default-sink", "humanish_speaker"]);
  return pulse;
}

async function startCamera(): Promise<ChildProcess | undefined> {
  if (!config.camera) return undefined;
  const camera = persistent(child("/usr/bin/ffmpeg", ["-nostdin", "-v", "error", "-re", "-f", "lavfi", "-i",
    "testsrc2=size=640x360:rate=10", "-pix_fmt", "yuv420p", "-f", "v4l2", "/dev/video0"]));
  let failed = false; camera.once("close", () => { failed = true; });
  await new Promise(resolve => setTimeout(resolve, 250));
  if (failed) throw new Error("camera producer failed");
  return camera;
}

async function startWhisper(): Promise<ChildProcess | undefined> {
  if (!config.microphone) return undefined;
  const server = persistent(child(config.whisperServer, ["--host", "127.0.0.1", "--port", String(WHISPER_PORT),
    "--model", config.whisperModel, "--threads", "2", "--language", "en"]));
  await retry(() => new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port: WHISPER_PORT });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  }), 600);
  return server;
}

function wav(raw: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + raw.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(raw.length, 40);
  return Buffer.concat([header, raw]);
}

function transcribe(raw: Buffer): Promise<string> {
  const audio = wav(raw), boundary = "humanish-media-boundary";
  const before = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="utterance.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const fields = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`);
  return new Promise((resolve, reject) => {
    const call = request({ host: "127.0.0.1", port: WHISPER_PORT, method: "POST", path: "/inference",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "content-length": before.length + audio.length + fields.length } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 64 * 1024) chunks.push(chunk); else response.destroy(); });
      response.once("end", () => {
        try {
          if (response.statusCode !== 200 || bytes > 64 * 1024) throw new Error("transcription failed");
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown };
          resolve(typeof value.text === "string" ? value.text.trim() : "");
        } catch (error) { reject(error); }
      }); response.once("error", reject);
    });
    call.setTimeout(20_000, () => call.destroy(new Error("transcription timed out")));
    call.once("error", reject); call.end(Buffer.concat([before, audio, fields]));
  });
}

async function startListening(): Promise<ChildProcess | undefined> {
  if (!config.microphone) return undefined;
  const capture = persistent(child("/usr/bin/parec", ["--raw", "--format=s16le", `--rate=${SAMPLE_RATE}`, "--channels=1", "--device=humanish_speaker.monitor"], { stdout: "pipe" }));
  const captureReady = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("speaker capture was not ready")); }, 5_000);
    const ready = (): void => { cleanup(); resolve(); };
    const failed = (): void => { cleanup(); reject(new Error("speaker capture failed")); };
    const cleanup = (): void => {
      clearTimeout(timer); capture.stdout!.off("data", ready); capture.off("error", failed); capture.off("close", failed);
    };
    capture.stdout!.once("data", ready); capture.once("error", failed); capture.once("close", failed);
  });
  let pending = Buffer.alloc(0), active: Buffer[] | undefined, pre: Buffer[] = [], voiceFrames = 0, quietFrames = 0;
  const utterances: Array<{ audio: Buffer; durationMs: number }> = []; let transcribing = false, nextId = 1;
  const drain = async (): Promise<void> => {
    if (transcribing || closing) return; transcribing = true;
    try {
      while (!closing && utterances.length) {
        const item = utterances.shift()!;
        const text = boundedText(await transcribe(item.audio));
        if (text) emit({ type: "heard", utterance: { id: `speech-${nextId++}`, source: "speaker_audio", text, durationMs: item.durationMs } });
      }
    } catch { close(); process.exit(1); }
    finally { transcribing = false; }
  };
  const finish = (): void => {
    if (!active) return;
    const bytes = Buffer.concat(active).subarray(0, MAX_AUDIO_BYTES), durationMs = Math.max(1, Math.round(bytes.length / 2 / SAMPLE_RATE * 1000));
    if (voiceFrames >= MIN_VOICE_FRAMES) {
      if (utterances.length === TRANSCRIPTION_QUEUE) { close(); process.exit(1); }
      utterances.push({ audio: bytes, durationMs }); void drain();
    }
    active = undefined; voiceFrames = 0; quietFrames = 0;
  };
  capture.stdout!.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= FRAME_BYTES) {
      const frame = pending.subarray(0, FRAME_BYTES); pending = pending.subarray(FRAME_BYTES);
      let sum = 0; for (let i = 0; i < frame.length; i += 2) sum += Math.abs(frame.readInt16LE(i));
      const voice = sum / (frame.length / 2) >= VOICE_THRESHOLD;
      if (!active) {
        pre.push(Buffer.from(frame)); if (pre.length > PRE_ROLL_FRAMES) pre.shift();
        if (voice) { active = pre; pre = []; voiceFrames = 1; }
      } else {
        active.push(Buffer.from(frame)); if (voice) { voiceFrames++; quietFrames = 0; } else quietFrames++;
        if (quietFrames >= SILENCE_FRAMES || active.length * FRAME_BYTES >= MAX_AUDIO_BYTES) finish();
      }
    }
  });
  capture.once("close", finish);
  const prime = child("/usr/bin/paplay", ["--raw", "--format=s16le", `--rate=${SAMPLE_RATE}`, "--channels=1", "--device=humanish_speaker"], { stdin: "pipe" });
  prime.stdin!.end(Buffer.alloc(FRAME_BYTES * PRE_ROLL_FRAMES));
  await Promise.all([captureReady, waitExit(prime)]);
  return capture;
}

async function speak(text: string): Promise<void> {
  const tts = child("/usr/bin/espeak-ng", ["--stdout", "--stdin"], { stdin: "pipe", stdout: "pipe" });
  const playback = child("/usr/bin/paplay", ["--device=humanish_mic"], { stdin: "pipe" });
  tts.stdout!.pipe(playback.stdin!); tts.stdin!.end(text);
  await Promise.all([waitExit(tts), waitExit(playback)]);
}

async function main(): Promise<void> {
  await mkdir(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  if (config.microphone) await startPulse();
  await startCamera();
  await startWhisper();
  await startListening();
  emit({ type: "ready" });
  let input = Buffer.alloc(0), serial = Promise.resolve();
  process.stdin.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    if (input.length > MAX_LINE_BYTES && !input.includes(10)) { close(); process.exit(1); }
    for (;;) {
      const end = input.indexOf(10); if (end < 0) break;
      if (end > MAX_LINE_BYTES) { close(); process.exit(1); }
      const line = input.subarray(0, end); input = input.subarray(end + 1);
      serial = serial.then(async () => {
        let command: Command | undefined;
        try {
          command = JSON.parse(line.toString("utf8")) as Command;
          if (!command || command.operation !== "speak" || !/^[-A-Za-z0-9._]+$/.test(command.id)
            || typeof command.text !== "string" || !command.text.trim() || command.text.length > 400
            || Buffer.byteLength(command.text) > MAX_SPEECH_BYTES || !config.microphone) throw new Error("invalid command");
          await speak(command.text); emit({ type: "reply", id: command.id, ok: true });
        } catch { emit({ type: "reply", id: (command && typeof command.id === "string") ? command.id : "invalid", ok: false }); }
      }).catch(() => { close(); process.exit(1); });
    }
  });
  process.stdin.resume();
}

function close(): void {
  if (closing) return; closing = true;
  for (const process of children) process.kill("SIGKILL");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once("SIGTERM", () => { close(); process.exit(0); });
  process.once("SIGINT", () => { close(); process.exit(0); });
  process.stdin.once("end", () => { close(); process.exit(0); });
  main().catch(() => { close(); process.exit(1); });
}
