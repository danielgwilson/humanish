import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { PassThrough, Writable } from "node:stream";

const mode = process.env.HUMANISH_MEDIA_PROOF_MODE;
const startedAt = Date.now();

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
    setTimeout(() => child.finish(1), 300);
  }
  return child;
};

net.createConnection = function () {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  setImmediate(() => {
    if (mode === "early-camera-exit" && Date.now() - startedAt < 450) socket.emit("error", new Error("synthetic not ready"));
    else socket.emit("connect");
  });
  return socket;
};

syncBuiltinESMExports();
