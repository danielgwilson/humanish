// A participant with a session cap may end its session whenever it is done. From the start of its
// wind-down each turn tells it when the session ends at the latest; at the cap the loop asks for the
// closing report and ends the session as a planned end with stop cause `session_cap`.

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
// 2026-10-12 09:00 UTC.
const NINE_UTC = Date.UTC(2026, 9, 12, 9, 0);
// A 10-minute cap on a session that starts at 09:00, told the time left from 09:07.
const CAP: ParticipantClock = {
  end: { atMs: NINE_UTC + 10 * MINUTE, windDownMs: 3 * MINUTE, kind: "session_cap" },
};

/**
 * A visitor whose every turn takes a minute of the clock and clicks somewhere new, until it ends
 * the session itself on the turn `endsItself` names, if any.
 */
function visit(
  clock: ParticipantClock,
  options: { endsItself?: number; report?: false } = {},
): { done: Promise<CuaLoopResult>; seen: CuaTurnRequest[]; debriefs: CuaTurnRequest[] } {
  let t = NINE_UTC;
  const seen: CuaTurnRequest[] = [];
  const debriefs: CuaTurnRequest[] = [];
  const provider: CuaProvider = {
    id: "visitor",
    capabilities: CAPS,
    async nextTurn(request) {
      seen.push(request);
      t += MINUTE;
      if (seen.length === options.endsItself)
        return {
          actions: [],
          pendingSafetyChecks: [],
          done: true,
          message: "REACHED THE GOAL. I found the opening hours.",
        };
      return {
        actions: [{ kind: "click", x: seen.length, y: 1 }],
        pendingSafetyChecks: [],
        done: false,
        message: `Reading page ${seen.length}.`,
      };
    },
    async debrief(request) {
      debriefs.push(request);
      return {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        message: "Out of time.",
        ...(options.report === false
          ? {}
          : { closingReport: { summary: "I read ten pages.", frictionReports: [] } }),
      };
    },
  };
  let observed = 0;
  const done = runComputerUseLoop({
    instructions: "Find the opening hours.",
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
  });
  return { done, seen, debriefs };
}

const CLOSE =
  "You may end it sooner when you are done. If you are still working then, it ends by itself, and you will then be asked for your closing account.";

describe("a participant with a session cap", () => {
  it("ends its own session before the cap and passes, with no stop cause", async () => {
    const run = visit(CAP, { endsItself: 3 });
    const result = await run.done;
    expect(run.seen).toHaveLength(3);
    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
    expect(result.reason).toBe("REACHED THE GOAL. I found the opening hours.");
    expect(run.debriefs).toHaveLength(0);
  });

  it("is told when its session ends at the latest from the start of its wind-down", async () => {
    const run = visit(CAP);
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
      `Your session ends at 09:10 UTC at the latest, in 3 minutes. ${CLOSE}`,
      `Your session ends at 09:10 UTC at the latest, in 2 minutes. ${CLOSE}`,
      `Your session ends at 09:10 UTC at the latest, in 1 minute. ${CLOSE}`,
    ]);
  });

  it("ends at its cap with its closing report as its reason, as a planned end that passes", async () => {
    const run = visit(CAP);
    const result = await run.done;
    expect(run.seen).toHaveLength(10);
    expect(run.debriefs).toHaveLength(1);
    expect(result.status).toBe("passed");
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBe("session_cap");
    expect(result.reason).toBe("I read ten pages.");
    expect(result.trace.debrief).toMatchObject({
      trigger: "session_cap",
      status: "completed",
      report: { summary: "I read ten pages.", frictionReports: [] },
    });
  });

  it("keeps the cap as its reason when no closing report came back", async () => {
    const run = visit(CAP, { report: false });
    const result = await run.done;
    expect(result.trace.debrief).toMatchObject({ trigger: "session_cap", status: "failed" });
    expect(result.reason).toBe("the participant's session reached its cap at 09:10 UTC");
  });
});

/** A visitor that only waits, 10 s of the clock apart, on a screen that never changes. */
async function waitingVisit(clock: ParticipantClock): Promise<{
  result: CuaLoopResult;
  turns: number;
}> {
  let t = NINE_UTC;
  let turns = 0;
  const provider: CuaProvider = {
    id: "visitor",
    capabilities: CAPS,
    async nextTurn() {
      turns += 1;
      t += 10_000;
      return { actions: [{ kind: "wait" }], pendingSafetyChecks: [], done: false };
    },
  };
  const result = await runComputerUseLoop({
    instructions: "Wait for the page to change.",
    provider,
    executor: {
      observe: async () => ({ screenshot: FRAME, stateSignature: "unchanged" }),
      execute: async () => undefined,
    },
    persona,
    redaction: defaultRedactionHooks,
    timeoutMs: 60 * MINUTE,
    now: () => t,
    sleep: async () => undefined,
    clock,
  });
  return { result, turns };
}

describe("waiting under a session cap", () => {
  it("ends a capped participant that only waits as it ends one without a cap", async () => {
    // Turn 1 sets the repetition baseline; turns 2 to 21 repeat the wait on an unchanged screen.
    const { result, turns } = await waitingVisit(CAP);
    expect(result.completionReason).toBe("gave_up");
    expect(turns).toBe(21);
  });
});
