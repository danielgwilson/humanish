// A participant still working at its session cap gives its closing report, and the run is judged
// on what that report declares in its first line. Fake desktops and a fake provider ($0, real
// orchestration, real time with a sub-second wind-down). The first case is the shape of a live run
// on https://example.com/ whose participant reached the goal and then paraphrased the domain
// registry's page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaProvider } from "../../../src/actors/computer-use/loop.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule } from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

const IANA_PARAPHRASE =
  "I opened Example Domain and followed the More information link to the IANA page. The IANA page explained that example domains are reserved for documentation and cannot be registered or transferred.";

/** A reader who takes a turn every 100 ms until its cap, then gives `summary` as its closing report. */
function reader(summary: string): CuaProvider {
  let turns = 0;
  return {
    id: "reader",
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
      turns += 1;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        actions: [{ kind: "click", x: 10 + turns, y: 20 }],
        pendingSafetyChecks: [],
        done: false,
        message: "Reading the page again.",
      };
    },
    async debrief() {
      return {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        closingReport: { summary, frictionReports: [] },
      };
    },
  };
}

describe("a closing report at a session cap", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-closing-outcome-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function runToCap(summary: string) {
    const parsed = parseStudy(
      lab("cuAppUrl", {
        mode: "live",
        participants: [{ id: "reader", maxSessionMs: 1_000, windDownMs: 500 }],
      }),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      parsed.config,
      { cwd, env: KEYS },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          runCuaActorSession({ ...options, provider: reader(summary) }),
        analysis: { run: vi.fn() },
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId!);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    // One participant: its stream in run.json carries its trace without the items.
    const stream = bundle.streams![0]!;
    return {
      ok: outcome.result.ok,
      judgedStatus: stream.judgedStatus,
      bundle,
      trace: stream.actor!,
    };
  }

  it("passes a report that declares it reached the goal and later paraphrases 'cannot'", async () => {
    const run = await runToCap(`REACHED THE GOAL.\n${IANA_PARAPHRASE}`);
    expect(run.trace.stopCause).toBe("session_cap");
    expect(run.judgedStatus).toBe("passed");
    expect(run.ok).toBe(true);
    expect(run.trace.declaredOutcome).toBe("reached");
    // The paraphrase still counts as reported friction: that scan stays inclusive.
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 1, reportedFriction: 1 });
    expect(run.bundle.review?.summary).toContain(
      "1 participant took part: 1/1 reported reaching the goal, 1 reported friction.",
    );
  });

  it("fails the run as a self-reported blocker when the report declares it was blocked", async () => {
    const run = await runToCap(`BLOCKED.\n${IANA_PARAPHRASE}`);
    expect(run.trace.declaredOutcome).toBe("blocked");
    expect(run.judgedStatus).toBe("blocked");
    expect(run.ok).toBe(false);
  });

  it("keeps the narrative verdict for a report that declares nothing and reads blocked", async () => {
    const run = await runToCap(IANA_PARAPHRASE);
    expect(run.trace.declaredOutcome).toBeUndefined();
    expect(run.judgedStatus).toBe("blocked");
    expect(run.ok).toBe(false);
  });

  it("keeps a planned end that passes when the report declares it did not reach the goal", async () => {
    const run = await runToCap(
      "DID NOT REACH THE GOAL.\nI read the opening hours page, and the session ended before I found the parking map.",
    );
    expect(run.trace).toMatchObject({
      status: "passed",
      completionReason: "goal_satisfied",
      stopCause: "session_cap",
      declaredOutcome: "not_reached",
    });
    expect(run.judgedStatus).toBe("passed");
    expect(run.ok).toBe(true);
    // It passes, and it is not counted or described as reaching the goal.
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 0, ranUntilEnd: 1 });
    expect(run.bundle.review?.summary).toContain(
      "1 participant took part: 0/1 recorded completions, 1 ran until its session cap.",
    );
    expect(run.bundle.simulations[0]!.summary).toBe(
      "Reader used the app in a hosted desktop browser, and ran until its session cap.",
    );
  });

  it("counts a passing report that declares nothing as running until the cap", async () => {
    const run = await runToCap(
      "I read the opening hours page, and the session ended before I found the parking map.",
    );
    expect(run.trace.declaredOutcome).toBeUndefined();
    expect(run.judgedStatus).toBe("passed");
    expect(run.ok).toBe(true);
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 0, ranUntilEnd: 1 });
    expect(run.bundle.review?.summary).toContain(
      "1 participant took part: 0/1 recorded completions, 1 ran until its session cap.",
    );
  });

  // The declaration says the goal was not reached and leaves open whether something stopped the
  // participant, so the summary still answers that, as it did before the declaration was recorded.
  it("fails the run as a self-reported blocker when a report that did not reach the goal describes a blocker", async () => {
    const run = await runToCap(
      "DID NOT REACH THE GOAL.\nThe login form returned an error and I could not sign in.",
    );
    expect(run.trace.declaredOutcome).toBe("not_reached");
    expect(run.judgedStatus).toBe("blocked");
    expect(run.ok).toBe(false);
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 0, blocked: 1 });
  });
});
