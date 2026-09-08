import { cp, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildObserverData, type ObserverData } from "../src/observer-data.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../src/observer-serve.js";
import { runDryRun } from "../src/run.js";
import { RUN_STATUS_SCHEMA, RUN_STATUS_STALE_MS } from "../src/run-status.js";

const roots: string[] = [];
const servers: ServeLibraryServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "humanish-observer-runtime-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  const runId = "runtime-study";
  expect((await runDryRun({ cwd, dryRun: true, runId })).ok).toBe(true);
  const runRoot = path.join(cwd, ".humanish", "runs", runId);
  const bundlePath = path.join(runRoot, "run.json");
  const before = await readFile(bundlePath, "utf8");
  const started = await serveObserverLibrary(cwd, { port: 0, safe: false, expose: false, edgeAuthed: false });
  if (!started.ok) throw new Error(started.error.message);
  servers.push(started.server);
  const url = new URL(`_humanish/runs/${runId}/observer/observer-data.json`, started.server.url).href;
  const statusPath = path.join(runRoot, "status.json");
  const status = (overrides: Record<string, unknown> = {}) => ({
    schema: RUN_STATUS_SCHEMA, runId, state: "running", mode: "dry-run", pid: 999999,
    startedAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date().toISOString(), ...overrides
  });
  const read = async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    return response.json() as Promise<ObserverData>;
  };
  return { root, runId, runRoot, statusPath, status, read, before, bundlePath };
}

describe("served Observer runtime status", () => {
  it("observes running, uncertain, and finalized states without changing evidence or revealing identifiers", async () => {
    const { statusPath, status, read, before, bundlePath } = await fixture();
    await writeFile(statusPath, JSON.stringify(status()));
    const running = await read();
    expect(running.runtime).toEqual({ state: "running", source: "local-run-status", observedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(running.runtime!.observedAt))).toBe(true);
    expect(running.run.status).toBe(JSON.parse(before).review.verdict);
    await writeFile(statusPath, JSON.stringify(status({ updatedAt: new Date(Date.now() - RUN_STATUS_STALE_MS - 1000).toISOString() })));
    expect((await read()).runtime?.state).toBe("unknown");
    await writeFile(statusPath, JSON.stringify(status({ state: "finished", completedAt: new Date().toISOString() })));
    const finished = await read();
    expect(finished.runtime?.state).toBe("finished");
    expect(finished.run).toEqual(running.run);
    expect(finished.streams).toEqual(running.streams);
    expect(await readFile(bundlePath, "utf8")).toBe(before);
    expect(buildObserverData(JSON.parse(before)).runtime).toBeUndefined();
  });

  it("omits absent, malformed, mismatched, and linked status records", async () => {
    const { root, statusPath, status, read } = await fixture();
    await rm(statusPath, { force: true });
    expect((await read()).runtime).toBeUndefined();
    for (const text of ["{", "null", JSON.stringify(status({ runId: "other-study" })), JSON.stringify(status({ mode: "live" })), JSON.stringify({ state: "finished" })]) {
      await writeFile(statusPath, text);
      expect((await read()).runtime).toBeUndefined();
    }
    const outside = path.join(root, "outside-status.json");
    await writeFile(outside, JSON.stringify(status()));
    await rm(statusPath);
    await symlink(outside, statusPath);
    expect((await read()).runtime).toBeUndefined();
    await rm(statusPath);
    await link(outside, statusPath);
    expect((await read()).runtime).toBeUndefined();
  });

  it("treats future, invalid, and out-of-order timestamps as uncertain, never live", async () => {
    const { statusPath, status, read } = await fixture();
    for (const overrides of [
      { updatedAt: "not-a-date" },
      { startedAt: new Date(Date.now() + 60_000).toISOString() },
      { updatedAt: new Date(Date.now() + 60_000).toISOString() },
      { state: "finished", updatedAt: "not-a-date" }
    ]) {
      await writeFile(statusPath, JSON.stringify(status(overrides)));
      expect((await read()).runtime?.state).toBe("unknown");
    }
  });

  it("does not replay a persisted runtime assertion when falling back to observer-data.json", async () => {
    const { runRoot, statusPath, read, before, bundlePath } = await fixture();
    const data = { ...buildObserverData(JSON.parse(before)), runtime: { state: "running", observedAt: new Date().toISOString(), source: "local-run-status" } };
    await writeFile(path.join(runRoot, "observer", "observer-data.json"), JSON.stringify(data));
    await rm(statusPath, { force: true });
    await writeFile(bundlePath, "{");
    expect((await read()).runtime).toBeUndefined();
  });
});
