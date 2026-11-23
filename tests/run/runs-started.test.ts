import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listRuns } from "../../src/run/stored-runs.js";
import { writeFixtureRun } from "../helpers/run-fixtures.js";

// A run exists from its first status.json write, and its route writes run.json later: after the
// subject is provisioned, or at the first snapshot. `humanish run` names the run on its first
// line, so a listing asked for in that window has to show it.
describe("humanish runs lists a run from its first status record", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-runs-started-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("shows a started run with no run.json as running, with its mode and start time", async () => {
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    await writeFixtureRun(cwd, { runId: "r-started", state: "running", startedAt }, Date.now());

    const listed = await listRuns(cwd);

    expect(listed.runs).toEqual([
      {
        runId: "r-started",
        createdAt: startedAt,
        mode: "live",
        path: path.join(".humanish", "runs", "r-started"),
        display: { state: "running", label: "running", tone: "live" },
        livenessBasis: "heartbeat",
      },
    ]);
  });

  it("shows a started run whose heartbeat stopped as interrupted, and says the heartbeat is why", async () => {
    await writeFixtureRun(cwd, { runId: "r-stopped", state: "stale" }, Date.now());

    const [run] = (await listRuns(cwd)).runs;

    expect(run?.display).toEqual({ state: "interrupted", label: "interrupted", tone: "warn" });
    expect(run?.livenessBasis).toBe("stale-heartbeat");
  });

  it("shows a run that stopped before it wrote run.json as interrupted", async () => {
    // A run its route refused after it started: its process recorded that it left without a bundle.
    const runDir = await writeFixtureRun(cwd, { runId: "r-left", state: "running" }, Date.now());
    const file = path.join(runDir, "status.json");
    const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(
      file,
      JSON.stringify({ ...record, state: "interrupted", reason: "no-publish" }),
    );

    const [run] = (await listRuns(cwd)).runs;

    expect(run?.display).toEqual({ state: "interrupted", label: "interrupted", tone: "warn" });
    expect(run?.livenessBasis).toBe("status");
  });

  it("gives a finished record with no run.json no display: its evidence is gone", async () => {
    const runDir = await writeFixtureRun(cwd, {
      runId: "r-lost",
      state: "finished",
      verdict: "pass",
    });
    await rm(path.join(runDir, "run.json"));

    const [run] = (await listRuns(cwd)).runs;

    expect(run).toEqual({
      runId: "r-lost",
      createdAt: null,
      mode: null,
      path: path.join(".humanish", "runs", "r-lost"),
    });
  });

  it("gives a directory with neither record no display", async () => {
    await writeFixtureRun(cwd, { runId: "r-orphan", state: "orphan" });

    const [run] = (await listRuns(cwd)).runs;

    expect(run).toEqual({
      runId: "r-orphan",
      createdAt: null,
      mode: null,
      path: path.join(".humanish", "runs", "r-orphan"),
    });
  });

  it("says why a finished run reads as finished", async () => {
    await writeFixtureRun(cwd, { runId: "r-done", state: "finished", verdict: "pass" });

    const [run] = (await listRuns(cwd)).runs;

    expect(run?.display?.state).toBe("passed");
    expect(run?.livenessBasis).toBe("status");
  });
});
