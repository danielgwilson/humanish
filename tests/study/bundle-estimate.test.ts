// Before a computer-use study runs, the plan estimates how large its run bundle grows: run.json and
// each participant's trace, which analysis reads up to 16 MiB each, the Observer page, which verify
// reads up to 32 MiB, and the files the public-safety scan visits. A live study whose estimate
// passes one of those limits gets a plan warning, which `study check` and `humanish run` print
// before any sandbox is created, and runs.
//
// The worked examples use the rates in src/study/bundle-estimate.ts: a model turn every 10 s that
// adds 225 bytes to run.json and 4,700 to its participant's trace (the busiest participant
// measured), 16,500 bytes of run.json for each participant and 4,400 for the run, 5,400 for each
// trace, 500 for each dwell frame, 110,000 for each screenshot, and 3 minutes for a participant with
// no declared end. The Observer page is 1,200,000 bytes of app, half of run.json and 0.12 of all
// the traces.

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
  "at a model turn every 10s that adds about 225 bytes to run.json and up to 4.7 KB to the participant's trace. The run goes ahead.";
const WARN_30_HOSTS = `This study's run.json may grow to about 19.0 MiB, past the 16 MiB analysis reads. The Observer page, observer/index.html, may grow to about 57.1 MiB, past the 32 MiB verify reads in one file. The estimate counts 30 participants working declared windows of up to 8h, ${COUNTED} To stay under the limits, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`;

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
    // A host's trace: 5,400 + 2,880 x 4,700 = 13,541,400 bytes.
    // A guest's trace: 5,400 + 18 x 4,700 = 90,000. All traces: 5 x 13,541,400 + 25 x 90,000
    // = 69,957,000. Page: 1,200,000 + 3,840,650 / 2 + 0.12 x 69,957,000 = 11,515,165.
    // Entries: 20 + 30 x 3 + 14,850 = 14,960, of 10,000 + 30 x 5,000.
    // In all: 11,515,165 + (30 + 14,850) screenshots x 110,000 + 69,957,000 + 2 x 3,840,650
    // = 1,725,953,465 bytes.
    expect(await check(eventDay(5, 8, 25))).toEqual({
      ok: true,
      row: "run.json about 3.7 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 11.0 MiB of the 32 MiB verify reads; about 14,960 files and folders of the 160,000 the public-safety scan reads; about 1646 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("passes 16 hosts working 8 hours, near the verify limit on the Observer page", async () => {
    // run.json: 4,400 + 16 x 16,500 + 46,080 x 225 = 10,636,400 bytes. Page: 1,200,000
    // + 10,636,400 / 2 + 0.12 x 16 x 13,541,400 = 32,517,688, under 33,554,432.
    // In all: 32,517,688 + 46,096 x 110,000 + 16 x 13,541,400 + 2 x 10,636,400 = 5,341,012,888.
    expect(await check(eventDay(16, 8))).toEqual({
      ok: true,
      row: "run.json about 10.1 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 31.0 MiB of the 32 MiB verify reads; about 46,148 files and folders of the 90,000 the public-safety scan reads; about 5094 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("warns that 17 hosts working 8 hours pass the verify limit on the Observer page", async () => {
    // run.json: 4,400 + 17 x 16,500 + 48,960 x 225 = 11,300,900 bytes, under the analysis limit.
    // Page: 1,200,000 + 11,300,900 / 2 + 0.12 x 17 x 13,541,400 = 34,474,906. The busiest
    // participant measured added about 475 gzipped bytes a turn to the page, and its compact
    // observer-data copy about 100. In all: 34,474,906 + 48,977 x 110,000 + 17 x 13,541,400
    // + 2 x 11,300,900 = 5,674,750,506.
    expect(await check(eventDay(17, 8))).toEqual({
      ok: true,
      row: "run.json about 10.8 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 32.9 MiB of the 32 MiB verify reads; about 49,031 files and folders of the 95,000 the public-safety scan reads; about 5412 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [
        `The Observer page, observer/index.html, may grow to about 32.9 MiB, past the 32 MiB verify reads in one file. The estimate counts 17 participants working declared windows of up to 8h, ${COUNTED} To stay under the limit, shorten the longest windows (participants[].endAfterMs), or split the participants across studies.`,
      ],
    });
  });

  it("warns that 30 hosts working 8 hours pass the analysis limit on run.json", async () => {
    // run.json: 4,400 + 30 x 16,500 + 86,400 x 225 = 19,939,400 bytes. Page: 1,200,000
    // + 19,939,400 / 2 + 0.12 x 30 x 13,541,400 = 59,918,740.
    // In all: 59,918,740 + 86,430 x 110,000 + 30 x 13,541,400 + 2 x 19,939,400 = 10,013,339,540.
    expect(await check(eventDay(30, 8))).toEqual({
      ok: true,
      row: "run.json about 19.0 MiB of the 16 MiB analysis reads; largest trace about 12.9 MiB of the 16 MiB analysis reads of each; Observer page about 57.1 MiB of the 32 MiB verify reads; about 86,510 files and folders of the 160,000 the public-safety scan reads; about 9549 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [WARN_30_HOSTS],
    });
  });

  it("warns that one participant working 10 hours passes the analysis limit on its trace", async () => {
    // 3,600 turns. Trace: 5,400 + 3,600 x 4,700 = 16,925,400 bytes, over 16,777,216. The measured
    // busiest participant, 4,532 bytes a turn, passes it at about 10.3 hours. run.json: 4,400
    // + 16,500 + 3,600 x 225 = 830,900. Page: 1,200,000 + 830,900 / 2 + 0.12 x 16,925,400
    // = 3,646,498. In all: 3,646,498 + 3,601 x 110,000 + 16,925,400 + 2 x 830,900 = 418,343,698.
    const result = await check({
      mode: "live",
      participants: [{ id: "host", endAfterMs: 10 * HOURS }],
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 0.8 MiB of the 16 MiB analysis reads; largest trace about 16.1 MiB of the 16 MiB analysis reads of each; Observer page about 3.5 MiB of the 32 MiB verify reads; about 3,623 files and folders of the 15,000 the public-safety scan reads; about 399 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
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
    // + 19,440 x 225 = 4,477,400. Page: 1,200,000 + 4,477,400 / 2 + 0.12 x 6 x 17,033,900
    // = 15,703,108. In all: 15,703,108 + (6 + 19,440 + 21,606) x 110,000 + 6 x 17,033,900
    // + 2 x 4,477,400 = 4,642,581,308.
    const result = await check({
      mode: "live",
      participants: [{ id: "watcher", count: 6, endAfterMs: 9 * HOURS }],
      actor: { dwell: { ms: HOURS, everyMs: 1_000, then: "continue" } },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 4.3 MiB of the 16 MiB analysis reads; largest trace about 16.2 MiB of the 16 MiB analysis reads of each; Observer page about 15.0 MiB of the 32 MiB verify reads; about 41,084 files and folders of the 40,000 the public-safety scan reads; about 4428 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 1m, at a model turn every 10s.",
      warnings: [
        `One participant's trace may grow to about 16.2 MiB, past the 16 MiB analysis reads of each trace. The run may hold about 41,084 files and folders, past the 40,000 the public-safety scan reads in a run of 6 participants. The estimate counts 6 participants working declared windows of up to 9h, ${COUNTED} To stay under the limits, shorten the longest windows (participants[].endAfterMs), shorten the dwell window (dwell.ms) or capture less often (dwell.everyMs), or split the participants across studies.`,
      ],
    });
  });

  it("passes 100 participants with no declared end, whatever their session budget", async () => {
    // Each is counted for 3 minutes, 18 turns. run.json: 4,400 + 100 x 16,500 + 1,800 x 225
    // = 2,059,400 bytes. Trace: 5,400 + 18 x 4,700 = 90,000. Page: 1,200,000 + 2,059,400 / 2
    // + 0.12 x 100 x 90,000 = 3,309,700. In all: 3,309,700 + 1,900 x 110,000 + 100 x 90,000
    // + 2 x 2,059,400 = 225,428,500.
    const result = await check({
      mode: "live",
      participants: [{ id: "visitor", count: 100 }],
      execution: { target: "e2b-desktop", timeoutMs: 2 * HOURS },
    });

    expect(result).toEqual({
      ok: true,
      row: "run.json about 2.0 MiB of the 16 MiB analysis reads; largest trace about 0.09 MiB of the 16 MiB analysis reads of each; Observer page about 3.2 MiB of the 32 MiB verify reads; about 2,120 files and folders of the 510,000 the public-safety scan reads; about 215 MiB in all. Participants with a declared end are counted for their whole window and the others for up to 3m, at a model turn every 10s.",
      warnings: [],
    });
  });

  it("counts a short session budget in place of the 3 minutes, with its dwell frames", async () => {
    // One participant for its 1-minute budget, 6 turns, which cuts the 10-minute dwell window to
    // 12 frames and the frame after it. run.json: 4,400 + 16,500 + 6 x 225 = 22,250 bytes. Trace:
    // 5,400 + 6 x 4,700 + 13 x 500 = 40,100. Entries: 20 + 3 + 6 + 13. Page: 1,200,000
    // + 22,250 / 2 + 0.12 x 40,100 = 1,215,937. In all: 1,215,937 + 20 x 110,000 + 40,100
    // + 2 x 22,250 = 3,500,537.
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
