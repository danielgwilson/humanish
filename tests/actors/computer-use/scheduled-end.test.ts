// A participant with a scheduled end works until a time on the run's clock. From the start of its
// wind-down each turn tells it the end time and the minutes left; at the end the loop asks for the
// closing report and ends the session as a planned end. An optional time zone adds the local time.

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import type { ActorCapabilities, ActorPersonaRef } from "../../../src/actors/contract.js";
import {
  runComputerUseLoop,
  type CuaLoopResult,
  type CuaProvider,
  type CuaTurnRequest,
  type ParticipantClock,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

const CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};
const persona: ActorPersonaRef = { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" };
const FRAME = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const MINUTE = 60_000;
// 2026-10-12 09:00 UTC, which is 02:00 in Los Angeles (daylight time until 1 November).
const NINE_UTC = Date.UTC(2026, 9, 12, 9, 0);

/**
 * A staff participant whose every turn takes a minute of the clock and clicks somewhere new. It
 * never ends on its own. Its closing report is the one the debrief returns.
 */
function shift(
  clock: ParticipantClock,
  options: { endsItself?: (turn: number) => boolean; idleSteps?: number } = {},
): {
  done: Promise<CuaLoopResult>;
  seen: CuaTurnRequest[];
  debriefs: CuaTurnRequest[];
} {
  let t = NINE_UTC;
  const seen: CuaTurnRequest[] = [];
  const debriefs: CuaTurnRequest[] = [];
  const provider: CuaProvider = {
    id: "staff",
    capabilities: CAPS,
    async nextTurn(request) {
      seen.push(request);
      t += MINUTE;
      if (options.endsItself?.(seen.length) === true)
        return {
          actions: [],
          pendingSafetyChecks: [],
          done: true,
          message: "REACHED THE GOAL. Everyone is checked in.",
        };
      return {
        actions: [{ kind: "click", x: seen.length, y: 1 }],
        pendingSafetyChecks: [],
        done: false,
        message: `Seeing patient ${seen.length}.`,
      };
    },
    async debrief(request) {
      debriefs.push(request);
      return {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        message: "Shift over.",
        closingReport: { summary: "I saw ten patients.", frictionReports: [] },
      };
    },
  };
  let observed = 0;
  const done = runComputerUseLoop({
    instructions: "Work the front desk until your shift ends.",
    provider,
    executor: {
      observe: async () => ({ screenshot: FRAME, stateSignature: `s${(observed += 1)}` }),
      execute: async () => undefined,
    },
    persona,
    redaction: defaultRedactionHooks,
    timeoutMs: 60 * MINUTE,
    now: () => t,
    clock,
    ...(options.idleSteps === undefined ? {} : { idleSteps: options.idleSteps }),
  });
  return { done, seen, debriefs };
}

const CLOSE =
  "Keep working until then. The session ends by itself at that time, and you will then be asked for your closing account.";

describe("a participant with a scheduled end", () => {
  it("is told the end time and the minutes left from the start of its wind-down", async () => {
    const run = shift({ end: { atMs: NINE_UTC + 10 * MINUTE, windDownMs: 3 * MINUTE } });
    await run.done;
    // Turn n is requested at 09:0(n-1); the wind-down starts at 09:07, turn 8.
    expect(run.seen.map((request) => request.contextHint)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      `Your session ends at 09:10 UTC, in 3 minutes. ${CLOSE}`,
      `Your session ends at 09:10 UTC, in 2 minutes. ${CLOSE}`,
      `Your session ends at 09:10 UTC, in 1 minute. ${CLOSE}`,
    ]);
  });

  it("ends at its time with a closing report, as a planned end that passes", async () => {
    const run = shift({ end: { atMs: NINE_UTC + 10 * MINUTE, windDownMs: 3 * MINUTE } });
    const result = await run.done;
    expect(run.seen).toHaveLength(10);
    expect(run.debriefs).toHaveLength(1);
    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBe("scheduled_end");
    expect(result.reason).toBe("the participant's scheduled end at 09:10 UTC was reached");
    expect(result.trace.debrief).toMatchObject({
      trigger: "scheduled_end",
      status: "completed",
      report: { summary: "I saw ten patients.", frictionReports: [] },
    });
  });

  it("adds the local time to every turn when the actor declares a time zone", async () => {
    const run = shift({
      timeZone: "America/Los_Angeles",
      end: { atMs: NINE_UTC + 10 * MINUTE, windDownMs: 3 * MINUTE },
    });
    await run.done;
    expect(run.seen[0]?.contextHint).toBe("The local time is 02:00 (America/Los_Angeles).");
    expect(run.seen[7]?.contextHint).toBe(
      `The local time is 02:07 (America/Los_Angeles). Your session ends at 02:10, in 3 minutes. ${CLOSE}`,
    );
  });

  it("keeps a participant that ends itself before its end working, told the time left", async () => {
    // It ends itself on turn 3, at 09:02, and then goes back to work.
    const run = shift(
      { end: { atMs: NINE_UTC + 10 * MINUTE, windDownMs: 3 * MINUTE } },
      { endsItself: (turn) => turn === 3 },
    );
    const result = await run.done;
    expect(run.seen[3]?.contextHint).toBe(
      `Your session is not over. Your session ends at 09:10 UTC, in 7 minutes. ${CLOSE}`,
    );
    expect(result.trace.stopCause).toBe("scheduled_end");
    expect(result.status).toBe("passed");
  });

  it("ends a participant that keeps ending itself before its end when its idle streak trips", async () => {
    const run = shift(
      { end: { atMs: NINE_UTC + 10 * MINUTE, windDownMs: 3 * MINUTE } },
      { endsItself: (turn) => turn >= 3, idleSteps: 3 },
    );
    const result = await run.done;
    // Turns 3, 4 and 5 take no action; the third trips the streak.
    expect(run.seen).toHaveLength(5);
    expect(result.completionReason).toBe("gave_up");
  });
});

/**
 * A staff participant on a quiet shift: every turn only waits, 10 s of the clock apart, on a
 * screen that never changes.
 */
async function quietShift(clock: ParticipantClock | undefined): Promise<{
  result: CuaLoopResult;
  turns: number;
}> {
  let t = NINE_UTC;
  let turns = 0;
  const provider: CuaProvider = {
    id: "staff",
    capabilities: CAPS,
    async nextTurn() {
      turns += 1;
      t += 10_000;
      return { actions: [{ kind: "wait" }], pendingSafetyChecks: [], done: false };
    },
    async debrief() {
      return {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        closingReport: { summary: "No patient came.", frictionReports: [] },
      };
    },
  };
  const result = await runComputerUseLoop({
    instructions: "Wait at the front desk for patients until your shift ends.",
    provider,
    executor: {
      observe: async () => ({ screenshot: FRAME, stateSignature: "empty waiting room" }),
      execute: async () => undefined,
    },
    persona,
    redaction: defaultRedactionHooks,
    timeoutMs: 60 * MINUTE,
    now: () => t,
    sleep: async () => undefined,
    ...(clock === undefined ? {} : { clock }),
  });
  return { result, turns };
}

describe("waiting on a quiet shift", () => {
  it("does not end a participant with a scheduled end for waiting before its end", async () => {
    // 60 waiting turns, past both the 24-turn idle and the 20-turn no-progress streaks.
    const { result, turns } = await quietShift({
      end: { atMs: NINE_UTC + 10 * MINUTE, windDownMs: 3 * MINUTE },
    });
    expect(turns).toBe(60);
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBe("scheduled_end");
    expect(result.trace.debrief?.status).toBe("completed");
  });

  it("still ends a participant without a scheduled end that only waits", async () => {
    // Turn 1 sets the repetition baseline; turns 2 to 21 repeat the wait on an unchanged screen.
    const { result, turns } = await quietShift(undefined);
    expect(result.completionReason).toBe("gave_up");
    expect(turns).toBe(21);
  });
});
