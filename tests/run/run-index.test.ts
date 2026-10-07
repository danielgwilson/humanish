import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunIndexCache, readRunIndex } from "../../src/run/run-index.js";
import { RUN_STATUS_SCHEMA } from "../../src/run/status.js";
import { writeFixtureRun, writeFixtureRuns } from "../helpers/run-fixtures.js";

const NOW = Date.parse("2026-08-19T10:05:00.000Z");

describe("run index: list and classify without parsing bundles", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-index-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads the status record first and classifies each run from its records", async () => {
    await writeFixtureRuns(
      cwd,
      [
        {
          runId: "r-live",
          labId: "signup",
          state: "running",
          startedAt: "2026-08-19T10:04:00.000Z",
        },
        {
          runId: "r-stale",
          labId: "signup",
          state: "stale",
          startedAt: "2026-08-19T09:00:00.000Z",
        },
        {
          runId: "r-done",
          labId: "diagram",
          state: "finished",
          startedAt: "2026-08-19T09:30:00.000Z",
          durationMs: 109_000,
          verdict: "pass",
          participants: { total: 1, reachedGoal: 1 },
          estimatedCostUsd: 0.34,
        },
      ],
      NOW,
    );

    const index = await readRunIndex(cwd, { nowMs: NOW });
    const byId = new Map(index.runs.map((run) => [run.runId, run]));

    expect(byId.get("r-live")?.liveness).toBe("running");
    expect(byId.get("r-live")?.derivedFrom).toBe("status");
    // A `running` record that stopped being touched is interrupted: the shape a dropped
    // connection leaves, never quietly reported as still working.
    expect(byId.get("r-stale")?.liveness).toBe("interrupted");
    const done = byId.get("r-done");
    expect(done?.liveness).toBe("finished");
    expect(done?.verdict).toBe("pass");
    expect(done?.estimatedCostUsd).toBe(0.34);
    expect(done?.durationMs).toBe(109_000);
    expect(done?.study?.id).toBe("diagram");
    // Newest first.
    expect(index.runs[0]?.runId).toBe("r-live");
  });

  it("falls back to the bundle for pre-contract runs, and reads the legacy lab convention", async () => {
    await writeFixtureRun(
      cwd,
      { runId: "r-old", labId: "legacy-lab", state: "legacy-bundle", verdict: "fail" },
      NOW,
    );
    const index = await readRunIndex(cwd, { nowMs: NOW });
    const entry = index.runs.find((run) => run.runId === "r-old");
    expect(entry?.derivedFrom).toBe("bundle");
    // A bundle on disk means the run reached its final write, whatever the verdict says.
    expect(entry?.liveness).toBe("finished");
    expect(entry?.verdict).toBe("fail");
    expect(entry?.study?.id).toBe("legacy-lab");
  });

  it("an in-progress bundle with no status record is interrupted, never finished", async () => {
    // A live run flushes an in-progress bundle as it goes, and that bundle marks its simulations
    // `running`. Reaching the bundle branch means there was no status record to judge freshness
    // from, so the run reads as "it started and nothing says it finished".
    const runDir = path.join(cwd, ".humanish", "runs", "r-inflight");
    await writeFixtureRun(cwd, { runId: "r-inflight", state: "orphan" }, NOW);
    await writeFile(
      path.join(runDir, "run.json"),
      JSON.stringify({
        schema: "humanish.run-bundle.v1",
        runId: "r-inflight",
        mode: "live",
        persona: { source: "lab:signup" },
        simulations: [{ id: "sim-001", status: "running" }],
      }),
      "utf8",
    );
    const index = await readRunIndex(cwd, { nowMs: NOW });
    const entry = index.runs.find((run) => run.runId === "r-inflight");
    expect(entry?.derivedFrom).toBe("bundle");
    expect(entry?.liveness).toBe("interrupted");
  });

  it("a run with neither record nor bundle is interrupted, not hidden", async () => {
    await writeFixtureRun(cwd, { runId: "r-orphan", state: "orphan" }, NOW);
    const index = await readRunIndex(cwd, { nowMs: NOW });
    const entry = index.runs.find((run) => run.runId === "r-orphan");
    expect(entry?.liveness).toBe("interrupted");
    expect(entry?.derivedFrom).toBe("directory");
    expect(index.unreadable).toEqual([]);
  });

  it("a run with no lab attribution stays lab-less rather than guessed", async () => {
    await writeFixtureRun(cwd, { runId: "r-nolab", state: "finished", verdict: "pass" }, NOW);
    const index = await readRunIndex(cwd, { nowMs: NOW });
    expect(index.runs[0]?.study).toBeUndefined();
  });

  it("one malformed run degrades that run, never the listing", async () => {
    await writeFixtureRun(
      cwd,
      { runId: "r-good", labId: "x", state: "finished", verdict: "pass" },
      NOW,
    );
    const badDir = path.join(cwd, ".humanish", "runs", "r-bad");
    await writeFixtureRun(cwd, { runId: "r-bad", state: "orphan" }, NOW);
    await writeFile(path.join(badDir, "run.json"), "{ not json", "utf8");

    const index = await readRunIndex(cwd, { nowMs: NOW });
    expect(index.runs.some((run) => run.runId === "r-good")).toBe(true);
    expect(index.unreadable).toEqual(["r-bad"]);
  });

  it("an empty project is an ordinary empty state, not a failure", async () => {
    const index = await readRunIndex(cwd, { nowMs: NOW });
    expect(index.runs).toEqual([]);
    expect(index.unreadable).toEqual([]);
  });

  it("the cache skips unchanged runs but never freezes liveness", async () => {
    await writeFixtureRun(cwd, { runId: "r-live", labId: "x", state: "running" }, NOW);
    const cache = new RunIndexCache();
    const first = await readRunIndex(cwd, { cache, nowMs: NOW });
    expect(first.runs[0]?.liveness).toBe("running");
    expect(cache.size).toBe(1);

    // Same file, much later: the cached facts still apply, but the run has gone stale and must
    // now read as interrupted: liveness is time-dependent and is recomputed on every read.
    const later = await readRunIndex(cwd, { cache, nowMs: NOW + 600_000 });
    expect(later.runs[0]?.liveness).toBe("interrupted");
  });

  it("a finished bundle wins when only run.json changes after a cached live read", async () => {
    await writeFixtureRun(cwd, { runId: "r-between", state: "running" }, NOW);
    const cache = new RunIndexCache();
    expect((await readRunIndex(cwd, { cache, nowMs: NOW })).runs[0]?.liveness).toBe("running");
    await writeFile(
      path.join(cwd, ".humanish/runs/r-between/run.json"),
      JSON.stringify({
        runId: "r-between",
        mode: "live",
        review: { verdict: "pass" },
        simulations: [{ status: "running" }],
        outcome: { state: "finished", ok: true, execution: { succeeded: true, failures: [] } },
      }),
    );
    for (const nowMs of [NOW, NOW + 600_000]) {
      expect((await readRunIndex(cwd, { cache, nowMs })).runs[0]).toMatchObject({
        liveness: "finished",
        verdict: "pass",
        ok: true,
      });
    }
  });

  it("the cache keeps an interrupted record interrupted", async () => {
    const runDir = path.join(cwd, ".humanish", "runs", "r-stopped");
    await mkdir(runDir, { recursive: true });
    const at = new Date(NOW - 1_000).toISOString();
    await writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({
        schema: RUN_STATUS_SCHEMA,
        runId: "r-stopped",
        state: "interrupted",
        signal: "SIGTERM",
        mode: "live",
        pid: 4242,
        startedAt: new Date(NOW - 60_000).toISOString(),
        updatedAt: at,
        completedAt: at,
      }),
    );
    const cache = new RunIndexCache();
    for (let read = 0; read < 2; read += 1) {
      const index = await readRunIndex(cwd, { cache, nowMs: NOW });
      expect(index.runs[0]?.liveness).toBe("interrupted");
    }
  });

  it("the cache drops runs that no longer exist", async () => {
    await writeFixtureRuns(
      cwd,
      [
        { runId: "r-1", labId: "x", state: "finished", verdict: "pass" },
        { runId: "r-2", labId: "x", state: "finished", verdict: "pass" },
      ],
      NOW,
    );
    const cache = new RunIndexCache();
    await readRunIndex(cwd, { cache, nowMs: NOW });
    expect(cache.size).toBe(2);
    await rm(path.join(cwd, ".humanish", "runs", "r-2"), { recursive: true, force: true });
    await readRunIndex(cwd, { cache, nowMs: NOW });
    expect(cache.size).toBe(1);
  });

  it("limit caps what is returned without hiding that the rest exist", async () => {
    await writeFixtureRuns(
      cwd,
      Array.from({ length: 5 }, (_, index) => ({
        runId: `r-${index}`,
        labId: "x",
        state: "finished" as const,
        startedAt: new Date(Date.parse("2026-08-19T09:00:00.000Z") + index * 60_000).toISOString(),
        verdict: "pass",
      })),
      NOW,
    );
    const index = await readRunIndex(cwd, { nowMs: NOW, limit: 2 });
    expect(index.runs).toHaveLength(2);
    // Newest first, so the cap keeps the most recent.
    expect(index.runs[0]?.runId).toBe("r-4");
  });
});
