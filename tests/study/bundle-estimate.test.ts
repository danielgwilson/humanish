// Before a computer-use study runs, the plan estimates how large its bundle grows: the run.json
// analysis reads, the largest file verify reads and the files the public-safety scan visits. The
// estimate runs high, so a live study whose estimate passes one of those limits gets a plan
// warning, which `study check` and `humanish run` print before any sandbox is created, and runs.
//
// The worked examples use the measured rates in src/study/bundle-estimate.ts: a model turn every
// 10 s adding 2,100 bytes of run.json, 14,400 bytes for each participant, 400 for the run, 2,600
// more for each participant in observer-data.json, and 3 minutes for a participant with no
// declared end.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type { RunBundle } from "../../src/run/bundle.js";
import { runStudyWith } from "../../src/run-study.js";
import { estimateBundle, bundleLimitReason } from "../../src/study/bundle-estimate.js";
import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { PlanResult } from "../../src/study/plan-types.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type Patch } from "../admission/fixtures.js";
import { makeFanoutModule } from "../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const HOURS = 60 * 60_000;
const WARN8 =
  "This study's run.json may grow to about 30.2 MiB, past the 16 MiB analysis reads. The estimate counts 5 participants working their declared windows of up to 8h and 25 for up to 3m each, at a model turn every 10s that adds about 2.1 KB. It runs high, about 1.8 times the one long live run measured, so the run goes ahead. To stay under the limit, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.";
// Room for 8-hour windows and 30 sandboxes at once, as on an E2B Pro plan.
const ENV = {
  HUMANISH_E2B_MAX_SANDBOX_MINUTES: "1440",
  HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES: "100",
};

/** A clinic day: five staff working `hours` from the start, and 25 patients arriving. */
function clinic(hours: number): Patch {
  return {
    id: "clinic-day",
    mode: "live",
    participants: [
      { id: "staff", count: 5, endAfterMs: hours * HOURS },
      { id: "patient", count: 25, startAfterMs: 60_000, startEveryMs: 60_000 },
    ],
    execution: { target: "e2b-desktop", timeoutMs: 20 * 60_000 },
  };
}

function study(patch: Patch): StudyConfig {
  const parsed = parseStudy(lab("cuAppUrl", patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function plan(config: StudyConfig, dryRun = false): PlanResult {
  return planStudy(config, { cwd: process.cwd(), dryRun, env: ENV });
}

describe("the plan's bundle estimate", () => {
  it("warns about a clinic day whose staff work 8 hours, naming the analysis limit", () => {
    const result = plan(study(clinic(8)));

    // run.json: 400 + 30 × 14,400 + (5 × 2,880 + 25 × 18) turns × 2,100 = 31,617,400 bytes.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.planned.bundle?.runFileBytes).toBe(31_617_400);
    expect(result.planned.plan.warnings).toContain(WARN8);
  });

  it("plans the same day when the staff work 4 hours, near the analysis limit", () => {
    const result = plan(study(clinic(4)));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 400 + 432,000 + (5 × 1,440 + 25 × 18) × 2,100 = 16,497,400 bytes, 15.7 MiB.
    expect(result.planned.bundle?.runFileBytes).toBe(16_497_400);
    // observer-data.json: 2,600 more bytes for each of the 30 participants.
    expect(result.planned.bundle?.largestFileBytes).toBe(16_575_400);
    // 20 for the run, and for each participant 3 plus a screenshot a turn: 20 + 90 + 7,650.
    expect(result.planned.bundle?.entries).toBe(7_760);
    expect(result.planned.bundle?.entryLimit).toBe(160_000);
  });

  it("plans 100 participants with no declared end, whatever their session budget", () => {
    const result = plan(
      study({
        mode: "live",
        participants: [{ id: "visitor", count: 100 }],
        execution: { target: "e2b-desktop", timeoutMs: 2 * HOURS },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Each is counted for 3 minutes: 400 + 100 × (14,400 + 18 × 2,100) = 5,220,400 bytes.
    expect(result.planned.bundle?.runFileBytes).toBe(5_220_400);
  });

  it("counts a short session budget in place of the 3 minutes", () => {
    const result = plan(
      study({ mode: "live", execution: { target: "e2b-desktop", timeoutMs: 60_000 } }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // One participant for its 1-minute budget: 400 + 14,400 + 6 × 2,100.
    expect(result.planned.bundle?.runFileBytes).toBe(27_400);
  });

  it("counts a dwell window's frames as files and run.json bytes", () => {
    const result = plan(
      study({
        mode: "live",
        actor: {
          type: "openai-computer-use",
          persona: "first-time-visitor",
          mission: "Watch the board.",
          dwell: { ms: 600_000, everyMs: 5_000, then: "continue" },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The 1-minute budget cuts the 10-minute window to 12 frames and the frame after it, 570 bytes
    // each: 400 + 14,400 + 6 × 2,100 + 13 × 570.
    expect(result.planned.bundle?.runFileBytes).toBe(34_810);
    // 20 + 3 + 6 turns + 13 frames.
    expect(result.planned.bundle?.entries).toBe(42);
  });

  it("does not warn about a dry run, which records no turns", () => {
    const result = plan(study(clinic(8)), true);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.planned.plan.warnings ?? []).not.toContain(WARN8);
  });
});

describe("the estimate against the scan's file limit", () => {
  it("names the scan limit when a run would hold more files than the scan reads", () => {
    // Two participants in 24-hour windows, each with an hour's dwell window at a frame a second:
    // 8,640 turns and 3,601 frames each, past the 20,000 entries the scan reads for two.
    const watcher = {
      id: "watcher",
      endAfterMs: 24 * HOURS,
      limits: { dwell: { ms: HOURS, everyMs: 1_000, then: "continue" as const } },
    };
    const estimate = estimateBundle([watcher, { ...watcher, id: "second" }], 20 * 60_000);

    // 20 + 2 × (3 + 8,640 + 3,601).
    expect(estimate.entries).toBe(24_508);
    expect(bundleLimitReason(estimate)).toMatch(
      /It may hold about 24,508 files and folders, past the 20,000 the public-safety scan reads in a run of 2 participants\./,
    );
  });
});

describe("humanish run", () => {
  it("runs a study past a limit and records the warning in its bundle", async () => {
    const cwd = await makeTestTempDir("humanish-bundle-warning-");
    const handle = makeFanoutModule();
    // The clinic day with every patient at the start, so the run does not wait for arrivals.
    const config = study({
      ...clinic(8),
      participants: [
        { id: "staff", count: 5, endAfterMs: 8 * HOURS },
        { id: "patient", count: 25 },
      ],
    });
    const outcome = await runStudyWith(
      config,
      { cwd, env: { ...ENV, OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" } },
      {
        desktopModule: async () => handle.module,
        // Each session fails at once: the test needs the run to start, not to work.
        runSession: async () => {
          throw new Error("synthetic session failure");
        },
        analysis: { run: vi.fn() },
      },
    );

    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(handle.created).toHaveLength(30);
    const bundle = JSON.parse(
      await readFile(
        path.join(cwd, ".humanish", "runs", outcome.result.runId!, "run.json"),
        "utf8",
      ),
    ) as RunBundle;
    expect(
      bundle.events.filter((event) => event.type === "study.warning").map((event) => event.message),
    ).toContain(WARN8);
  });
});

describe("study check", () => {
  async function check(patch: Patch) {
    const cwd = await makeTestTempDir("humanish-bundle-check-");
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", "clinic-day.yaml"),
      stringify(lab("cuAppUrl", patch)),
    );
    return runStudyPreflight({ cwd, study: "clinic-day", env: ENV });
  }

  it("prints the bundle estimate beside the limits", async () => {
    const result = await check(clinic(4));

    expect(result.ok).toBe(true);
    expect(result.checks.find((row) => row.name === "bundle size")?.message).toBe(
      "run.json about 15.7 MiB of the 16 MiB analysis reads; largest file about 15.8 MiB of the 32 MiB verify reads; about 7,760 files and folders of the 160,000 the public-safety scan reads; about 864 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
    );
  });

  it("passes a study whose estimate passes a limit, with the warning", async () => {
    const result = await check(clinic(8));

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(WARN8);
  });
});
