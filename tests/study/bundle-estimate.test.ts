// Before a computer-use study runs, the plan estimates how large its run bundle grows: run.json,
// which analysis reads up to 16 MiB, each participant's trace, which analysis, verify and the
// Observer read up to 32 MiB, the Observer page, which verify reads up to 32 MiB, all the traces
// together, whose items the page joins in one string of at most 536,870,888 characters, and the
// files the public-safety scan visits. A live study whose estimate passes one of those limits
// gets a plan warning, which `study check` and `humanish run` print before any sandbox is
// created, and runs.
//
// The worked examples use the rates in src/study/bundle-estimate.ts: a model turn every 10 s that
// adds 3,500 bytes to its participant's compact trace (the busiest participant measured) and none
// to run.json, which keeps the per-request lists in the traces, 16,500 bytes of run.json for each
// participant and 4,400 for the run, 4,000 for each trace, 400 for each dwell frame, 110,000 for
// each screenshot, and 3 minutes for a participant with no declared end. The Observer page is
// 1,200,000 bytes of app, 0.85 of run.json and 0.16 of all the traces. run.json also holds the
// mission once for the run and once in each participant's stream, and the estimate counts one more
// copy for each participant, in case it reports friction or stops. The page holds the mission once
// for the run and once for each participant, outside its share of run.json. The fixture's
// mission, "Try it.", adds 7 bytes and 14 a participant, which moves no printed figure, so the
// examples leave it out.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type { RunBundle } from "../../src/run/bundle.js";
import { runStudyWith } from "../../src/run-study.js";
import { participantSchedule } from "../../src/study/arrivals.js";
import { bundleLimitReason, estimateBundle } from "../../src/study/bundle-estimate.js";
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
  "at a model turn every 10s that adds up to 3.5 KB to the participant's trace. The run goes ahead.";
const WARN_30_HOSTS = `The Observer page, observer/index.html, may grow to about 47.7 MiB, past the 32 MiB verify reads in one file. The estimate counts 30 participants working declared windows of up to 8h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`;

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
    // A host's trace: 4,000 + 2,880 x 3,500 = 10,084,000 bytes.
    // A guest's trace: 4,000 + 18 x 3,500 = 67,000. All traces: 5 x 10,084,000 + 25 x 67,000
    // = 52,095,000. Page: 1,200,000 + 0.85 x 499,400 + 0.16 x 52,095,000 = 9,959,690.
    // Entries: 20 + 30 x 3 + 14,850 = 14,960, of 10,000 + 30 x 5,000.
    // In all: 9,959,690 + (30 + 14,850) screenshots x 110,000 + 52,095,000 + 2 x 499,400
    // = 1,699,853,490 bytes.
    expect(await check(eventDay(5, 8, 25))).toEqual({
      ok: true,
      row: "run.json about 0.5 MiB of the 16 MiB analysis reads; largest trace about 9.6 MiB of the 32 MiB humanish reads of each; Observer page about 9.5 MiB of the 32 MiB verify reads; about 14,960 files and folders of the 160,000 the public-safety scan reads; about 1621 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("passes 19 hosts working 8 hours, near the verify limit on the Observer page", async () => {
    // run.json: 4,400 + 19 x 16,500 = 317,900 bytes. Page: 1,200,000 + 0.85 x 317,900
    // + 0.16 x 19 x 10,084,000 = 32,125,575, under 33,554,432.
    // In all: 32,125,575 + 54,739 x 110,000 + 19 x 10,084,000 + 2 x 317,900 = 6,245,647,375.
    expect(await check(eventDay(19, 8))).toEqual({
      ok: true,
      row: "run.json about 0.3 MiB of the 16 MiB analysis reads; largest trace about 9.6 MiB of the 32 MiB humanish reads of each; Observer page about 30.6 MiB of the 32 MiB verify reads; about 54,797 files and folders of the 105,000 the public-safety scan reads; about 5956 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("warns that 20 hosts working 8 hours pass the verify limit on the Observer page", async () => {
    // run.json: 4,400 + 20 x 16,500 = 334,400 bytes, under the analysis limit. Page: 1,200,000
    // + 0.85 x 334,400 + 0.16 x 20 x 10,084,000 = 33,753,040. The busiest participant measured
    // added about 475 gzipped bytes a turn to the page. In all: 33,753,040 + 57,620 x 110,000
    // + 20 x 10,084,000 + 2 x 334,400 = 6,574,301,840.
    expect(await check(eventDay(20, 8))).toEqual({
      ok: true,
      row: "run.json about 0.3 MiB of the 16 MiB analysis reads; largest trace about 9.6 MiB of the 32 MiB humanish reads of each; Observer page about 32.2 MiB of the 32 MiB verify reads; about 57,680 files and folders of the 110,000 the public-safety scan reads; about 6270 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [
        `The Observer page, observer/index.html, may grow to about 32.2 MiB, past the 32 MiB verify reads in one file. The estimate counts 20 participants working declared windows of up to 8h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`,
      ],
    });
  });

  it("warns that 30 hosts working 8 hours pass the verify limit on the Observer page only", async () => {
    // run.json: 4,400 + 30 x 16,500 = 499,400 bytes. Page: 1,200,000 + 0.85 x 499,400
    // + 0.16 x 30 x 10,084,000 = 50,027,690.
    // In all: 50,027,690 + 86,430 x 110,000 + 30 x 10,084,000 + 2 x 499,400 = 9,860,846,490.
    expect(await check(eventDay(30, 8))).toEqual({
      ok: true,
      row: "run.json about 0.5 MiB of the 16 MiB analysis reads; largest trace about 9.6 MiB of the 32 MiB humanish reads of each; Observer page about 47.7 MiB of the 32 MiB verify reads; about 86,510 files and folders of the 160,000 the public-safety scan reads; about 9404 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [WARN_30_HOSTS],
    });
  });

  it("warns that 54 hosts working 8 hours pass the longest string on all their traces", async () => {
    // All traces: 54 x 10,084,000 = 544,536,000 bytes, past V8's 536,870,888 characters, which
    // the Observer page, and a bundle export that renders it, need in one string; 53 hosts' are
    // 534,452,000. run.json: 4,400 + 54 x 16,500 = 895,400.
    // Page: 1,200,000 + 0.85 x 895,400 + 0.16 x 544,536,000 = 89,086,850. Entries: 20 + 54 x 3
    // + 54 x 2,880 = 155,702, of 10,000 + 54 x 5,000.
    expect((await check(eventDay(54, 8))).warnings).toEqual([
      `The Observer page, observer/index.html, may grow to about 85.0 MiB, past the 32 MiB verify reads in one file. All participants' traces together may grow to about 519.3 MiB, past the 512.0 MiB that fits in one string. The Observer page puts all their items in one string, so the page would not build. A bundle export allowed past its 25 MiB default renders that page, so it would fail too. The estimate counts 54 participants working declared windows of up to 8h, ${COUNTED} To stay under the limits, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`,
    ]);
  });

  it("counts run.json by participant, whatever the number of model turns", () => {
    const host = {
      schedule: participantSchedule({ endAfterMs: 8 * HOURS }),
      limits: {},
      assignment: {},
    };
    // 4,400 + 30 x 16,500, with 2,880 turns each.
    expect(
      estimateBundle(
        Array.from({ length: 30 }, () => host),
        HOURS,
      ).runFileBytes,
    ).toBe(499_400);
  });

  it("counts the mission on the Observer page once for the run and once for each participant", () => {
    // Dry runs of 1 and 4 participants grew observer/index.html by 2 and 5 copies of the mission at
    // its full size, as run.json grew, and a live run of 2 participants whose 2 feedback candidates
    // put 5 copies in run.json put 3 on the page. Four participants with a 10,000-byte mission, each
    // counted for 3 minutes, 18 turns. run.json: 4,400 + 10,000 + 4 x (16,500 + 2 x 10,000)
    // = 160,400. Page: 1,200,000 + 0.85 x (4,400 + 4 x 16,500) + 5 x 10,000 + 0.16 x 4 x 67,000
    // = 1,352,720.
    const visitor = {
      schedule: participantSchedule({}),
      limits: {},
      assignment: { mission: "Rename the project. ".repeat(500) },
    };
    expect(estimateBundle(Array(4).fill(visitor), HOURS)).toMatchObject({
      runFileBytes: 160_400,
      observerPageBytes: 1_352_720,
    });
  });

  it("counts the mission as run.json stores it, in UTF-8 with its JSON escapes", () => {
    // A dry run's run.json grew by 29,000 bytes a copy when the mission grew by 22,000 characters of
    // accented letters, quotes and newlines. This mission is 9 characters and 22 bytes in run.json:
    // 3 x 3 for 名前を, 1 for the space, 2 for each escaped quote, 2 x 3 for 変更 and 2 for the
    // escaped newline. Two participants: 4,400 + 22 + 2 x (16,500 + 2 x 22) = 37,510.
    const visitor = {
      schedule: participantSchedule({}),
      limits: {},
      assignment: { mission: '名前を "変更"\n' },
    };
    expect(estimateBundle([visitor, visitor], HOURS).runFileBytes).toBe(37_510);
  });

  it("keeps one participant in the longest window and densest dwell a study allows under the limit on its trace", async () => {
    // A 23h 45m window, the longest a 24-hour sandbox holds with 15 minutes for the closing report
    // and set-up, is 8,550 turns, and an hour's dwell at a frame a second is 3,601 frames. Trace:
    // 4,000 + 8,550 x 3,500 + 3,601 x 400 = 31,369,400 bytes, under 33,554,432. Entries: 20 + 3
    // + 8,550 + 3,601 = 12,174, of 10,000 + 5,000. run.json: 4,400 + 16,500 = 20,900. Page:
    // 1,200,000 + 0.85 x 20,900 + 0.16 x 31,369,400 = 6,236,869. In all: 6,236,869
    // + 12,152 x 110,000 + 31,369,400 + 2 x 20,900 = 1,374,368,069.
    const result = await check({
      mode: "live",
      participants: [{ id: "host", endAfterMs: 23.75 * HOURS }],
      actor: { dwell: { ms: HOURS, everyMs: 1_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.02 MiB of the 16 MiB analysis reads; largest trace about 29.9 MiB of the 32 MiB humanish reads of each; Observer page about 5.9 MiB of the 32 MiB verify reads; about 12,174 files and folders of the 15,000 the public-safety scan reads; about 1311 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("warns about a trace counted past the limit, for a window longer than a study allows", () => {
    // 27 hours, 9,720 turns. Trace: 4,000 + 9,720 x 3,500 = 34,024,000 bytes, over 33,554,432.
    // The busiest participant measured passes it at about 26.6 hours.
    const host = {
      schedule: participantSchedule({ endAfterMs: 27 * HOURS }),
      limits: {},
      assignment: {},
    };
    expect(bundleLimitReason(estimateBundle([host], HOURS))).toBe(
      `One participant's trace may grow to about 32.4 MiB, past the 32 MiB humanish reads of each trace. The estimate counts 1 participant working a declared window of up to 27h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs).`,
    );
  });

  it("counts dwell frames in each trace and in the files the scan reads", async () => {
    // Six watchers in 19-hour windows, each with an hour's dwell window at a frame a second: 6,840
    // turns and 3,601 frames each. Trace: 4,000 + 6,840 x 3,500 = 23,944,000 bytes without the
    // frames and 23,944,000 + 3,601 x 400 = 25,384,400 with them. Entries: 20 + 6 x (3 + 6,840
    // + 3,601) = 62,684, past 10,000 + 6 x 5,000. run.json: 4,400 + 6 x 16,500 = 103,400. Page:
    // 1,200,000 + 0.85 x 103,400 + 0.16 x 6 x 25,384,400 = 25,656,914. In all: 25,656,914
    // + (6 + 41,040 + 21,606) x 110,000 + 6 x 25,384,400 + 2 x 103,400 = 7,069,890,114.
    const result = await check({
      mode: "live",
      participants: [{ id: "watcher", count: 6, endAfterMs: 19 * HOURS }],
      actor: { dwell: { ms: HOURS, everyMs: 1_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.10 MiB of the 16 MiB analysis reads; largest trace about 24.2 MiB of the 32 MiB humanish reads of each; Observer page about 24.5 MiB of the 32 MiB verify reads; about 62,684 files and folders of the 40,000 the public-safety scan reads; about 6742 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [
        `The run may hold about 62,684 files and folders, past the 40,000 the public-safety scan reads in a run of 6 participants. The estimate counts 6 participants working declared windows of up to 19h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs), shorten the dwell window (dwell.ms) or capture less often (dwell.everyMs), or split the participants across studies.`,
      ],
    });
  });

  it("passes 100 participants with no declared end, whatever their session budget", async () => {
    // Each is counted for 3 minutes, 18 turns. run.json: 4,400 + 100 x 16,500 = 1,654,400 bytes.
    // Trace: 4,000 + 18 x 3,500 = 67,000. Page: 1,200,000 + 0.85 x 1,654,400 + 0.16 x 100 x 67,000
    // = 3,678,240. In all: 3,678,240 + 1,900 x 110,000 + 100 x 67,000 + 2 x 1,654,400
    // = 222,687,040.
    const result = await check({
      mode: "live",
      participants: [{ id: "visitor", count: 100 }],
      execution: { target: "e2b-desktop", timeoutMs: 2 * HOURS },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 1.6 MiB of the 16 MiB analysis reads; largest trace about 0.06 MiB of the 32 MiB humanish reads of each; Observer page about 3.5 MiB of the 32 MiB verify reads; about 2,120 files and folders of the 510,000 the public-safety scan reads; about 212 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("warns that 100 participants with an 80,000-byte mission pass the analysis limit on run.json", async () => {
    // run.json holds the mission once for the run, once in each participant's stream and once more
    // in the feedback candidate of a participant that reports friction or stops, which the estimate
    // counts for every participant. run.json: 4,400 + 80,000 + 100 x (16,500 + 2 x 80,000)
    // = 17,734,400 bytes, over 16,777,216. Each is counted for 3 minutes, 18 turns. Trace: 4,000
    // + 18 x 3,500 = 67,000. The page holds the mission once for the run and once for each
    // participant. Page: 1,200,000 + 0.85 x (4,400 + 100 x 16,500) + 101 x 80,000 + 0.16 x 100
    // x 67,000 = 11,758,240. Entries: 20 + 100 x (3 + 18) = 2,120. In all: 11,758,240 + 1,900
    // x 110,000 + 100 x 67,000 + 2 x 17,734,400 = 262,927,040.
    const result = await check({
      mode: "live",
      participants: [{ id: "visitor", count: 100 }],
      actor: { mission: "Rename the project. ".repeat(4_000) },
      execution: { target: "e2b-desktop", timeoutMs: 2 * HOURS },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 16.9 MiB of the 16 MiB analysis reads; largest trace about 0.06 MiB of the 32 MiB humanish reads of each; Observer page about 11.2 MiB of the 32 MiB verify reads; about 2,120 files and folders of the 510,000 the public-safety scan reads; about 251 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [
        `This study's run.json may grow to about 16.9 MiB, past the 16 MiB analysis reads. It holds the mission once for the run, once in each participant's stream and once more for each participant that reports friction or stops, and the estimate counts the last copy for every participant. The estimate counts 100 participants for up to 3m each, ${COUNTED} To stay under the limit, shorten the mission (actor.mission), or split the participants across studies.`,
      ],
    });
  });

  it("counts a short session budget in place of the 3 minutes, with its dwell frames", async () => {
    // One participant for its 1-minute budget, 6 turns, which cuts the 10-minute dwell window to
    // 12 frames and the frame after it. run.json: 4,400 + 16,500 = 20,900 bytes. Trace: 4,000
    // + 6 x 3,500 + 13 x 400 = 30,200. Entries: 20 + 3 + 6 + 13. Page: 1,200,000 + 0.85 x 20,900
    // + 0.16 x 30,200 = 1,222,597. In all: 1,222,597 + 20 x 110,000 + 30,200 + 2 x 20,900
    // = 3,494,597.
    const result = await check({
      mode: "live",
      actor: { dwell: { ms: 600_000, everyMs: 5_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.02 MiB of the 16 MiB analysis reads; largest trace about 0.03 MiB of the 32 MiB humanish reads of each; Observer page about 1.2 MiB of the 32 MiB verify reads; about 42 files and folders of the 15,000 the public-safety scan reads; about 3 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
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
