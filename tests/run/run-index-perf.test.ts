import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RunIndexCache, readRunIndex } from "../../src/run/run-index.js";
import { listRuns } from "../../src/run/stored-runs.js";
import { writeFixtureRun } from "../helpers/run-fixtures.js";

// Why this module exists at all, as an executable claim.
//
// `listRuns` walks every run tree (screenshots included) and parses every bundle. That is the
// right shape for a command that prints once and exits, and the wrong shape for a surface that
// refreshes on a cadence over SSH, where the same work repeats every tick.
//
// The bounds are ratios between readers measured in this test, on a tree it generates, so they
// mean the same thing on a laptop, in CI, and on a loaded machine. Measured on the real
// 25-run/270MB project tree when this landed: listRuns 167ms · index cold 16ms · index warm 2.8ms.

const RUN_COUNT = 25;
const SCREENSHOTS_PER_RUN = 40;
const ROUNDS = 7;

/** The CPU time, user and system, that this process spends on one read, in milliseconds. */
async function cpuMs(read: () => Promise<unknown>): Promise<number> {
  const before = process.cpuUsage();
  await read();
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
}

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
          estimatedCostUsd: 0.34,
        },
        Date.parse("2026-08-19T10:00:00.000Z"),
      );
      const shotsDir = path.join(runDir, "screenshots");
      await mkdir(shotsDir, { recursive: true });
      await Promise.all(
        Array.from({ length: SCREENSHOTS_PER_RUN }, (_, shot) =>
          writeFile(
            path.join(shotsDir, `step-${String(shot).padStart(3, "0")}.png`),
            "not-a-real-png",
          ),
        ),
      );
    }

    // Same runs: cheaper is only worth anything if it is also complete. These reads also warm the
    // page cache and the index cache, so the rounds below compare the readers' own work.
    const cache = new RunIndexCache();
    const listed = await listRuns(cwd);
    const cold = await readRunIndex(cwd);
    const warm = await readRunIndex(cwd, { cache });
    expect(listed.ok).toBe(true);
    expect(listed.runs).toHaveLength(RUN_COUNT);
    expect(cold.runs).toHaveLength(RUN_COUNT);
    expect(warm.runs).toHaveLength(RUN_COUNT);
    expect(cold.unreadable).toEqual([]);

    // Each round reads with all three, so a change in the runner's load lands on all three alike,
    // and each reader keeps its fastest round. Work is this process's CPU time: wall clock also
    // counts the time a read waits for a core, which on a loaded runner can exceed the read itself.
    const fastest = { listing: Infinity, cold: Infinity, warm: Infinity };
    for (let round = 0; round < ROUNDS; round += 1) {
      fastest.listing = Math.min(fastest.listing, await cpuMs(() => listRuns(cwd)));
      fastest.cold = Math.min(fastest.cold, await cpuMs(() => readRunIndex(cwd)));
      fastest.warm = Math.min(fastest.warm, await cpuMs(() => readRunIndex(cwd, { cache })));
    }
    const ms = (value: number) => `${value.toFixed(2)} ms`;
    const work = `listing ${ms(fastest.listing)}, cold index ${ms(fastest.cold)}, warm index ${ms(fastest.warm)}`;

    // The gate. On this tree the index measured about 0.1 of the listing's work and the warm index
    // about 0.5 of the cold. An index that walks every run tree measured 0.44 on the first, and a
    // cache that never hits measured 0.87 to 1.05 on the second.
    expect(fastest.cold / fastest.listing, work).toBeLessThan(0.25);
    expect(fastest.warm / fastest.cold, work).toBeLessThan(0.7);
  });
});
