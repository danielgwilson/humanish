import { describe, expect, it } from "vitest";

import { ACTOR_STATUSES } from "../../src/actors/contract.js";
import {
  hollowCompletion,
  participantPassed,
  participantStatus,
  selfReportedBlocker,
  verdictForStatus,
  type ParticipantFacts,
  type SessionEnding,
} from "../../src/run/judge.js";

const ending = (overrides: Partial<SessionEnding> = {}): SessionEnding => ({
  completionReason: "goal_satisfied",
  actions: 3,
  messages: 1,
  stopConditionMatched: false,
  closingReportReadsBlocked: false,
  ...overrides,
});

const passed = (overrides: Partial<ParticipantFacts> = {}): ParticipantFacts => ({
  status: "passed",
  completionReason: "goal_satisfied",
  skipped: false,
  noEngagement: false,
  selfReportedBlocker: false,
  ...overrides,
});

describe("hollowCompletion", () => {
  it("holds for a goal_satisfied session with no action and no message", () => {
    expect(hollowCompletion(ending({ actions: 0, messages: 0 }))).toBe(true);
  });

  it("is exempt when a stop condition ended the session", () => {
    expect(hollowCompletion(ending({ actions: 0, messages: 0, stopConditionMatched: true }))).toBe(
      false,
    );
  });

  it("does not hold once the participant acted or spoke, or when it did not claim the goal", () => {
    expect(hollowCompletion(ending({ actions: 1, messages: 0 }))).toBe(false);
    expect(hollowCompletion(ending({ actions: 0, messages: 1 }))).toBe(false);
    expect(
      hollowCompletion(ending({ actions: 0, messages: 0, completionReason: "timed_out" })),
    ).toBe(false);
  });
});

describe("selfReportedBlocker", () => {
  it("reads the closing report when the participant declared nothing", () => {
    expect(selfReportedBlocker(ending({ closingReportReadsBlocked: true }))).toBe(true);
    expect(selfReportedBlocker(ending())).toBe(false);
  });

  it("is exempt from the closing-report read when a stop condition ended the session", () => {
    expect(
      selfReportedBlocker(ending({ closingReportReadsBlocked: true, stopConditionMatched: true })),
    ).toBe(false);
  });

  it("takes a declared outcome over the closing report", () => {
    expect(
      selfReportedBlocker(ending({ declaredOutcome: "reached", closingReportReadsBlocked: true })),
    ).toBe(false);
    expect(selfReportedBlocker(ending({ declaredOutcome: "blocked" }))).toBe(true);
    // A declared blocker is not exempted by a stop condition: it is the participant's own word.
    expect(
      selfReportedBlocker(ending({ declaredOutcome: "blocked", stopConditionMatched: true })),
    ).toBe(true);
  });

  it("only applies to a session that claimed the goal", () => {
    expect(
      selfReportedBlocker(
        ending({ completionReason: "timed_out", closingReportReadsBlocked: true }),
      ),
    ).toBe(false);
    expect(
      selfReportedBlocker(ending({ completionReason: "gave_up", declaredOutcome: "blocked" })),
    ).toBe(false);
  });
});

describe("participantPassed", () => {
  it("passes a clean passed session", () => {
    expect(participantPassed(passed())).toBe(true);
  });

  it("fails every other case", () => {
    const cases: Array<[string, ParticipantFacts]> = [
      ["skipped", passed({ skipped: true })],
      ["no session", { skipped: false, noEngagement: false, selfReportedBlocker: false }],
      ["timed out", passed({ status: "timed_out", completionReason: "timed_out" })],
      ["harness error", passed({ completionReason: "harness_error" })],
      ["session error", passed({ sessionError: "desktop create failed" })],
      ["hollow completion", passed({ noEngagement: true })],
      ["self-reported blocker", passed({ selfReportedBlocker: true })],
      ["blocked", passed({ status: "blocked" })],
    ];
    for (const [name, facts] of cases) expect(participantPassed(facts), name).toBe(false);
  });
});

describe("participantStatus", () => {
  it("counts a hollow pass as incomplete and a self-reported blocker as blocked", () => {
    const judged = { noEngagement: false, selfReportedBlocker: false };
    expect(participantStatus("passed", { ...judged, noEngagement: true })).toBe("incomplete");
    expect(participantStatus("passed", { ...judged, selfReportedBlocker: true })).toBe("blocked");
    expect(participantStatus("passed", { noEngagement: true, selfReportedBlocker: true })).toBe(
      "incomplete",
    );
    expect(participantStatus("passed", judged)).toBe("passed");
    expect(participantStatus("passed", undefined)).toBe("passed");
  });

  it("leaves every status other than passed as it was", () => {
    for (const status of ACTOR_STATUSES.filter((entry) => entry !== "passed"))
      expect(participantStatus(status, { noEngagement: true, selfReportedBlocker: true })).toBe(
        status,
      );
  });
});

describe("verdictForStatus", () => {
  it("maps every participant status to a review verdict", () => {
    expect(Object.fromEntries(ACTOR_STATUSES.map((status) => [status, verdictForStatus(status)])))
      .toMatchInlineSnapshot(`
        {
          "abandoned": "fail",
          "blocked": "blocked",
          "failed": "fail",
          "incomplete": "fail",
          "passed": "pass",
          "timed_out": "timed_out",
        }
      `);
  });
});
