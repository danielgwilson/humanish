// Before a computer-use study runs, the plan estimates how large its run bundle grows: run.json and
// each participant's trace, which analysis reads up to 16 MiB each, the Observer page, which verify
// reads up to 32 MiB, and the files the public-safety scan visits. A live study whose estimate
// passes one of those limits gets a plan warning, which `study check` and `humanish run` print
// before any sandbox is created, and runs.
//
// The worked examples use the rates in src/study/bundle-estimate.ts: a model turn every 10 s that
// adds 4,700 bytes to its participant's trace (the busiest participant measured) and none to
// run.json, which keeps the per-request lists in the traces, 16,500 bytes of run.json for each
// participant and 4,400 for the run, 5,400 for each trace, 500 for each dwell frame, 110,000 for
// each screenshot, and 3 minutes for a participant with no declared end. The Observer page is
// 1,200,000 bytes of app, 0.85 of run.json and 0.12 of all the traces.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type { RunBundle } from "../../src/run/bundle.js";
import { runStudyWith } from "../../src/run-study.js";
import { participantSchedule } from "../../src/study/arrivals.js";
import { estimateBundle } from "../../src/study/bundle-estimate.js";
import { parseStudy } from "../../src/study/config.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import { lab, type Patch } from "../admission/fixtures.js";
import { makeFanoutModule } from "../helpers/fanout-desktop.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const HOURS = 60 * 60_000;
// Room for long windows and 30 sandboxes at once, as on an E2B Pro plan.
const ENV = {
  HUMANISH_E2B_MAX_SANDBOX_MINUTES: "1440",
  HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES: "100",
};
const COUNTED =
  "at a model turn every 10s that adds up to 4.7 KB to the participant's trace. The run goes ahead.";
const WARN_30_HOSTS = `The Observer page, observer/index.html, may grow to about 48.0 MiB, past the 32 MiB verify reads in one file. The estimate counts 30 participants working declared windows of up to 8h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`;

/** An event day: `hosts` hosts working `hours` from the start, and `guests` arriving a minute apart. */
function eventDay(hosts: number, hours: number, guests = 0): Patch {
  return {
    id: "event-day",
    mode: "live",
    participants: [
      { id: "host", count: hosts, endAfterMs: hours * HOURS },
      ...(guests === 0
        ? []
        : [{ id: "guest", count: guests, startAfterMs: 60_000, startEveryMs: 60_000 }]),
    ],
    execution: { target: "e2b-desktop", timeoutMs: 20 * 60_000 },
  };
}

/**
 * `study check` on the study: whether it passes, its bundle size row and its warnings, apart from
 * the one each participant gets for the fixture persona's missing background.
 */
async function check(patch: Patch) {
  const cwd = await makeTestTempDir("humanish-bundle-check-");
  await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
  const raw = lab("cuAppUrl", { id: "bundle", ...patch });
  await writeFile(path.join(cwd, "humanish", "studies", `${String(raw.id)}.yaml`), stringify(raw));
  const result = await runStudyPreflight({ cwd, study: String(raw.id), env: ENV });
  return {
    ok: result.ok,
    row: result.checks.find((row) => row.name === "bundle size")?.message,
    warnings: result.warnings.filter((warning) => !warning.includes("has no persona background")),
  };
}

describe("study check's bundle estimate", () => {
  it("passes 5 hosts working 8 hours beside 25 guests with no warning", async () => {
    // Turns: 5 x 2,880 for the hosts and 25 x 18 for the guests, 14,850.
    // run.json: 4,400 + 30 x 16,500 = 499,400 bytes.
    // A host's trace: 5,400 + 2,880 x 4,700 = 13,541,400 bytes.
    // A guest's trace: 5,400 + 18 x 4,700 = 90,000. All traces: 5 x 13,541,400 + 25 x 90,000
    // = 69,957,000. Page: 1,200,000 + 0.85 x 499,400 + 0.12 x 69,957,000 = 10,019,330.
    // Entries: 20 + 30 x 3 + 14,850 = 14,960, of 10,000 + 30 x 5,000.
    // In all: 10,019,330 + (30 + 14,850) screenshots x 110,000 + 69,957,000 + 2 x 499,400
    // = 1,717,775,130 bytes.
    expect(await check(eventDay(5, 8, 25))).toEqual({
      ok: true,
      row: "run.json about 0.5 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 9.6 MiB of the 32 MiB verify reads; about 14,960 files and folders of the 160,000 the public-safety scan reads; about 1638 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("passes 19 hosts working 8 hours, near the verify limit on the Observer page", async () => {
    // run.json: 4,400 + 19 x 16,500 = 317,900 bytes. Page: 1,200,000 + 0.85 x 317,900
    // + 0.12 x 19 x 13,541,400 = 32,344,607, under 33,554,432.
    // In all: 32,344,607 + 54,739 x 110,000 + 19 x 13,541,400 + 2 x 317,900 = 6,311,557,007.
    expect(await check(eventDay(19, 8))).toEqual({
      ok: true,
      row: "run.json about 0.3 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 30.8 MiB of the 32 MiB verify reads; about 54,797 files and folders of the 105,000 the public-safety scan reads; about 6019 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("warns that 20 hosts working 8 hours pass the verify limit on the Observer page", async () => {
    // run.json: 4,400 + 20 x 16,500 = 334,400 bytes, under the analysis limit. Page: 1,200,000
    // + 0.85 x 334,400 + 0.12 x 20 x 13,541,400 = 33,983,600. The busiest participant measured
    // added about 475 gzipped bytes a turn to the page. In all: 33,983,600 + 57,620 x 110,000
    // + 20 x 13,541,400 + 2 x 334,400 = 6,643,680,400.
    expect(await check(eventDay(20, 8))).toEqual({
      ok: true,
      row: "run.json about 0.3 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 32.4 MiB of the 32 MiB verify reads; about 57,680 files and folders of the 110,000 the public-safety scan reads; about 6336 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [
        `The Observer page, observer/index.html, may grow to about 32.4 MiB, past the 32 MiB verify reads in one file. The estimate counts 20 participants working declared windows of up to 8h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`,
      ],
    });
  });

  it("warns that 30 hosts working 8 hours pass the verify limit on the Observer page only", async () => {
    // run.json: 4,400 + 30 x 16,500 = 499,400 bytes. Page: 1,200,000 + 0.85 x 499,400
    // + 0.12 x 30 x 13,541,400 = 50,373,530.
    // In all: 50,373,530 + 86,430 x 110,000 + 30 x 13,541,400 + 2 x 499,400 = 9,964,914,330.
    expect(await check(eventDay(30, 8))).toEqual({
      ok: true,
      row: "run.json about 0.5 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 48.0 MiB of the 32 MiB verify reads; about 86,510 files and folders of the 160,000 the public-safety scan reads; about 9503 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [WARN_30_HOSTS],
    });
  });

  it("counts run.json by participant, whatever the number of model turns", () => {
    const host = { schedule: participantSchedule({ endAfterMs: 8 * HOURS }), limits: {} };
    // 4,400 + 30 x 16,500, with 2,880 turns each.
    expect(
      estimateBundle(
        Array.from({ length: 30 }, () => host),
        HOURS,
      ).runFileBytes,
    ).toBe(499_400);
  });

  it("warns that one participant working 10 hours passes the analysis limit on its trace", async () => {
    // 3,600 turns. Trace: 5,400 + 3,600 x 4,700 = 16,925,400 bytes, over 16,777,216. The measured
    // busiest participant, 4,532 bytes a turn, passes it at about 10.3 hours. run.json: 4,400
    // + 16,500 = 20,900. Page: 1,200,000 + 0.85 x 20,900 + 0.12 x 16,925,400 = 3,248,813.
    // In all: 3,248,813 + 3,601 x 110,000 + 16,925,400 + 2 x 20,900 = 416,326,013.
    const result = await check({
      mode: "live",
      participants: [{ id: "host", endAfterMs: 10 * HOURS }],
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.02 MiB of the 16 MiB analysis reads; largest trace about 16.1 MiB of the 16 MiB analysis reads of each; Observer page about 3.1 MiB of the 32 MiB verify reads; about 3,623 files and folders of the 15,000 the public-safety scan reads; about 397 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [
        `One participant's trace may grow to about 16.1 MiB, past the 16 MiB analysis reads of each trace. The estimate counts 1 participant working a declared window of up to 10h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs).`,
      ],
    });
  });

  it("counts dwell frames in each trace and in the files the scan reads", async () => {
    // Six watchers in 9-hour windows, each with an hour's dwell window at a frame a second: 3,240
    // turns and 3,601 frames each. Trace: 5,400 + 3,240 x 4,700 = 15,233,400 bytes without the
    // frames, under 16,777,216, and 15,233,400 + 3,601 x 500 = 17,033,900 with them. Entries:
    // 20 + 6 x (3 + 3,240 + 3,601) = 41,084, past 10,000 + 6 x 5,000. run.json: 4,400 + 6 x 16,500
    // = 103,400. Page: 1,200,000 + 0.85 x 103,400 + 0.12 x 6 x 17,033,900 = 13,552,298.
    // In all: 13,552,298 + (6 + 19,440 + 21,606) x 110,000 + 6 x 17,033,900 + 2 x 103,400
    // = 4,631,682,498.
    const result = await check({
      mode: "live",
      participants: [{ id: "watcher", count: 6, endAfterMs: 9 * HOURS }],
      actor: { dwell: { ms: HOURS, everyMs: 1_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.10 MiB of the 16 MiB analysis reads; largest trace about 16.2 MiB of the 16 MiB analysis reads of each; Observer page about 12.9 MiB of the 32 MiB verify reads; about 41,084 files and folders of the 40,000 the public-safety scan reads; about 4417 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [
        `One participant's trace may grow to about 16.2 MiB, past the 16 MiB analysis reads of each trace. The run may hold about 41,084 files and folders, past the 40,000 the public-safety scan reads in a run of 6 participants. The estimate counts 6 participants working declared windows of up to 9h, ${COUNTED} To stay under the limits, shorten the longest windows (participants[].endAfterMs), shorten the dwell window (dwell.ms) or capture less often (dwell.everyMs), or split the participants across studies.`,
      ],
    });
  });

  it("passes 100 participants with no declared end, whatever their session budget", async () => {
    // Each is counted for 3 minutes, 18 turns. run.json: 4,400 + 100 x 16,500 = 1,654,400 bytes.
    // Trace: 5,400 + 18 x 4,700 = 90,000. Page: 1,200,000 + 0.85 x 1,654,400 + 0.12 x 100 x 90,000
    // = 3,686,240. In all: 3,686,240 + 1,900 x 110,000 + 100 x 90,000 + 2 x 1,654,400
    // = 224,995,040.
    const result = await check({
      mode: "live",
      participants: [{ id: "visitor", count: 100 }],
      execution: { target: "e2b-desktop", timeoutMs: 2 * HOURS },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 1.6 MiB of the 16 MiB analysis reads; largest trace about 0.09 MiB of the 16 MiB analysis reads of each; Observer page about 3.5 MiB of the 32 MiB verify reads; about 2,120 files and folders of the 510,000 the public-safety scan reads; about 215 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("counts a short session budget in place of the 3 minutes, with its dwell frames", async () => {
    // One participant for its 1-minute budget, 6 turns, which cuts the 10-minute dwell window to
    // 12 frames and the frame after it. run.json: 4,400 + 16,500 = 20,900 bytes. Trace: 5,400
    // + 6 x 4,700 + 13 x 500 = 40,100. Entries: 20 + 3 + 6 + 13. Page: 1,200,000 + 0.85 x 20,900
    // + 0.12 x 40,100 = 1,222,577. In all: 1,222,577 + 20 x 110,000 + 40,100 + 2 x 20,900
    // = 3,504,477.
    const result = await check({
      mode: "live",
      actor: { dwell: { ms: 600_000, everyMs: 5_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.02 MiB of the 16 MiB analysis reads; largest trace about 0.04 MiB of the 16 MiB analysis reads of each; Observer page about 1.2 MiB of the 32 MiB verify reads; about 42 files and folders of the 15,000 the public-safety scan reads; about 3 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("does not warn about a dry run, which records no turns", async () => {
    const result = await check({ ...eventDay(30, 8), mode: "dry-run" });

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});

describe("humanish run", () => {
  it("runs a study past a limit and records the warning in its bundle", async () => {
    const cwd = await makeTestTempDir("humanish-bundle-warning-");
    const handle = makeFanoutModule();
    const parsed = parseStudy(lab("cuAppUrl", eventDay(30, 8)));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const outcome = await runStudyWith(
      parsed.config,
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
    ).toContain(WARN_30_HOSTS);
  });
});
