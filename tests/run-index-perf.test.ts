import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunIndexCache, readRunIndex } from "../src/run-index.js";
import { listRuns } from "../src/run.js";
import { writeFixtureRun } from "./helpers/run-fixtures.js";

// Why this module exists at all, as an executable claim.
//
// `listRuns` walks every run tree — screenshots included — and parses every bundle. That is the
// right shape for a command that prints once and exits, and the wrong shape for a surface that
// refreshes on a cadence over SSH, where the same work repeats every tick.
//
// These assertions are RELATIVE and generate their own tree, so they mean the same thing on a
// laptop, in CI, and on a loaded machine. Absolute millisecond thresholds would only be measuring
// the runner. Measured on the real 25-run/270MB project tree when this landed:
// listRuns 167ms · index cold 16ms · index warm 2.8ms.

const RUN_COUNT = 25;
const SCREENSHOTS_PER_RUN = 40;

describe("run index cost, measured against the existing listing", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-perf-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("reads the same runs for a fraction of the work, and less again when cached", async () => {
    // A tree shaped like a real project: bundles to parse and screenshot files to walk.
    const start = Date.parse("2026-08-19T09:00:00.000Z");
    for (let index = 0; index < RUN_COUNT; index += 1) {
      const runId = `cua-2026-08-19T09-${String(index).padStart(2, "0")}-00-000Z-fixture`;
      const runDir = await writeFixtureRun(
        cwd,
        {
          runId,
          labId: `lab-${index % 4}`,
          state: "finished",
          startedAt: new Date(start + index * 60_000).toISOString(),
          durationMs: 120_000,
          verdict: "pass",
          participants: { total: 1, reachedGoal: 1 },
          estimatedCostUsd: 0.34
        },
        Date.parse("2026-08-19T10:00:00.000Z")
      );
      const shotsDir = path.join(runDir, "screenshots");
      await mkdir(shotsDir, { recursive: true });
      await Promise.all(
        Array.from({ length: SCREENSHOTS_PER_RUN }, (_, shot) =>
          writeFile(path.join(shotsDir, `step-${String(shot).padStart(3, "0")}.png`), "not-a-real-png")
        )
      );
    }

    // Warm the page cache for both readers, so this compares algorithms and not first-touch I/O.
    await listRuns(cwd);
    await readRunIndex(cwd);

    // Best of five for each reader. A single sample at the millisecond scale is one GC pause away
    // from inverting warm and cold (CI on 2026-09-03: warm 4.6 ms, cold 3.2 ms, #606); the minimum
    // is the algorithm's cost, the rest is the runner's.
    const bestOf = async <T,>(reader: () => Promise<T>, samples = 5): Promise<{ result: T; ms: number }> => {
      let best: { result: T; ms: number } | undefined;
      for (let sample = 0; sample < samples; sample += 1) {
        const started = performance.now();
        const result = await reader();
        const ms = performance.now() - started;
        if (best === undefined || ms < best.ms) best = { result, ms };
      }
      return best!;
    };

    const { result: listed, ms: listRunsMs } = await bestOf(() => listRuns(cwd));
    const { result: cold, ms: indexColdMs } = await bestOf(() => readRunIndex(cwd));

    const cache = new RunIndexCache();
    await readRunIndex(cwd, { cache });
    const { result: warm, ms: indexWarmMs } = await bestOf(() => readRunIndex(cwd, { cache }));

    // Same runs — cheaper is only worth anything if it is also complete.
    expect(listed.ok).toBe(true);
    expect(listed.runs).toHaveLength(RUN_COUNT);
    expect(cold.runs).toHaveLength(RUN_COUNT);
    expect(warm.runs).toHaveLength(RUN_COUNT);
    expect(cold.unreadable).toEqual([]);

    // The gate. Generous multiples on purpose: this must fail on a real regression (the index
    // starting to parse bundles, or the cache silently not hitting) and never on a slow runner.
    expect(indexColdMs).toBeLessThan(listRunsMs / 2);
    expect(indexWarmMs).toBeLessThan(listRunsMs / 4);
    expect(indexWarmMs).toBeLessThanOrEqual(indexColdMs);
  });
});
