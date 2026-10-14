// A participant held to its scheduled end reloads a page that never changes, on a fake desktop
// ($0, real orchestration). Its loop runs on a virtual clock that moves only when the loop sleeps,
// so its 30 minutes pass at once. Its streak of reloads on the unchanged page ends neither its session
// nor its pass, and the review lists it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { CuaActorSessionOptions } from "../../../src/actors/computer-use/actor.js";
import {
  runComputerUseLoopWithTaps,
  type CuaProvider,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import type { ReviewSummary } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import { streakGaps } from "../../../src/routes/computer-use/bundle-parts.js";
import { makeFanoutModule } from "../../helpers/fanout-desktop.js";
import { MINUTE, NEW_ROW, QUIET, runWatching, turnOf } from "../../helpers/watching-loop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

/** A reader of an issue list that shows new issues only on reload: it reloads every turn. */
const reloader: CuaProvider = {
  id: "reloader",
  capabilities: {
    headless: true,
    structuredTrace: true,
    lanes: ["computer-use"],
    producesScreenshots: true,
    byoModel: true,
    preGrantableApprovals: false,
    inProcessTools: false,
    license: "open",
  },
  async nextTurn() {
    return {
      actions: [{ kind: "keypress", keys: ["ctrl", "r"] }],
      pendingSafetyChecks: [],
      done: false,
    };
  },
  async debrief() {
    return {
      actions: [],
      pendingSafetyChecks: [],
      done: true,
      closingReport: { summary: "No new issue came in.", frictionReports: [] },
    };
  },
};

/** The loop on a virtual clock from the real now, with the route's options for the rest. */
async function reloadUntilEnd(options: CuaActorSessionOptions) {
  let t = Date.now();
  return runComputerUseLoopWithTaps({
    instructions: options.instructions,
    provider: reloader,
    executor: {
      observe: async () => ({ screenshot: QUIET, stateSignature: "issue list" }),
      execute: async () => undefined,
    },
    persona: options.persona,
    redaction: options.redaction ?? defaultRedactionHooks,
    timeoutMs: options.timeoutMs,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.writeScreenshot === undefined ? {} : { writeScreenshot: options.writeScreenshot }),
  });
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-held-streak-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("a held participant that reloads an unchanged page for its whole session", () => {
  it("passes at its scheduled end, and the review lists its streak", async () => {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants: [{ id: "watcher", endAfterMs: 30 * 60_000, windDownMs: 5 * 60_000 }],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: reloadUntilEnd,
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const review = JSON.parse(
      await readFile(path.join(runDir, "review.json"), "utf8"),
    ) as ReviewSummary;
    expect(review.participants).toMatchObject({ total: 1, ranUntilEnd: 1, abandoned: 0 });
    const streakGaps = review.gaps.filter(
      (gap) =>
        gap.startsWith("watcher: ") &&
        gap.includes("repeated a recent action on an unchanged screen"),
    );
    expect(streakGaps).toHaveLength(1);
  });
});

describe("the review's gap for a held participant with several streaks", () => {
  it("is one line: the first streak and how many followed", async () => {
    // A reload shows a new row in odd minutes and none in even ones, and watches last 1 s, so each
    // minute holds a streak of 60 reloads on an unchanged screen and the 3 minutes hold 3 streaks.
    let seenAt = 0;
    let reloadedAt = 0;
    const run = await runWatching({
      screen: (atMs) => {
        seenAt = atMs;
        return Math.floor(reloadedAt / MINUTE) % 2 === 1 ? NEW_ROW : QUIET;
      },
      turn: () => {
        reloadedAt = seenAt;
        return turnOf([{ kind: "keypress", keys: ["ctrl", "r"] }]);
      },
      loop: {
        clock: { end: { atMs: 3 * MINUTE, windDownMs: MINUTE } },
        idleWaitMs: 1_000,
        maxWaitMs: 1_000,
      },
    });
    expect(streakGaps("watcher", run.result)).toEqual([
      "watcher: 79 turns in a row repeated a recent action on an unchanged screen, from 0:00 to 1:00 into the session. The participant is held to its scheduled end, so 20 such turns did not end its session, and from then on the screen was watched after each one before the next request. It had 2 more such streaks after that; its trace records each.",
    ]);
  });
});
