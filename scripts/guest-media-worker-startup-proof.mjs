// Compiled worker lifecycle regression. All media processes and sockets are local fakes.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = join(root, "dist/guest-media-worker.js");
const preload = join(root, "tests/fixtures/guest-media-worker/process-preload.mjs");

async function run(mode) {
  const runtime = await mkdtemp(join(tmpdir(), "humanish-media-worker-"));
  try {
    const child = spawn(process.execPath, ["--unhandled-rejections=strict", "--import", preload, worker], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: runtime, USER: "humanish", XDG_RUNTIME_DIR: runtime,
        HUMANISH_MEDIA_CAMERA: "1", HUMANISH_MEDIA_MICROPHONE: "1", HUMANISH_MEDIA_PROOF_MODE: mode }
    });
    let stdout = "", stderr = "", ready = false, timedOut = false;
    child.stdout.on("data", chunk => {
      stdout += chunk;
      for (const line of stdout.split("\n").slice(0, -1)) {
        if (JSON.parse(line).type === "ready") ready = true;
      }
      if (mode === "healthy" && ready) child.kill("SIGTERM");
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    const watchdog = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 5000);
    let closed;
    try {
      closed = await new Promise((done, fail) => {
        child.once("error", fail);
        child.once("close", (code, signal) => done({ code, signal }));
      });
    } finally { clearTimeout(watchdog); }
    assert.equal(timedOut, false, `${mode} worker timed out: ${stderr}`);
    return { ...closed, ready, stderr };
  } finally { await rm(runtime, { recursive: true, force: true }); }
}

const healthy = await run("healthy");
assert.deepEqual(healthy, { code: 0, signal: null, ready: true, stderr: "" });
const failed = await run("early-camera-exit");
assert.equal(failed.code, 1, failed.stderr);
assert.equal(failed.signal, null);
assert.equal(failed.ready, false, "worker announced ready after its required camera exited");
console.log("guest media startup: healthy worker ready; early required-child exit failed before ready");
