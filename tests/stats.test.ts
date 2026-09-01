import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeStats, formatStatsHuman } from "../src/stats.js";
import { writeFixtureRuns } from "./helpers/run-fixtures.js";

const NOW = Date.parse("2026-09-01T20:00:00.000Z");

// "What has this month of studies cost" meant reading run.json files by hand (#472). The roll-up
// keeps the per-run rules: estimates stay estimates, an unknown cost is unknown and never zero,
// every rate carries its denominator.
describe("humanish stats", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-stats-"));
    await writeFixtureRuns(
      cwd,
      [
        { runId: "r1", labId: "try-live", mode: "live", state: "finished", startedAt: "2026-09-01T18:51:00.000Z", durationMs: 111_000, verdict: "pass", participants: { total: 1, reachedGoal: 1, reportedFriction: 0 }, estimatedCostUsd: 0.165 },
        { runId: "r2", labId: "try-live", mode: "live", state: "finished", startedAt: "2026-09-01T18:52:00.000Z", durationMs: 108_000, verdict: "pass", participants: { total: 1, reachedGoal: 1, reportedFriction: 1 }, estimatedCostUsd: 0.16 },
        // A subscription brain: the run has no price. It must count as unpriced, never as $0.
        { runId: "r3", labId: "try-live", mode: "live", state: "finished", startedAt: "2026-09-01T19:13:00.000Z", durationMs: 160_000, verdict: "blocked", participants: { total: 1, reachedGoal: 0, reportedFriction: 1 }, estimatedCostUsd: null },
        { runId: "r4", labId: "first-run", mode: "dry-run", state: "finished", startedAt: "2026-08-31T10:00:00.000Z", durationMs: 800, verdict: "pass", estimatedCostUsd: 0 },
        { runId: "r5", labId: "try-live", mode: "live", state: "running", startedAt: "2026-09-01T19:59:30.000Z" }
      ],
      NOW
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("sums only what has a price and counts the rest as unpriced", async () => {
    const result = await computeStats(cwd, { nowMs: NOW });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.totals.runs).toBe(5);
    expect(result.totals.live).toBe(4);
    expect(result.totals.dryRun).toBe(1);
    expect(result.totals.running).toBe(1);
    expect(result.totals.estimatedSpendUsd).toBe(0.325);
    // r3 (subscription, null) and r5 (still running, no cost yet).
    expect(result.totals.unpricedRuns).toBe(2);
    expect(result.totals.participants).toEqual({ total: 3, reachedGoal: 2, reportedFriction: 2 });
    expect(result.totals.verdicts).toEqual({ pass: 3, blocked: 1 });
    expect(result.note).toContain("never a provider charge");
  });

  it("gives every lab a pass rate with its denominator, and medians over the runs that have the number", async () => {
    const result = await computeStats(cwd, { nowMs: NOW });
    if (!result.ok) throw new Error(result.error.message);
    const tryLive = result.labs.find((row) => row.lab === "try-live");
    expect(tryLive).toMatchObject({ runs: 4, live: 4, judged: 3, passed: 2, passRate: 0.666667, durationSamples: 3, medianDurationMs: 111_000, costSamples: 2, medianCostUsd: 0.1625, unpricedRuns: 2 });
    const firstRun = result.labs.find((row) => row.lab === "first-run");
    // A dry run priced at $0 is priced; a dry run's duration is not a live duration.
    expect(firstRun).toMatchObject({ runs: 1, dryRun: 1, judged: 1, passed: 1, passRate: 1, durationSamples: 0, costSamples: 1, medianCostUsd: 0 });
    expect(firstRun?.medianDurationMs).toBeUndefined();
  });

  it("filters by lab and by since, and refuses a date it cannot read", async () => {
    const byLab = await computeStats(cwd, { lab: "first-run", nowMs: NOW });
    if (!byLab.ok) throw new Error(byLab.error.message);
    expect(byLab.totals.runs).toBe(1);
    expect(byLab.labs.map((row) => row.lab)).toEqual(["first-run"]);

    const since = await computeStats(cwd, { since: "2026-09-01T19:00:00Z", nowMs: NOW });
    if (!since.ok) throw new Error(since.error.message);
    expect(since.totals.runs).toBe(2);
    expect(since.days).toEqual([{ day: "2026-09-01", runs: 2, live: 2, estimatedSpendUsd: 0, unpricedRuns: 2 }]);

    const bad = await computeStats(cwd, { since: "last tuesday", nowMs: NOW });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("HUMANISH_STATS_INVALID_SINCE");
  });

  it("groups spend by day, newest last", async () => {
    const result = await computeStats(cwd, { nowMs: NOW });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.days.map((row) => row.day)).toEqual(["2026-08-31", "2026-09-01"]);
    expect(result.days[1]).toEqual({ day: "2026-09-01", runs: 4, live: 4, estimatedSpendUsd: 0.325, unpricedRuns: 2 });
  });

  it("reads as a short report, with the unpriced count next to the sum", async () => {
    const result = await computeStats(cwd, { nowMs: NOW });
    const text = formatStatsHuman(result);
    expect(text).toContain("runs: 5 (4 live, 1 dry-run, 1 running)");
    expect(text).toContain("estimated spend: $0.33 over 3 priced run(s); 2 unpriced (counted, not $0)");
    expect(text).toContain("participants: 2/3 reached the goal, 2 reported friction");
    expect(text).toContain("- try-live: 4 run(s), 4 live; 2/3 pass; median 1.9m over 3; median $0.16 over 2; 2 unpriced");
  });

  it("an empty project is an empty report, not an error", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "humanish-stats-empty-"));
    try {
      const result = await computeStats(empty, { nowMs: NOW });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.totals.runs).toBe(0);
      expect(result.labs).toEqual([]);
      expect(formatStatsHuman(result)).toContain("runs: 0");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
