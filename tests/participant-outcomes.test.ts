// Participant outcomes are not harness failures (docs/principles/three-roles.md).
//
// A study involves three roles: a researcher who designs and runs it, a stakeholder who watches,
// and a participant who is the subject. Fusing the participant into the harness produced two bugs
// that these tests pin shut.
//
// `gave_up` mapped to `failed`, so a persona abandoning a task — the single most valuable thing a
// usability study produces — was recorded as the instrument breaking.
//
// `budget_reached` mapped to `passed`, so a session that ran out before reaching its goal was
// reported green. That is why "raise the timeout" kept landing on the operator instead of on the
// tool: the harness kept saying the truncated runs were fine.
import { describe, expect, it } from "vitest";

import { PARTICIPANT_OUTCOME_STATUSES, type ActorCompletionReason, type ActorStatus } from "../src/actor-contract.js";
import { statusForCompletionReason } from "../src/computer-use.js";

describe("completion reason -> status", () => {
  const expected: Array<[ActorCompletionReason, ActorStatus]> = [
    ["goal_satisfied", "passed"],
    ["turn_completed", "passed"],
    // The participant stopped trying. A finding about the product, not a malfunction.
    ["gave_up", "abandoned"],
    // The session ended before the goal was reached, however much work happened on the way.
    ["budget_reached", "incomplete"],
    ["timed_out", "timed_out"],
    ["blocked_approval", "blocked"],
    // Only the harness failing is a harness failure.
    ["actor_error", "failed"],
    ["step_failed", "failed"],
    ["harness_error", "failed"]
  ];

  for (const [reason, status] of expected) {
    it(`maps ${reason} to ${status}`, () => {
      expect(statusForCompletionReason(reason)).toBe(status);
    });
  }

  it("never calls an unfinished session a pass", () => {
    // The specific regression: budget_reached used to return "passed".
    expect(statusForCompletionReason("budget_reached")).not.toBe("passed");
    expect(statusForCompletionReason("gave_up")).not.toBe("passed");
  });

  it("reserves `failed` for the harness, so a run's status says who is at fault", () => {
    const harnessReasons: ActorCompletionReason[] = ["actor_error", "step_failed", "harness_error"];
    for (const reason of harnessReasons) expect(statusForCompletionReason(reason)).toBe("failed");
    // ...and nothing a participant did produces it.
    const participantReasons: ActorCompletionReason[] = ["gave_up", "budget_reached"];
    for (const reason of participantReasons) expect(statusForCompletionReason(reason)).not.toBe("failed");
  });
});

describe("PARTICIPANT_OUTCOME_STATUSES", () => {
  it("names the statuses that describe a person rather than a malfunction", () => {
    expect([...PARTICIPANT_OUTCOME_STATUSES].sort()).toEqual(["abandoned", "incomplete"]);
  });

  it("excludes both the pass and the genuine failure states", () => {
    for (const status of ["passed", "failed", "blocked", "timed_out"] as ActorStatus[]) {
      expect(PARTICIPANT_OUTCOME_STATUSES).not.toContain(status);
    }
  });
});
