import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeStats, formatStatsHuman } from "../../src/run/stats.js";
import { writeFixtureRuns } from "../helpers/run-fixtures.js";

const NOW = Date.parse("2026-09-01T20:00:00.000Z");

// "What has this month of studies cost" meant reading run.json files by hand. The roll-up
// keeps the per-run rules: estimates stay estimates, an unknown cost is unknown and never zero,
// every rate carries its denominator.
describe("humanish stats", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-stats-"));
    await writeFixtureRuns(
      cwd,
      [
        {
          runId: "r1",
          labId: "try-live",
          mode: "live",
          state: "finished",
          startedAt: "2026-09-01T18:51:00.000Z",
          durationMs: 111_000,
          verdict: "pass",
          participants: { total: 1, reachedGoal: 1, reportedFriction: 0 },
          estimatedCostUsd: 0.165,
        },
        {
          runId: "r2",
          labId: "try-live",
          mode: "live",
          state: "finished",
          startedAt: "2026-09-01T18:52:00.000Z",
          durationMs: 108_000,
          verdict: "pass",
          participants: { total: 1, reachedGoal: 1, reportedFriction: 1 },
          estimatedCostUsd: 0.16,
        },
        // A subscription brain: the run has no price. It must count as unpriced, never as $0.
        {
          runId: "r3",
          labId: "try-live",
          mode: "live",
          state: "finished",
          startedAt: "2026-09-01T19:13:00.000Z",
          durationMs: 160_000,
          verdict: "blocked",
          participants: { total: 1, reachedGoal: 0, reportedFriction: 1 },
          estimatedCostUsd: null,
        },
        {
          runId: "r4",
          labId: "first-run",
          mode: "dry-run",
          state: "finished",
          startedAt: "2026-08-31T10:00:00.000Z",
          durationMs: 800,
          verdict: "pass",
          estimatedCostUsd: 0,
        },
        {
          runId: "r5",
          labId: "try-live",
          mode: "live",
          state: "running",
          startedAt: "2026-09-01T19:59:30.000Z",
        },
      ],
      NOW,
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
    expect(result.note).toContain("never provider charges");
  });

  it("gives every lab a pass rate with its denominator, and medians over the runs that have the number", async () => {
    const result = await computeStats(cwd, { nowMs: NOW });
    if (!result.ok) throw new Error(result.error.message);
    const tryLive = result.studies.find((row) => row.study === "try-live");
    expect(tryLive).toMatchObject({
      runs: 4,
      live: 4,
      judged: 3,
      passed: 2,
      passRate: 0.666667,
      durationSamples: 3,
      medianDurationMs: 111_000,
      costSamples: 2,
      medianCostUsd: 0.1625,
      unpricedRuns: 2,
    });
    const firstRun = result.studies.find((row) => row.study === "first-run");
    // A dry run priced at $0 is priced; a dry run's duration is not a live duration.
    expect(firstRun).toMatchObject({
      runs: 1,
      dryRun: 1,
      judged: 1,
      passed: 1,
      passRate: 1,
      durationSamples: 0,
      costSamples: 1,
      medianCostUsd: 0,
    });
    expect(firstRun?.medianDurationMs).toBeUndefined();
  });

  it("filters by lab and by since, and refuses a date it cannot read", async () => {
    const byLab = await computeStats(cwd, { study: "first-run", nowMs: NOW });
    if (!byLab.ok) throw new Error(byLab.error.message);
    expect(byLab.totals.runs).toBe(1);
    expect(byLab.studies.map((row) => row.study)).toEqual(["first-run"]);

    const since = await computeStats(cwd, { since: "2026-09-01T19:00:00Z", nowMs: NOW });
    if (!since.ok) throw new Error(since.error.message);
    expect(since.totals.runs).toBe(2);
    expect(since.days).toMatchObject([
      { day: "2026-09-01", runs: 2, live: 2, estimatedSpendUsd: 0, unpricedRuns: 2 },
    ]);

    const bad = await computeStats(cwd, { since: "last tuesday", nowMs: NOW });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("HUMANISH_STATS_INVALID_SINCE");
  });

  it("groups spend by day, newest last", async () => {
    const result = await computeStats(cwd, { nowMs: NOW });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.days.map((row) => row.day)).toEqual(["2026-08-31", "2026-09-01"]);
    expect(result.days[1]).toMatchObject({
      day: "2026-09-01",
      runs: 4,
      live: 4,
      estimatedSpendUsd: 0.325,
      unpricedRuns: 2,
    });
  });

  it("reads as a short report, with the unpriced count next to the sum", async () => {
    const result = await computeStats(cwd, { nowMs: NOW });
    if (!result.ok) throw new Error(result.error.message);
    const text = formatStatsHuman(result);
    expect(text).toContain("live runs: 4 (1 still running)\ndry runs: 1\n");
    expect(text).toContain("known estimated spend: $0.33");
    expect(text).toContain("analysis: none recorded");
    expect(text).toContain("analysis history: 5 runs missing or uncertain");
    expect(text).toContain("participants: 2 of 3 reached the goal, 2 reported friction");
    expect(text).toContain(
      "- try-live: 4 runs, 4 live; 2 of 3 passed; median 1.9m over 3; known study spend $0.33; participant/desktop median $0.16 over 2; 2 unpriced runs, 0 unpriced analyses",
    );
    expect(text).not.toContain("(s)");
    expect(text.trimEnd().split("\n").at(-1)).toBe(result.note);
  });

  it("an empty project is an empty report, not an error", async () => {
    const empty = await mkdtemp(path.join(tmpdir(), "humanish-stats-empty-"));
    try {
      const result = await computeStats(empty, { nowMs: NOW });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.totals.runs).toBe(0);
      expect(result.studies).toEqual([]);
      expect(formatStatsHuman(result)).toBe(
        "humanish stats\nno runs yet; start one with humanish run first-run\n",
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("prints one line for dry runs alone and counts a dry run with no cost record as $0", async () => {
    const previews = await mkdtemp(path.join(tmpdir(), "humanish-stats-previews-"));
    try {
      await writeFixtureRuns(
        previews,
        ["p1", "p2"].map((runId) => ({
          runId,
          labId: "first-run",
          mode: "dry-run" as const,
          state: "finished" as const,
          startedAt: "2026-08-31T10:00:00.000Z",
          durationMs: 800,
        })),
        NOW,
      );
      const result = await computeStats(previews, { nowMs: NOW });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.totals).toMatchObject({ unpricedRuns: 0, estimatedSpendUsd: 0 });
      expect(result.totals.costs).toMatchObject({ runEstimatedUsd: 0, incompleteRunEstimates: 0 });
      expect(formatStatsHuman(result)).toBe("humanish stats\n2 dry runs ($0); no live runs yet\n");
    } finally {
      await rm(previews, { recursive: true, force: true });
    }
  });

  it("keeps a dry run that records an unknown cost unpriced, with the full report", async () => {
    const previews = await mkdtemp(path.join(tmpdir(), "humanish-stats-unknown-preview-"));
    try {
      await writeFixtureRuns(
        previews,
        [
          { runId: "p1", estimatedCostUsd: null },
          { runId: "p2", estimatedCostUsd: undefined },
        ].map(({ runId, estimatedCostUsd }) => ({
          runId,
          labId: "first-run",
          mode: "dry-run" as const,
          state: "finished" as const,
          startedAt: "2026-08-31T10:00:00.000Z",
          durationMs: 800,
          ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
        })),
        NOW,
      );
      const result = await computeStats(previews, { nowMs: NOW });
      if (!result.ok) throw new Error(result.error.message);
      expect(result.totals.unpricedRuns).toBe(1);
      expect(result.totals.costs.incompleteRunEstimates).toBe(1);
      const text = formatStatsHuman(result);
      expect(text).toContain("live runs: 0\ndry runs: 2\n");
      expect(text).toContain("participants and desktops: $0.00; 1 run with incomplete accounting");
    } finally {
      await rm(previews, { recursive: true, force: true });
    }
  });
});
