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
import type {
  ParticipantClosingReport,
  ParticipantDeclaredOutcome,
} from "../../../src/actors/contract.js";
import type { RunBundle, RunEvent } from "../../../src/run/bundle.js";
import { readReview } from "../../../src/run/stored-runs.js";
import { runStudyWith } from "../../../src/run-study.js";
import { parseStudy } from "../../../src/study/config.js";
import { lab } from "../../admission/fixtures.js";
import { makeFanoutModule } from "../../helpers/fanout-desktop.js";
import { writePersonaFiles } from "../../helpers/persona-files.js";

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

/** A participant who clicks once and then ends its session with `message`, declaring `outcome`. */
function ender(message: string, outcome: ParticipantDeclaredOutcome): CuaProvider {
  let turns = 0;
  return {
    ...reader(""),
    id: `ender-${outcome}`,
    async nextTurn() {
      turns += 1;
      return turns === 1
        ? { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false }
        : { actions: [], pendingSafetyChecks: [], done: true, message, outcome };
    },
  };
}

const SAVED = "REACHED THE GOAL. The note is saved.";
const SAVE_BLOCKED = "BLOCKED. The save button never enabled.";
const GAVE_UP = "DID NOT REACH THE GOAL. I could not find the export menu.";
/** Not a message: the participant's session throws before it ends. */
const SESSION_THROWS = "<the session throws>";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-closing-outcome-"));
  await writePersonaFiles(cwd, "first-time-visitor");
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

/**
 * Run one participant per message in roster order, one at a time, each ending its session with
 * its message: SAVE_BLOCKED declares a blocker, GAVE_UP declares the goal not reached,
 * SESSION_THROWS throws, and any other message declares the goal reached. A rerun runs the
 * participants it selects from `roster` participants, in roster order.
 */
async function runEnders(
  messages: readonly string[],
  rerun?: { sourceRunId: string; roster: number },
) {
  const parsed = parseStudy(
    lab("cuAppUrl", {
      mode: "live",
      participants: Array.from({ length: rerun?.roster ?? messages.length }, (_, index) => ({
        id: `p${index + 1}`,
      })),
      execution: { concurrency: 1 },
    }),
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  let next = 0;
  const outcome = await runStudyWith(
    parsed.config,
    {
      cwd,
      env: KEYS,
      ...(rerun === undefined ? {} : { rerun: { sourceRunId: rerun.sourceRunId } }),
    },
    {
      desktopModule: async () => makeFanoutModule().module,
      runSession: async (options: CuaActorSessionOptions) => {
        const message = messages[next++]!;
        if (message === SESSION_THROWS) throw new Error("The desktop stopped answering.");
        const declared =
          message === SAVE_BLOCKED ? "blocked" : message === GAVE_UP ? "not_reached" : "reached";
        return runCuaActorSession({ ...options, provider: ender(message, declared) });
      },
      analysis: { run: vi.fn() },
    },
  );
  if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
  const runId = outcome.result.runId;
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  const read = (file: string) => readFile(path.join(runDir, file), "utf8");
  const bundle = JSON.parse(await read("run.json")) as RunBundle;
  const events = (await read("events.ndjson"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
  const actorFiles = await Promise.all(
    bundle
      .streams!.flatMap((stream) =>
        stream.artifacts!.filter((artifact) => artifact.kind === "trace"),
      )
      .map(async (trace) => (JSON.parse(await read(trace.path)) as { status: string }).status),
  );
  const observer = JSON.parse(await read("observer/observer-data.json")) as {
    run: { participantsLine?: string };
  };
  return {
    runId,
    result: outcome.result,
    bundle,
    events,
    reviewMd: await read("review.md"),
    participantsLine: observer.run.participantsLine,
    actorFiles,
  };
}

/** Each participant's session event: its level and words. */
const sessionEvents = (events: readonly RunEvent[]) =>
  events
    .filter((event) => event.type === "cua-lab.session.goal_satisfied")
    .map(({ level, message }) => ({ level, message }));

/** Six participants, two of whom report a blocker. */
const SIX = [SAVED, SAVE_BLOCKED, SAVED, SAVED, SAVE_BLOCKED, SAVED];

describe("participants whose closing message reports a blocker", () => {
  it("get a warning session event in a fan-out run that names them blocked", async () => {
    const run = await runEnders(SIX);
    expect(sessionEvents(run.events)).toEqual([
      { level: "info", message: `Participant p1 passed: ${SAVED}` },
      { level: "warn", message: `Participant p2 blocked: ${SAVE_BLOCKED}` },
      { level: "info", message: `Participant p3 passed: ${SAVED}` },
      { level: "info", message: `Participant p4 passed: ${SAVED}` },
      { level: "warn", message: `Participant p5 blocked: ${SAVE_BLOCKED}` },
      { level: "info", message: `Participant p6 passed: ${SAVED}` },
    ]);
  });

  it("are counted as blocked in a fan-out run's review summary, which reads back the same", async () => {
    const run = await runEnders(SIX);
    expect(run.bundle.review.summary).toBe(
      "6 participants took part, each in their own copy of the app: 4/6 reported reaching the goal, 2 blocked, 2 reported friction; the gaps list the other 2.",
    );
    expect(run.reviewMd).toContain("4/6 reported reaching the goal, 2 blocked");
    expect(run.reviewMd).not.toContain("completion source unavailable");
    expect(await readReview(cwd, run.runId)).toMatchObject({ summary: run.bundle.review.summary });
    expect(run.participantsLine).toBe(
      "4/6 reported reaching the goal, 2 blocked, 2 reported friction",
    );
  });

  it("are counted by judged status in a fan-out run's result", async () => {
    const run = await runEnders(SIX);
    expect(run.result.ok).toBe(false);
    expect(run.result.laneSummary).toMatchObject({ passed: 4, judged: { passed: 4, blocked: 2 } });
    expect(run.result.error?.message).toBe(
      "Fan-out run failed: 4/6 participants passed, 2 blocked (across all 6: 0 skipped, 0 harness errors, 0 without engagement).",
    );
    expect(run.result.lanes!.map((lane) => [lane.id, lane.status, lane.judgedStatus])).toEqual([
      ["p1", "passed", "passed"],
      ["p2", "passed", "blocked"],
      ["p3", "passed", "passed"],
      ["p4", "passed", "passed"],
      ["p5", "passed", "blocked"],
      ["p6", "passed", "passed"],
    ]);
  });

  it("are counted beside the causes across all participants in a fan-out failure line", async () => {
    const run = await runEnders([SAVED, SAVE_BLOCKED, SESSION_THROWS]);
    // The failed participant is also the harness error, so the counts overlap.
    expect(run.result.error?.message).toBe(
      "Fan-out run failed: 1/3 participants passed, 1 blocked, 1 failed (across all 3: 0 skipped, 1 harness error, 0 without engagement).",
    );
  });

  it("are named by how the source run counted them and how their sessions ended in a rerun's event", async () => {
    const source = await runEnders([SAVED, SAVE_BLOCKED, GAVE_UP]);
    const rerun = await runEnders([SAVED, SAVED], { sourceRunId: source.runId, roster: 3 });
    expect(
      rerun.events
        .filter((event) => event.type === "cua-lab.fanout.rerun")
        .map((event) => event.message),
    ).toEqual([
      `Rerun selected 2 participants from ${source.runId}: p2 was blocked (session passed/goal_satisfied), p3 was abandoned/gave_up. This is a new linked run; the source run verdict is unchanged.`,
    ]);
  });

  it("keep passed as their session's status in every fan-out record of it", async () => {
    const run = await runEnders(SIX);
    const raw = new Set([
      ...run.actorFiles,
      ...run.bundle.simulations.map((simulation) => simulation.status),
      ...run.bundle.streams!.flatMap((stream) => [
        stream.status,
        stream.actor!.status,
        stream.ui!.actorStatus,
      ]),
      ...run.result.lanes!.map((lane) => lane.session!.status),
      run.result.session!.status,
    ]);
    expect([...raw]).toEqual(["passed"]);
    expect(run.bundle.streams!.map((stream) => stream.judgedStatus)).toEqual([
      "passed",
      "blocked",
      "passed",
      "passed",
      "blocked",
      "passed",
    ]);
  });

  it("gets a warning session event that names it blocked in a single-participant run", async () => {
    const run = await runEnders([SAVE_BLOCKED]);
    expect(sessionEvents(run.events)).toEqual([
      { level: "warn", message: `blocked: ${SAVE_BLOCKED}` },
    ]);
    expect(run.result.lanes!.map((lane) => [lane.status, lane.judgedStatus])).toEqual([
      ["passed", "blocked"],
    ]);
    expect(run.actorFiles).toEqual(["passed"]);
    expect(run.bundle.simulations[0]!.status).toBe("passed");
    expect(run.bundle.streams![0]!.judgedStatus).toBe("blocked");
  });
});
