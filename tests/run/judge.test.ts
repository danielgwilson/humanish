import { describe, expect, it } from "vitest";

import { ACTOR_STATUSES } from "../../src/actors/contract.js";
import {
  hollowCompletion,
  judgeOneParticipant,
  judgeParticipants,
  judgeSharedWorld,
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

describe("judgeOneParticipant", () => {
  const judge = (participant: ParticipantFacts | undefined, dryRun = false, inProgress = false) =>
    judgeOneParticipant({ dryRun, inProgress, participant });

  it("takes the verdict from the tallied status and ok from the pass rule", () => {
    expect(judge(passed())).toEqual({ verdict: "pass", allPassed: true });
    expect(judge(passed({ noEngagement: true }))).toEqual({ verdict: "fail", allPassed: false });
    expect(judge(passed({ selfReportedBlocker: true }))).toEqual({
      verdict: "blocked",
      allPassed: false,
    });
    expect(judge(passed({ status: "timed_out", completionReason: "timed_out" }))).toEqual({
      verdict: "timed_out",
      allPassed: false,
    });
    expect(judge(passed({ status: "failed", completionReason: "actor_error" }))).toEqual({
      verdict: "fail",
      allPassed: false,
    });
  });

  it("fails a run whose harness failed before a session, and holds a dry run as a contract", () => {
    const noSession = { skipped: false, noEngagement: false, selfReportedBlocker: false };
    expect(judge({ ...noSession, sessionError: "desktop create failed" })).toEqual({
      verdict: "fail",
      allPassed: false,
    });
    expect(judge(undefined, true)).toEqual({ verdict: "contract_proof_only", allPassed: true });
  });

  it("holds a run in progress as a contract", () => {
    expect(judge(passed(), false, true).verdict).toBe("contract_proof_only");
  });
});

describe("judgeParticipants", () => {
  const judge = (participants: ParticipantFacts[], expected = participants.length) =>
    judgeParticipants({ dryRun: false, inProgress: false, expected, participants });

  it("passes only when every expected participant passed", () => {
    expect(judge([passed(), passed()])).toEqual({ verdict: "pass", allPassed: true });
    expect(judge([passed()], 2)).toEqual({ verdict: "fail", allPassed: false });
  });

  it("fails on any participant that did not pass, unless one of them timed out", () => {
    for (const other of [
      passed({ noEngagement: true }),
      passed({ selfReportedBlocker: true }),
      passed({ skipped: true }),
      passed({ status: "failed", completionReason: "actor_error" }),
    ])
      expect(judge([passed(), other])).toEqual({ verdict: "fail", allPassed: false });
    expect(
      judge([passed(), passed({ status: "timed_out", completionReason: "timed_out" })]),
    ).toEqual({ verdict: "timed_out", allPassed: false });
  });

  it("does not call a run with a missing participant timed out", () => {
    expect(judge([passed({ status: "timed_out", completionReason: "timed_out" })], 2).verdict).toBe(
      "fail",
    );
  });

  it("holds dry and in-progress runs as contracts", () => {
    expect(
      judgeParticipants({ dryRun: true, inProgress: false, expected: 2, participants: [] }),
    ).toEqual({ verdict: "contract_proof_only", allPassed: true });
    expect(
      judgeParticipants({ dryRun: false, inProgress: true, expected: 2, participants: [] }).verdict,
    ).toBe("contract_proof_only");
  });
});

describe("judgeSharedWorld", () => {
  const world = { overlap: true };
  const judge = (participants: ParticipantFacts[], expected = participants.length) =>
    judgeSharedWorld({ dryRun: false, inProgress: false, expected, participants, world });

  it("passes only when every expected seat passed, and has no timed_out verdict", () => {
    expect(judge([passed(), passed()])).toEqual({ verdict: "pass", allPassed: true, world });
    for (const other of [
      passed({ status: "timed_out", completionReason: "timed_out" }),
      passed({ noEngagement: true }),
      passed({ selfReportedBlocker: true }),
      passed({ sessionError: "provider exploded" }),
    ])
      expect(judge([passed(), other])).toMatchObject({ verdict: "fail", allPassed: false });
    expect(judge([passed()], 2)).toMatchObject({ verdict: "fail", allPassed: false });
  });

  it("records the world facts without reading them for the verdict", () => {
    const quiet = { overlap: false, lobbyConvergence: false };
    expect(
      judgeSharedWorld({
        dryRun: false,
        inProgress: false,
        expected: 1,
        participants: [passed()],
        world: quiet,
      }),
    ).toEqual({ verdict: "pass", allPassed: true, world: quiet });
  });

  it("holds dry and in-progress runs as contracts", () => {
    expect(
      judgeSharedWorld({ dryRun: true, inProgress: false, expected: 2, participants: [], world }),
    ).toMatchObject({ verdict: "contract_proof_only", allPassed: true });
    expect(
      judgeSharedWorld({ dryRun: false, inProgress: true, expected: 2, participants: [], world })
        .verdict,
    ).toBe("contract_proof_only");
  });
});
