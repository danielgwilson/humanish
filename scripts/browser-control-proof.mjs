// Real browser + child IPC conformance proof for the finite control modules.
// No VM, privileged owner, production guest image, model or network isolation claim follows.
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createBrowserControlClient } from "../dist/browser-control-client.js";
import { runComputerUseLoop } from "../dist/computer-use.js";
import { defaultRedactionHooks } from "../dist/redaction.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proof = path.join(root, ".humanish", "browser-control-proof", new Date().toISOString().replaceAll(":", "-"));
await mkdir(proof, { recursive: true });
const browserCandidates = [process.env.HUMANISH_BROWSER_EXECUTABLE, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  chromium.executablePath(), "/usr/bin/google-chrome", "/usr/bin/chromium", "/snap/bin/chromium"].filter(Boolean);
let executablePath;
for (const candidate of browserCandidates) { try { await access(candidate); executablePath = candidate; break; } catch { /* try next installed browser */ } }
if (!executablePath) throw new Error("Chromium missing. Install the Playwright Chromium build or set HUMANISH_BROWSER_EXECUTABLE.");
const cases = [];
const capabilities = { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: true, byoModel: true, preGrantableApprovals: false, inProcessTools: false, license: "open" };
const html = `<!doctype html><meta charset="utf-8"><title>NoteShelf control proof</title>
<style>body{margin:0;background:#eff1ed;color:#24332c;font:18px system-ui}main{margin:70px auto;width:720px}small{font:12px monospace;letter-spacing:2px}h1{font-size:40px;font-weight:550}input{display:block;box-sizing:border-box;width:600px;height:50px;padding:12px;font:18px system-ui;margin-top:24px;border:1px solid #9bab9e;border-radius:8px}button{margin-top:24px;width:150px;height:48px;background:#355844;color:white;border:0;border-radius:8px;font:18px system-ui}p{margin-top:28px}#status{font-weight:600}</style>
<main><small>HUMANISH · CONTROL CONFORMANCE</small><h1>Save a note</h1><label for="note">A synthetic note</label><input id="note" value="A short note"><button id="save">Save note</button><p id="status">Not saved</p><p>Confirmed saves: <span id="save-count">0</span></p></main>
<script>document.querySelector('#save').onclick=async()=>{const r=await fetch('/save',{method:'POST'});const v=await r.json();document.querySelector('#save-count').textContent=v.saves;document.querySelector('#status').textContent='Saved';};</script>`;

async function bounded(promise, label, ms = 20000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Proof deadline: ${label}`)), ms); })]); }
  finally { clearTimeout(timer); }
}
function mailbox(child) {
  const queued = [];
  const waiting = new Map();
  child.on("message", message => {
    if (message?.event === "startup") return;
    const waiter = waiting.get(message?.event);
    if (waiter) { waiting.delete(message.event); waiter(message); }
    else queued.push(message);
  });
  return async event => {
    const index = queued.findIndex(message => message?.event === event);
    if (index >= 0) return queued.splice(index, 1)[0];
    return bounded(new Promise(resolve => waiting.set(event, resolve)), event);
  };
}
async function runCase(mode) {
  const artifactDir = path.join(proof, mode);
  await mkdir(artifactDir);
  const owned = await mkdtemp(path.join(os.tmpdir(), "humanish-control-proof-"));
  const socketPath = path.join(owned, "control.sock");
  const profile = path.join(owned, "browser");
  const identity = { generation: randomBytes(16).toString("hex"), challenge: randomBytes(32).toString("hex"), runtimeRevision: "development-conformance-v1" };
  let saves = 0;
  const requests = [];
  const app = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url });
    if (req.method === "POST" && req.url === "/save") { saves++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ saves })); }
    else if (req.method === "GET" && req.url === "/") { res.setHeader("content-type", "text/html"); res.end(html); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
  const server = net.createServer();
  const connected = once(server, "connection");
  await new Promise(resolve => server.listen(socketPath, resolve));
  const startupStarted = performance.now();
  const child = fork(path.join(root, "scripts/lib/browser-control-proof-child.mjs"), [socketPath, profile, `http://127.0.0.1:${app.address().port}/`, JSON.stringify(identity), mode, executablePath], {
    cwd: root, env: { PATH: process.env.PATH, HOME: owned, TMPDIR: owned, LANG: "C.UTF-8", PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(os.homedir(), ".cache/ms-playwright") },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  const exit = once(child, "exit");
  const next = mailbox(child);
  let client;
  let childStderr = "";
  child.stderr.on("data", chunk => { childStderr = (childStderr + chunk.toString()).slice(-16000); });
  const result = { mode, passed: false, independentSaves: 0, controlPathOnly: true, startup: [] };
  child.on("message", message => {
    if (message?.event === "startup") result.startup.push({ phase: message.phase, elapsedMs: Math.round(performance.now() - startupStarted) });
  });
  try {
    // Allow the child's 30s browser launch + 30s navigation, with 10s for process/IPC setup.
    // Control and cleanup keep their independent, shorter deadlines.
    const [transport] = await bounded(Promise.race([
      connected,
      exit.then(([code, signal]) => { throw new Error(`Fixture exited during startup: code=${code}, signal=${signal}`); })
    ]), "browser startup / child connection", 70000);
    client = createBrowserControlClient({ transport, identity, requestTimeoutMs: 5000 });
    const ready = await next("ready");
    result.browser = { version: ready.browserVersion, chromiumSandbox: ready.chromiumSandbox };
    await client.ready();
    const before = await client.executor.observe();
    await writeFile(path.join(artifactDir, "before.png"), before.screenshot);
    child.send({ command: "snapshot" });
    const boxes = (await next("snapshot")).state.boxes;
    const notePoint = { x: boxes.note.x + boxes.note.width / 2, y: boxes.note.y + boxes.note.height / 2 };
    const savePoint = { x: boxes.save.x + boxes.save.width / 2, y: boxes.save.y + boxes.save.height / 2 };
    let step = 0;
    let executeError;
    if (mode === "complete") {
      // Deterministic fixture driver; this proves control, not model perception or task quality.
      const actions = [
        { kind: "click", ...notePoint },
        { kind: "keypress", keys: ["CTRL", "a"] },
        { kind: "type", text: "A note entered through the finite control channel." },
        { kind: "click", ...savePoint }
      ];
      const loop = await runComputerUseLoop({
        instructions: "Save the synthetic note.",
        provider: {
          id: "deterministic-control-conformance", version: "1", requiresFrame: true,
          capabilities,
          nextTurn: async () => step < actions.length
            ? { actions: [actions[step++]], pendingSafetyChecks: [], done: false }
            : { actions: [], pendingSafetyChecks: [], done: true, message: "The scripted control sequence ended." }
        },
        executor: client.executor, persona: { id: "synthetic-control-check", promptDigest: "control-conformance", traitsApplied: [] },
        redaction: defaultRedactionHooks, timeoutMs: 30000, now: Date.now,
        writeScreenshot: async (name, bytes) => { await writeFile(path.join(artifactDir, name), bytes); return name; }
      });
      await writeFile(path.join(artifactDir, "trace.json"), JSON.stringify(loop, null, 2));
      assert.equal(loop.completionReason, "goal_satisfied");
      const after = await client.executor.observe();
      await writeFile(path.join(artifactDir, "after.png"), after.screenshot);
      child.send({ command: "snapshot" });
      const state = (await next("snapshot")).state;
      assert.equal(state.note, "A note entered through the finite control channel.");
      assert.equal(state.saves, "1");
      assert.equal(saves, 1);
      assert.equal(state.unexpectedRequests, 0);
      result.actualState = state;
      result.frameChanged = !before.screenshot.equals(after.screenshot);
      assert.equal(result.frameChanged, true);
    } else {
      const loopAbort = new AbortController();
      let actionSettled;
      const settled = new Promise(resolve => { actionSettled = resolve; });
      const attempted = runComputerUseLoop({
        instructions: "Press Save note once.",
        provider: { id: "deterministic-control-conformance", version: "1", requiresFrame: true, capabilities,
          nextTurn: async () => ({ actions: [{ kind: "click", ...savePoint }], pendingSafetyChecks: [], done: false }) },
        executor: {
          stallRecovery: client.executor.stallRecovery,
          observe: () => client.executor.observe(),
          execute: async (action, signal) => {
            try { await client.executor.execute(action, signal); }
            catch (error) { executeError = { code: error.code, disposition: error.disposition }; throw error; }
            finally { actionSettled(); }
          }
        },
        persona: { id: "synthetic-control-fault", promptDigest: "control-conformance", traitsApplied: [] },
        redaction: defaultRedactionHooks, timeoutMs: 30000, now: Date.now, signal: loopAbort.signal,
        writeScreenshot: async (name, bytes) => { await writeFile(path.join(artifactDir, name), bytes); return name; }
      });
      if (mode.endsWith("during-preparation")) {
        await next("preparing");
        if (mode === "revoke-during-preparation") { child.send({ command: "revoke" }); await next("revoked"); }
        else loopAbort.abort();
      }
      else await next("mutation");
      const loop = await attempted;
      await bounded(settled, "action transport settlement");
      await writeFile(path.join(artifactDir, "trace.json"), JSON.stringify(loop, null, 2));
      assert.equal(loop.completionReason, "harness_error");
      if (mode === "cancel-during-preparation") assert.equal(loop.trace.stopCause, "harness_aborted");
      assert.match(JSON.stringify(loop), /uncertain/i);
      await assert.rejects(client.executor.execute({ kind: "click", ...savePoint }));
      child.send({ command: "snapshot" });
      const state = (await next("snapshot")).state;
      assert.equal(saves, mode === "lose-acknowledgment" ? 1 : 0);
      assert.equal(Number(state.saves), saves);
      assert.equal(state.unexpectedRequests, 0);
      assert.equal(executeError.disposition, "outcome_uncertain");
      result.actualState = state;
      result.error = executeError;
    }
    result.independentSaves = saves;
    result.requests = requests;
    result.behaviorPassed = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    client?.close();
    if (child.connected) child.send({ command: "stop" });
    let cleanupConfirmed = false;
    try {
      const closed = await next("closed");
      result.browserCloseAcknowledged = true;
      result.unexpectedPageRequestsObserved = closed.unexpectedRequests;
      const [code, signal] = await bounded(exit, "natural child exit", 15000);
      result.childExit = { code, signal };
      assert.equal(code, 0);
      assert.equal(signal, null);
      cleanupConfirmed = true;
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      try {
        const [code, signal] = await bounded(exit, "owned child exit after forced stop", 5000);
        result.childExit = { code, signal };
      } catch { result.childExitUnconfirmed = true; }
      result.cleanup = "unconfirmed";
      // Killing the direct controller does not establish that Chromium exited. Preserve its
      // private profile and socket directory rather than deleting possibly active state.
      result.retainedRecoveryDirectoryName = path.basename(owned);
      throw error;
    } finally {
      server.close(); app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
      if (cleanupConfirmed) {
        await rm(owned, { recursive: true, force: true });
        result.ownedDirectoryAbsent = await stat(owned).then(() => false, error => error.code === "ENOENT");
        result.cleanup = result.ownedDirectoryAbsent ? "confirmed" : "unconfirmed";
      }
      result.passed = result.behaviorPassed === true && result.cleanup === "confirmed";
      await writeFile(path.join(artifactDir, "fixture-stderr.txt"), childStderr);
      await writeFile(path.join(artifactDir, "result.json"), JSON.stringify(result, null, 2));
    }
  }
  assert.equal(result.ownedDirectoryAbsent, true);
  return result;
}
for (const mode of ["complete", "lose-acknowledgment", "revoke-during-preparation", "cancel-during-preparation"]) {
  cases.push(await runCase(mode));
  console.log(`browser-control proof: ${mode} passed`);
}
await writeFile(path.join(proof, "summary.json"), JSON.stringify({ scope: "real browser/control IPC conformance; page request interception only, no process-wide egress, managed VM or isolation qualification", cases }, null, 2));
await writeFile(path.join(proof, "index.html"), `<!doctype html><meta charset="utf-8"><title>Browser control proof</title><style>body{font:17px system-ui;max-width:1100px;margin:48px auto;padding:20px;background:#f3f4f0;color:#26342d}img{max-width:100%;border:1px solid #ccd4cb;border-radius:12px}a{color:#345844}section{margin:40px 0}</style><h1>Finite browser control</h1><p>Real Chromium, separate child controller, production client and dispatcher. Deterministic actor; no VM, model, privileged owner or network-isolation qualification.</p><p><a href="summary.json">Independent state and cleanup results</a></p><section><h2>Before / after</h2><img src="complete/before.png"><img src="complete/after.png"></section><p>Lost acknowledgment: exactly one save and no replay. Revocation during preparation: zero saves. Every child exited naturally and its socket/profile directory was removed.</p>`);
const hashes = {};
for (const name of ["complete/before.png", "complete/after.png"]) hashes[name] = createHash("sha256").update(await readFile(path.join(proof, name))).digest("hex");
await writeFile(path.join(proof, "screenshots.sha256.json"), JSON.stringify(hashes, null, 2));
console.log(`browser-control proof retained: ${path.relative(root, proof)}`);
