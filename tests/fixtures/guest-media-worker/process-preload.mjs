import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { PassThrough, Writable } from "node:stream";

const mode = process.env.HUMANISH_MEDIA_PROOF_MODE;
// Set when the synthetic camera dies. The synthetic whisper port stays closed until then, so the
// worker can reach ready in early-camera-exit mode only by ignoring the camera's exit. Ordering by
// this event keeps the proof independent of how loaded the machine is.
let cameraExited = false;

// Models a loaded machine: the worker module starts this long after the process does.
const startupDelayMs = Number(process.env.HUMANISH_MEDIA_PROOF_STARTUP_DELAY_MS ?? 0);
if (startupDelayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, startupDelayMs);

class SyntheticChild extends EventEmitter {
  constructor({ stdin = false, stdout = false } = {}) {
    super();
    this.stdin = stdin ? new Writable({ write(_chunk, _encoding, done) { done(); } }) : null;
    this.stdout = stdout ? new PassThrough() : null;
    this.stderr = null;
    this.exitCode = null;
    this.signalCode = null;
    this.closed = false;
  }
  finish(code = 0, signal = null) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("close", code, signal);
  }
  kill(signal = "SIGTERM") {
    this.finish(null, signal);
    return true;
  }
}

childProcess.spawn = function (binary, _args, options = {}) {
  const wantsStdin = Array.isArray(options.stdio) && options.stdio[0] === "pipe";
  const wantsStdout = Array.isArray(options.stdio) && options.stdio[1] === "pipe";
  const child = new SyntheticChild({ stdin: wantsStdin, stdout: wantsStdout });
  if (binary.endsWith("pactl")) setImmediate(() => child.finish());
  if (binary.endsWith("paplay")) child.stdin?.once("finish", () => setImmediate(() => child.finish()));
  if (binary.endsWith("parec")) setImmediate(() => child.stdout.write(Buffer.alloc(6400)));
  if (binary.endsWith("ffmpeg") && mode === "early-camera-exit") {
    setTimeout(() => {
      cameraExited = true;
      child.finish(1);
    }, 300);
  }
  return child;
};

net.createConnection = function () {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  setImmediate(() => {
    if (mode === "early-camera-exit" && !cameraExited) socket.emit("error", new Error("synthetic not ready"));
    else socket.emit("connect");
  });
  return socket;
};

syncBuiltinESMExports();
