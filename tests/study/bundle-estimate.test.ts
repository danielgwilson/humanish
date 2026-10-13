// Before a computer-use study runs, the plan estimates how large its run bundle grows: run.json and
// each participant's trace, which analysis reads up to 16 MiB each, and the files the public-safety
// scan visits. A live study whose estimate passes one of those limits gets a plan warning, which
// `study check` and `humanish run` print before any sandbox is created, and runs.
//
// The worked examples use the rates in src/study/bundle-estimate.ts: a model turn every 10 s that
// adds 225 bytes to run.json and 2,100 to its participant's trace, 16,500 bytes of run.json for
// each participant and 4,400 for the run, 5,400 for each trace, 500 for each dwell frame, 110,000
// for each screenshot, 1,200,000 for the Observer page, and 3 minutes for a participant with no
// declared end.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import type { RunBundle } from "../../src/run/bundle.js";
import { runStudyWith } from "../../src/run-study.js";
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
  "at a model turn every 10s that adds about 225 bytes to run.json and 2.1 KB to the participant's trace. The run goes ahead.";
const WARN_30_HOSTS = `This study's run.json may grow to about 19.0 MiB, past the 16 MiB analysis reads. The estimate counts 30 participants working declared windows of up to 8h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`;

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
    // run.json: 4,400 + 30 x 16,500 + 14,850 x 225 = 3,840,650 bytes.
    // A host's trace: 5,400 + 2,880 x 2,100 = 6,053,400 bytes.
    // Entries: 20 + 30 x 3 + 14,850 = 14,960, of 10,000 + 30 x 5,000.
    // In all: 1,200,000 + (30 + 14,850) screenshots x 110,000 + 5 x 6,053,400 + 25 x 43,200
    // + 2 x 3,840,650 = 1,677,028,300 bytes.
    expect(await check(eventDay(5, 8, 25))).toEqual({
      ok: true,
      row: "run.json about 3.7 MiB of the 16 MiB analysis reads; largest trace about 5.8 MiB of the 16 MiB analysis reads of each; about 14,960 files and folders of the 160,000 the public-safety scan reads; about 1599 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("passes 24 hosts working 8 hours, near the analysis limit", async () => {
    // run.json: 4,400 + 24 x 16,500 + 69,120 x 225 = 15,952,400 bytes.
    // In all: 1,200,000 + 69,144 x 110,000 + 24 x 6,053,400 + 2 x 15,952,400 = 7,784,226,400.
    expect(await check(eventDay(24, 8))).toEqual({
      ok: true,
      row: "run.json about 15.2 MiB of the 16 MiB analysis reads; largest trace about 5.8 MiB of the 16 MiB analysis reads of each; about 69,212 files and folders of the 130,000 the public-safety scan reads; about 7424 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("warns that 30 hosts working 8 hours pass the analysis limit on run.json", async () => {
    // run.json: 4,400 + 30 x 16,500 + 86,400 x 225 = 19,939,400 bytes.
    // In all: 1,200,000 + 86,430 x 110,000 + 30 x 6,053,400 + 2 x 19,939,400 = 9,729,980,800.
    expect(await check(eventDay(30, 8))).toEqual({
      ok: true,
      row: "run.json about 19.0 MiB of the 16 MiB analysis reads; largest trace about 5.8 MiB of the 16 MiB analysis reads of each; about 86,510 files and folders of the 160,000 the public-safety scan reads; about 9279 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [WARN_30_HOSTS],
    });
  });

  it("warns that one participant working 23 hours passes the analysis limit on its trace", async () => {
    // 8,280 turns. Trace: 5,400 + 8,280 x 2,100 = 17,393,400 bytes. run.json: 4,400 + 16,500
    // + 8,280 x 225 = 1,883,900. In all: 1,200,000 + 8,281 x 110,000 + 17,393,400 + 2 x 1,883,900.
    const result = await check({
      mode: "live",
      participants: [{ id: "host", endAfterMs: 23 * HOURS }],
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 1.8 MiB of the 16 MiB analysis reads; largest trace about 16.6 MiB of the 16 MiB analysis reads of each; about 8,303 files and folders of the 15,000 the public-safety scan reads; about 890 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [
        `One participant's trace may grow to about 16.6 MiB, past the 16 MiB analysis reads of each trace. The estimate counts 1 participant working a declared window of up to 23h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs).`,
      ],
    });
  });

  it("counts dwell frames in each trace and in the files the scan reads", async () => {
    // Two watchers in 23-hour windows, each with an hour's dwell window at a frame a second:
    // 8,280 turns and 3,601 frames each. Trace: 5,400 + 8,280 x 2,100 + 3,601 x 500 = 19,193,900
    // bytes. Entries: 20 + 2 x (3 + 8,280 + 3,601) = 23,788, past 10,000 + 2 x 5,000.
    // run.json: 4,400 + 2 x 16,500 + 16,560 x 225 = 3,763,400. In all: 1,200,000
    // + (2 + 16,560 + 7,202) x 110,000 + 2 x 19,193,900 + 2 x 3,763,400 = 2,661,154,600.
    const result = await check({
      mode: "live",
      participants: [{ id: "watcher", count: 2, endAfterMs: 23 * HOURS }],
      actor: { dwell: { ms: HOURS, everyMs: 1_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 3.6 MiB of the 16 MiB analysis reads; largest trace about 18.3 MiB of the 16 MiB analysis reads of each; about 23,788 files and folders of the 20,000 the public-safety scan reads; about 2538 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [
        `One participant's trace may grow to about 18.3 MiB, past the 16 MiB analysis reads of each trace. The run may hold about 23,788 files and folders, past the 20,000 the public-safety scan reads in a run of 2 participants. The estimate counts 2 participants working declared windows of up to 23h, ${COUNTED} To stay under the limits, shorten the longest windows (participants[].endAfterMs), shorten the dwell window (dwell.ms) or capture less often (dwell.everyMs), or split the participants across studies.`,
      ],
    });
  });

  it("passes 100 participants with no declared end, whatever their session budget", async () => {
    // Each is counted for 3 minutes, 18 turns. run.json: 4,400 + 100 x 16,500 + 1,800 x 225
    // = 2,059,400 bytes. Trace: 5,400 + 18 x 2,100 = 43,200. In all: 1,200,000 + 1,900 x 110,000
    // + 100 x 43,200 + 2 x 2,059,400 = 218,638,800.
    const result = await check({
      mode: "live",
      participants: [{ id: "visitor", count: 100 }],
      execution: { target: "e2b-desktop", timeoutMs: 2 * HOURS },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 2.0 MiB of the 16 MiB analysis reads; largest trace about 0.04 MiB of the 16 MiB analysis reads of each; about 2,120 files and folders of the 510,000 the public-safety scan reads; about 209 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("counts a short session budget in place of the 3 minutes, with its dwell frames", async () => {
    // One participant for its 1-minute budget, 6 turns, which cuts the 10-minute dwell window to
    // 12 frames and the frame after it. run.json: 4,400 + 16,500 + 6 x 225 = 22,250 bytes. Trace:
    // 5,400 + 6 x 2,100 + 13 x 500 = 24,500. Entries: 20 + 3 + 6 + 13. In all: 1,200,000
    // + 20 x 110,000 + 24,500 + 2 x 22,250 = 3,469,000.
    const result = await check({
      mode: "live",
      actor: { dwell: { ms: 600_000, everyMs: 5_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.02 MiB of the 16 MiB analysis reads; largest trace about 0.02 MiB of the 16 MiB analysis reads of each; about 42 files and folders of the 15,000 the public-safety scan reads; about 3 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
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
