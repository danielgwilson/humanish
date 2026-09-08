import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createTuiObserverSession, type TuiObserverSession } from "../src/tui-actions.js";
import { runDryRun } from "../src/run.js";
import type { ObserverData } from "../src/observer-data.js";

const roots: string[] = [];
const sessions: TuiObserverSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "humanish-tui-observer-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  const runId = "first-run";
  expect((await runDryRun({ cwd, dryRun: true, runId })).ok).toBe(true);
  const opened: string[] = [];
  const session = createTuiObserverSession(cwd, {
    openTarget: (url) => { opened.push(url); return { opened: false, warning: "No desktop opener available." }; }
  });
  sessions.push(session);
  const observerPath = path.join(".humanish", "runs", runId, "observer", "index.html");
  return { root, cwd, runId, opened, session, observerPath };
}

function rawRequest(url: string, requestPath: string, options: { host?: string; method?: string } = {}) {
  const parsed = new URL(url);
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: requestPath,
      method: options.method ?? "GET", headers: options.host ? { host: options.host } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("TUI Observer evidence session", () => {
  it("serves without a static index and follows newly written evidence over real HTTP", async () => {
    const { cwd, runId, session, opened, observerPath } = await fixture();
    await rm(path.join(cwd, observerPath), { force: true });
    const action = await session.open(cwd, observerPath);
    expect(action.ok).toBe(true);
    expect(action.message).toContain("keep this TUI open");
    expect(action.message).toContain("follows saved captures");
    expect(action.message).toContain(opened[0]);
    expect(action.message).toContain("No desktop opener");
    const page = await fetch(opened[0]!);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="observer-data"');
    const dataUrl = new URL("observer-data.json", opened[0]!).href;
    const before = await (await fetch(dataUrl)).json() as ObserverData;
    const bundlePath = path.join(cwd, ".humanish", "runs", runId, "run.json");
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    bundle.review.summary = "Newly saved synthetic review.";
    bundle.review.verdict = "warn";
    await writeFile(bundlePath, JSON.stringify(bundle));
    const after = await (await fetch(dataUrl)).json() as ObserverData;
    expect(after.run.status).toBe("warn");
    expect(after.run.status).not.toBe(before.run.status);
    expect(await readFile(bundlePath, "utf8")).toBe(JSON.stringify(bundle));
  });

  it("reuses one listener for simultaneous opens and additional runs, then closes it idempotently", async () => {
    const { cwd, session, opened, observerPath } = await fixture();
    await Promise.all([session.open(cwd, observerPath), session.open(cwd, observerPath)]);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toBe(opened[1]);
    expect((await runDryRun({ cwd, dryRun: true, runId: "second-run" })).ok).toBe(true);
    const action = await session.open(cwd, ".humanish/runs/second-run/observer/index.html");
    expect(action.ok).toBe(true);
    expect(new URL(opened[2]!).origin).toBe(new URL(opened[0]!).origin);
    expect((await (await fetch(new URL("observer-data.json", opened[2]!))).json() as ObserverData).run.runId).toBe("second-run");
    await Promise.all([session.close(), session.close()]);
    await expect(fetch(opened[0]!)).rejects.toThrow();
    expect((await session.open(cwd, observerPath)).ok).toBe(false);
  });

  it("rejects a second project, foreign files, traversal, and symlinked run evidence", async () => {
    const { root, cwd, session, opened, observerPath } = await fixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "index.html"), "synthetic outside marker");
    for (const candidate of [outside, "../outside/index.html", ".humanish/runs/first-run/../../../../outside/index.html", "https://example.com/index.html", ".humanish/runs/first-run/run.json"]) {
      expect((await session.open(cwd, candidate)).ok).toBe(false);
    }
    expect((await session.open(outside, observerPath)).ok).toBe(false);
    await symlink(outside, path.join(cwd, ".humanish", "runs", "linked-run"), "dir");
    expect((await session.open(cwd, ".humanish/runs/linked-run/observer/index.html")).ok).toBe(false);
    await symlink(path.join(outside, "index.html"), path.join(cwd, ".humanish", "runs", "first-run", "linked.html"));
    expect((await session.open(cwd, observerPath)).ok).toBe(false);
    expect(opened).toEqual([]);
  });

  it("retains Host/method/path guards and refuses a replaced run directory", async () => {
    const { cwd, runId, session, opened, observerPath } = await fixture();
    expect((await session.open(cwd, observerPath)).ok).toBe(true);
    const url = opened[0]!;
    const response = await rawRequest(url, new URL(url).pathname);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect((await rawRequest(url, "/", { host: "attacker.example" })).status).toBe(421);
    expect((await rawRequest(url, "/", { method: "POST" })).status).toBe(405);
    expect((await rawRequest(url, "/_humanish/runs/%2e%2e%2foutside/observer/index.html")).status).toBe(404);
    expect((await rawRequest(url, "/_humanish/runs/first-run/%2e%2e/%2e%2e/%2e%2e/package.json")).status).toBe(404);
    const runRoot = path.join(cwd, ".humanish", "runs", runId);
    await rename(runRoot, `${runRoot}-original`);
    await symlink(`${runRoot}-original`, runRoot, "dir");
    expect((await fetch(url)).status).toBe(404);
  });

  it("closing during an open prevents a listener or browser from surviving the session", async () => {
    const { cwd, session, opened, observerPath } = await fixture();
    const opening = session.open(cwd, observerPath);
    await session.close();
    expect((await opening).ok).toBe(false);
    expect(opened).toEqual([]);
  });
});

it("a missing desktop opener does not crash the real Node process", async () => {
  const moduleUrl = pathToFileURL(path.resolve("src/observer.ts")).href;
  const tsxUrl = import.meta.resolve("tsx");
  const execution = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxUrl, "--input-type=module", "-e", `import { openTarget } from ${JSON.stringify(moduleUrl)}; openTarget("http://127.0.0.1:1/observer/index.html"); setTimeout(() => {}, 100);`], {
      env: { ...process.env, PATH: "", HUMANISH_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
  expect(execution).toEqual({ code: 0, stderr: "" });
});
