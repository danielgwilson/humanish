// A participant still working at its clock end gives its closing report, and the run is judged on
// what that report declares in its outcome field or its first line. Fake desktops and a fake
// provider ($0, real orchestration, real time with a sub-second wind-down). The first case is the
// shape of a live run on https://example.com/ whose participant reached the goal and then
// paraphrased the domain registry's page.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaProvider } from "../../../src/actors/computer-use/loop.js";
import type { ParticipantClosingReport } from "../../../src/actors/contract.js";
import type { RunBundle } from "../../../src/run/bundle.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule } from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

const IANA_PARAPHRASE =
  "I opened Example Domain and followed the More information link to the IANA page. The IANA page explained that example domains are reserved for documentation and cannot be registered or transferred.";

/**
 * A reader who takes a turn every 100 ms until its clock end, then gives `report` as its closing
 * report, or a report whose summary is `report`.
 */
function reader(report: string | ParticipantClosingReport): CuaProvider {
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
        closingReport:
          typeof report === "string" ? { summary: report, frictionReports: [] } : report,
      };
    },
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-closing-outcome-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/** Run one reader to its session cap or scheduled end, and read its stream from run.json. */
async function runToEnd(
  report: string | ParticipantClosingReport,
  end: "session_cap" | "scheduled_end" = "session_cap",
) {
  const clock = end === "session_cap" ? { maxSessionMs: 1_000 } : { endAfterMs: 1_000 };
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants: [{ id: "reader", ...clock, windDownMs: 500 }],
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
        runCuaActorSession({ ...options, provider: reader(report) }),
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

describe("a closing report at a session cap", () => {
  it("passes a report that declares it reached the goal and later paraphrases 'cannot'", async () => {
    const run = await runToEnd(`REACHED THE GOAL.\n${IANA_PARAPHRASE}`);
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
    const run = await runToEnd(`BLOCKED.\n${IANA_PARAPHRASE}`);
    expect(run.trace.declaredOutcome).toBe("blocked");
    expect(run.judgedStatus).toBe("blocked");
    expect(run.ok).toBe(false);
  });

  it("keeps the narrative verdict for a report that declares nothing and reads blocked", async () => {
    const run = await runToEnd(IANA_PARAPHRASE);
    expect(run.trace.declaredOutcome).toBeUndefined();
    expect(run.judgedStatus).toBe("blocked");
    expect(run.ok).toBe(false);
  });

  it("keeps a planned end that passes when the report declares it did not reach the goal", async () => {
    const run = await runToEnd(
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
    const run = await runToEnd(
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
    const run = await runToEnd(
      "DID NOT REACH THE GOAL.\nThe login form returned an error and I could not sign in.",
    );
    expect(run.trace.declaredOutcome).toBe("not_reached");
    expect(run.judgedStatus).toBe("blocked");
    expect(run.ok).toBe(false);
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 0, blocked: 1 });
  });
});

describe("a closing report's outcome field at a clock end", () => {
  // The shape of an OpenAI participant on https://example.com/ whose summary opens with what it
  // did and declares nothing in its first line.
  const READ_THE_PAGE =
    "I stayed on the Example Domain page, read its English description, and learned that the domain is reserved for use in documentation examples.";

  it("counts a report whose outcome is reached as reaching the goal at its scheduled end", async () => {
    const run = await runToEnd(
      { outcome: "reached", summary: READ_THE_PAGE, frictionReports: [] },
      "scheduled_end",
    );
    expect(run.trace).toMatchObject({ stopCause: "scheduled_end", declaredOutcome: "reached" });
    expect(run.judgedStatus).toBe("passed");
    expect(run.ok).toBe(true);
    // A count of zero is left out of the review.
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 1 });
    expect(run.bundle.review?.participants).not.toHaveProperty("ranUntilEnd");
  });

  it("counts a report whose outcome is not_reached as running until its scheduled end", async () => {
    const run = await runToEnd(
      {
        outcome: "not_reached",
        summary:
          "I read the Example Domain page, and the session ended before I found a pricing table.",
        frictionReports: [],
      },
      "scheduled_end",
    );
    expect(run.trace).toMatchObject({ stopCause: "scheduled_end", declaredOutcome: "not_reached" });
    expect(run.judgedStatus).toBe("passed");
    expect(run.ok).toBe(true);
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 0, ranUntilEnd: 1 });
  });

  it("fails the run as a self-reported blocker when the report's outcome at the cap is blocked", async () => {
    const run = await runToEnd(
      { outcome: "blocked", summary: READ_THE_PAGE, frictionReports: [] },
      "session_cap",
    );
    expect(run.trace).toMatchObject({ stopCause: "session_cap", declaredOutcome: "blocked" });
    expect(run.judgedStatus).toBe("blocked");
    expect(run.ok).toBe(false);
  });

  it("reads the outcome field before the summary's first line", async () => {
    const run = await runToEnd(
      {
        outcome: "not_reached",
        summary: `REACHED THE GOAL.\n${READ_THE_PAGE}`,
        frictionReports: [],
      },
      "session_cap",
    );
    expect(run.trace.declaredOutcome).toBe("not_reached");
    expect(run.bundle.review?.participants).toMatchObject({ reachedGoal: 0, ranUntilEnd: 1 });
  });
});
