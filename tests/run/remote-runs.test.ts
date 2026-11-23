import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { readRunIndex, RunIndexCache } from "../../src/run/run-index.js";
import { computeStats } from "../../src/run/stats.js";
import { listRuns } from "../../src/run/stored-runs.js";
import { writeFixtureRun } from "../helpers/run-fixtures.js";

// A remote run executes in a runner sandbox, and until its copy back its directory here holds only
// the runner's receipt and remote.json. Each surface that lists runs reads that record.

const STARTED = "2026-11-23T10:00:00.000Z";
const runPath = (runId: string) => path.join(".humanish", "runs", runId);

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-remote-runs-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function reclaimedHere(runId: string): Promise<void> {
  await writeFile(
    path.join(cwd, ".humanish", "runs", runId, "reclaim-receipt.json"),
    JSON.stringify({ schema: "humanish.reclaim-result.v1", runId, state: "clean", outcomes: [] }),
  );
}

describe("humanish runs lists a remote run that is on its runner", () => {
  it("shows it as a live run that is running, from its remote record", async () => {
    await writeFixtureRun(
      cwd,
      { runId: "cua-remote", state: "remote", startedAt: STARTED },
      Date.now(),
    );

    expect((await listRuns(cwd)).runs).toEqual([
      {
        runId: "cua-remote",
        createdAt: STARTED,
        mode: "live",
        path: runPath("cua-remote"),
        display: { state: "running", label: "running", tone: "live" },
        livenessBasis: "remote",
      },
    ]);
  });

  it("prints it as a live run that is running", async () => {
    await writeFixtureRun(
      cwd,
      { runId: "cua-remote", state: "remote", startedAt: STARTED },
      Date.now(),
    );
    const out: string[] = [];
    const program = createProgram({
      writeOut: (text) => out.push(text),
      writeErr: () => undefined,
      setExitCode: () => undefined,
    });

    await program.parseAsync(["node", "humanish", "runs", "--cwd", cwd], { from: "node" });

    expect(out.join("")).toMatch(
      /^- cua-remote live running \d+ \w+ 2026-11-23T10:00:00\.000Z \.humanish\/runs\/cua-remote$/m,
    );
  });

  it("shows it as interrupted once its runner's deadline has passed", async () => {
    const deadline = new Date(Date.now() - 60_000).toISOString();
    await writeFixtureRun(cwd, { runId: "cua-expired", state: "remote", deadline }, Date.now());

    const [run] = (await listRuns(cwd)).runs;

    expect(run?.display).toEqual({ state: "interrupted", label: "interrupted", tone: "warn" });
    expect(run?.livenessBasis).toBe("remote");
  });

  it("shows it as interrupted once it was reclaimed here", async () => {
    await writeFixtureRun(cwd, { runId: "cua-reclaimed", state: "remote" }, Date.now());
    await reclaimedHere("cua-reclaimed");

    const [run] = (await listRuns(cwd)).runs;

    expect(run?.display).toEqual({ state: "interrupted", label: "interrupted", tone: "warn" });
    expect(run?.livenessBasis).toBe("remote");
  });

  it("lists a local run that left only receipts as it did before, with no display", async () => {
    await writeFixtureRun(cwd, { runId: "r-orphan", state: "orphan" }, Date.now());

    expect((await listRuns(cwd)).runs).toEqual([
      { runId: "r-orphan", createdAt: null, mode: null, path: runPath("r-orphan") },
    ]);
  });

  it("reads a run whose run.json has arrived by its own files, whatever remote.json says", async () => {
    // A copy that stopped partway leaves the record pending beside the run's small files.
    const runDir = await writeFixtureRun(cwd, { runId: "cua-partway", state: "finished" });
    await writeFile(
      path.join(runDir, "remote.json"),
      JSON.stringify({ schema: "humanish.remote-run.v1", provider: "e2b", copyPending: true }),
    );

    const [run] = (await listRuns(cwd)).runs;
    const [entry] = (await readRunIndex(cwd)).runs;

    expect([run?.display?.state, run?.livenessBasis]).toEqual(["passed", "status"]);
    expect([entry?.derivedFrom, entry?.liveness]).toEqual(["status", "finished"]);
  });
});

// The run index is what `humanish stats` and the TUI list runs from.
describe("the run index reads a remote run that is on its runner", () => {
  const NOW = Date.parse("2026-11-23T10:30:00.000Z");
  const DEADLINE = "2026-11-23T11:00:00.000Z";

  it("as a live run that is running, from its remote record", async () => {
    await writeFixtureRun(cwd, {
      runId: "cua-remote",
      state: "remote",
      startedAt: STARTED,
      deadline: DEADLINE,
    });

    expect((await readRunIndex(cwd, { nowMs: NOW })).runs).toEqual([
      {
        runId: "cua-remote",
        derivedFrom: "remote",
        liveness: "running",
        mode: "live",
        startedAt: STARTED,
      },
    ]);
  });

  it("as interrupted from its runner's deadline, and once it was reclaimed here", async () => {
    await writeFixtureRun(cwd, { runId: "cua-remote", state: "remote", deadline: DEADLINE });
    const cache = new RunIndexCache();

    const before = await readRunIndex(cwd, { nowMs: NOW, cache });
    const after = await readRunIndex(cwd, { nowMs: Date.parse(DEADLINE), cache });

    expect(before.runs.map((run) => run.liveness)).toEqual(["running"]);
    expect(after.runs.map((run) => run.liveness)).toEqual(["interrupted"]);

    await reclaimedHere("cua-remote");
    const reclaimed = await readRunIndex(cwd, { nowMs: NOW, cache });
    expect(reclaimed.runs.map((run) => [run.derivedFrom, run.liveness])).toEqual([
      ["remote", "interrupted"],
    ]);
  });

  it("reads a local run that left only receipts as it did before", async () => {
    await writeFixtureRun(cwd, { runId: "r-orphan", state: "orphan" });

    expect((await readRunIndex(cwd, { nowMs: NOW })).runs).toEqual([
      { runId: "r-orphan", derivedFrom: "directory", liveness: "interrupted" },
    ]);
  });

  it("is counted by stats as one live run that is running, and no interrupted outcome", async () => {
    await writeFixtureRun(cwd, { runId: "cua-remote", state: "remote", deadline: DEADLINE });

    const stats = await computeStats(cwd, { nowMs: NOW });
    if (!stats.ok) throw new Error(stats.error.message);

    expect(stats.totals).toMatchObject({ runs: 1, live: 1, running: 1 });
    expect(stats.totals.outcomes).toEqual({ running: 1 });
  });
});
