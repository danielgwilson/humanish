import { describe, expect, it } from "vitest";

import {
  ACTOR_STATUSES,
  type ActorCompletionReason,
  type ActorStatus,
} from "../../src/actors/contract.js";
import { REVIEW_SCHEMA, type ReviewSummary } from "../../src/run/bundle.js";
import {
  foldScorerFailures,
  hollowCompletion,
  judgeOneParticipant,
  judgeParticipants,
  judgeScripted,
  judgeSharedWorld,
  judgeTerminal,
  participantPassed,
  participantStatus,
  selfReportedBlocker,
  sharedWorldShortfall,
  verdictForStatus,
  type ParticipantFacts,
  type SessionEnding,
  type SharedWorldFacts,
  judgeExecution,
  judgePreview,
  OUTCOME_POLICIES,
  participantHarnessFailed,
  resultOk,
  type ExecutionFailure,
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
    expect(judge(passed())).toEqual({ verdict: "pass", passed: true });
    expect(judge(passed({ noEngagement: true }))).toEqual({ verdict: "fail", passed: false });
    expect(judge(passed({ selfReportedBlocker: true }))).toEqual({
      verdict: "blocked",
      passed: false,
    });
    expect(judge(passed({ status: "timed_out", completionReason: "timed_out" }))).toEqual({
      verdict: "timed_out",
      passed: false,
    });
    expect(judge(passed({ status: "failed", completionReason: "actor_error" }))).toEqual({
      verdict: "fail",
      passed: false,
    });
  });

  it("fails a run whose harness failed before a session, and holds a dry run as a contract", () => {
    const noSession = { skipped: false, noEngagement: false, selfReportedBlocker: false };
    expect(judge({ ...noSession, sessionError: "desktop create failed" })).toEqual({
      verdict: "fail",
      passed: false,
    });
    expect(judge(undefined, true)).toEqual({ verdict: "contract_proof_only", passed: true });
  });

  it("fails a run whose session threw an error with an empty message", () => {
    const noSession = { skipped: false, noEngagement: false, selfReportedBlocker: false };
    expect(judge({ ...noSession, sessionError: "" })).toEqual({
      verdict: "fail",
      passed: false,
    });
  });

  it("holds a run in progress as a contract", () => {
    expect(judge(passed(), false, true).verdict).toBe("contract_proof_only");
  });
});

describe("judgeTerminal", () => {
  const judge = (participant: ParticipantFacts | undefined, dryRun = false) =>
    judgeTerminal({ dryRun, participant });

  it("takes the verdict from the agent's status, as the one-participant rule does", () => {
    expect(judge(passed())).toEqual({ verdict: "pass", passed: true });
    expect(judge(passed({ status: "blocked", completionReason: "blocked_approval" }))).toEqual({
      verdict: "blocked",
      passed: false,
    });
    expect(judge(passed({ status: "timed_out", completionReason: "timed_out" }))).toEqual({
      verdict: "timed_out",
      passed: false,
    });
    expect(judge(passed({ status: "failed", completionReason: "gave_up" }))).toEqual({
      verdict: "fail",
      passed: false,
    });
  });

  it("holds a dry run as a contract", () => {
    expect(judge(undefined, true)).toEqual({ verdict: "contract_proof_only", passed: true });
  });
});

describe("participantHarnessFailed", () => {
  it("holds for a session error or a harness_error ending, a blown cap included", () => {
    expect(participantHarnessFailed(passed())).toBe(false);
    expect(participantHarnessFailed(passed({ sessionError: "" }))).toBe(true);
    expect(
      participantHarnessFailed(
        passed({
          status: "failed",
          completionReason: "harness_error",
          sessionError: "known spend over the cap",
        }),
      ),
    ).toBe(true);
    expect(
      participantHarnessFailed(passed({ status: "failed", completionReason: "gave_up" })),
    ).toBe(false);
  });
});

describe("judgeParticipants", () => {
  const judge = (participants: ParticipantFacts[], expected = participants.length) =>
    judgeParticipants({ dryRun: false, inProgress: false, expected, participants });

  it("passes only when every expected participant passed", () => {
    expect(judge([passed(), passed()])).toEqual({ verdict: "pass", passed: true });
    expect(judge([passed()], 2)).toEqual({ verdict: "fail", passed: false });
  });

  it("fails on any participant that did not pass, unless one of them timed out", () => {
    for (const other of [
      passed({ noEngagement: true }),
      passed({ selfReportedBlocker: true }),
      passed({ skipped: true }),
      passed({ status: "failed", completionReason: "actor_error" }),
    ])
      expect(judge([passed(), other])).toEqual({ verdict: "fail", passed: false });
    expect(
      judge([passed(), passed({ status: "timed_out", completionReason: "timed_out" })]),
    ).toEqual({ verdict: "timed_out", passed: false });
  });

  it("does not call a run with a missing participant timed out", () => {
    expect(judge([passed({ status: "timed_out", completionReason: "timed_out" })], 2).verdict).toBe(
      "fail",
    );
  });

  it("holds dry and in-progress runs as contracts", () => {
    expect(
      judgeParticipants({ dryRun: true, inProgress: false, expected: 2, participants: [] }),
    ).toEqual({ verdict: "contract_proof_only", passed: true });
    expect(
      judgeParticipants({ dryRun: false, inProgress: true, expected: 2, participants: [] }).verdict,
    ).toBe("contract_proof_only");
  });
});

describe("judgeScripted", () => {
  const surface = (status: ActorStatus, completionReason: ActorCompletionReason) =>
    passed({ status, completionReason });
  const ok = surface("passed", "goal_satisfied");
  const stepFailed = surface("failed", "step_failed");
  const timedOut = surface("timed_out", "timed_out");
  const harnessError = surface("failed", "harness_error");
  const judge = (surfaces: ParticipantFacts[], sessionError?: string) =>
    judgeScripted({ dryRun: false, sessionError, expected: 2, surfaces });

  // The worst surface decides: a harness error or failed step, then a timeout, then a pass. The
  // run passed when every expected surface passed.
  it.each<[string, ParticipantFacts[], string | undefined, string, boolean]>([
    ["every surface passed", [ok, ok], undefined, "pass", true],
    ["a failed step", [ok, stepFailed], undefined, "fail", false],
    ["a timeout", [ok, timedOut], undefined, "timed_out", false],
    ["a failed step outranks a timeout", [timedOut, stepFailed], undefined, "fail", false],
    ["a harness error", [ok, harnessError], undefined, "fail", false],
    ["a surface that never returned", [ok], undefined, "pass", false],
    ["a session error", [], "browser pool exploded", "fail", false],
    ["a session error with an empty message", [], "", "fail", false],
  ])("%s", (_name, surfaces, sessionError, verdict, wasPassed) => {
    expect(judge(surfaces, sessionError)).toEqual({ verdict, passed: wasPassed });
  });

  it("holds a dry run as a contract", () => {
    expect(
      judgeScripted({ dryRun: true, sessionError: undefined, expected: 2, surfaces: [] }),
    ).toEqual({ verdict: "contract_proof_only", passed: true });
  });
});

describe("judgePreview", () => {
  it("is a contract with no participants", () => {
    expect(judgePreview()).toEqual({ verdict: "contract_proof_only", passed: true });
  });
});

describe("judgeSharedWorld", () => {
  const world = { overlap: true };
  const judge = (participants: ParticipantFacts[], expected = participants.length) =>
    judgeSharedWorld({ dryRun: false, inProgress: false, expected, participants, world });

  it("passes only when every expected seat passed, and has no timed_out verdict", () => {
    expect(judge([passed(), passed()])).toEqual({ verdict: "pass", passed: true, world });
    for (const other of [
      passed({ status: "timed_out", completionReason: "timed_out" }),
      passed({ noEngagement: true }),
      passed({ selfReportedBlocker: true }),
      passed({ sessionError: "provider exploded" }),
    ])
      expect(judge([passed(), other])).toMatchObject({ verdict: "fail", passed: false });
    expect(judge([passed()], 2)).toMatchObject({ verdict: "fail", passed: false });
  });

  // What verify's shared-world check requires of a pass, per plane: provisioned needs overlap and a
  // state change under it; external-public needs overlap only. Lobby convergence is not read.
  it.each<[string, SharedWorldFacts, boolean]>([
    [
      "provisioned overlap with a state change",
      { overlap: true, stateChangedUnderOverlap: true },
      true,
    ],
    [
      "provisioned overlap without a state change",
      { overlap: true, stateChangedUnderOverlap: false },
      false,
    ],
    [
      "provisioned seats that never overlapped",
      { overlap: false, stateChangedUnderOverlap: false },
      false,
    ],
    [
      "external overlap without lobby convergence",
      { overlap: true, lobbyConvergence: false },
      true,
    ],
    ["external seats that never overlapped", { overlap: false, lobbyConvergence: true }, false],
  ])("gates a pass on the world facts: %s", (_name, facts, passes) => {
    const judgment = judgeSharedWorld({
      dryRun: false,
      inProgress: false,
      expected: 2,
      participants: [passed(), passed()],
      world: facts,
    });
    expect(judgment).toEqual({
      verdict: passes ? "pass" : "fail",
      passed: passes,
      world: facts,
    });
    expect(sharedWorldShortfall(facts) === undefined).toBe(passes);
  });

  it("holds dry and in-progress runs as contracts", () => {
    expect(
      judgeSharedWorld({ dryRun: true, inProgress: false, expected: 2, participants: [], world }),
    ).toMatchObject({ verdict: "contract_proof_only", passed: true });
    expect(
      judgeSharedWorld({ dryRun: false, inProgress: true, expected: 2, participants: [], world })
        .verdict,
    ).toBe("contract_proof_only");
  });
});

describe("foldScorerFailures", () => {
  const VERDICTS = ["contract_proof_only", "pass", "fail", "blocked", "timed_out"] as const;
  const review = (verdict: (typeof VERDICTS)[number]): ReviewSummary => ({
    schema: REVIEW_SCHEMA,
    verdict,
    summary: "judged",
    gaps: ["an earlier gap"],
  });

  it("returns the judged review unchanged when the scorer found nothing", () => {
    for (const verdict of VERDICTS) {
      const judged = review(verdict);
      expect(foldScorerFailures(judged, [])).toBe(judged);
    }
  });

  // Scoring can never improve a verdict: a pass or a contract can only become a fail, and a
  // fail, blocked or timed_out verdict stays exactly what the judge said.
  it.each(VERDICTS)("never improves a %s verdict", (verdict) => {
    for (const failures of [["scorer failed"], ["scorer failed", "scorer threw"]]) {
      const folded = foldScorerFailures(review(verdict), failures);
      const flips = verdict === "pass" || verdict === "contract_proof_only";
      expect(folded.verdict).toBe(flips ? "fail" : verdict);
      expect(folded.summary).toBe(flips ? "scorer failed" : "judged");
      expect(folded.gaps).toEqual(["an earlier gap", ...failures]);
    }
  });

  it("records a failure the review already names once", () => {
    const judged = { ...review("fail"), gaps: ["scorer failed"] };
    expect(foldScorerFailures(judged, ["scorer failed"]).gaps).toEqual(["scorer failed"]);
  });
});

describe("the outcome policies", () => {
  const failure = (kind: ExecutionFailure["kind"]): ExecutionFailure => ({ kind, message: kind });

  it("names each route's policy in one table", () => {
    expect(OUTCOME_POLICIES).toEqual({
      "computer-use": { participants: "gate", sandboxCleanup: "warns", evidence: "fails" },
      "shared-world": { participants: "gate", sandboxCleanup: "warns", evidence: "fails" },
      terminal: { participants: "evidence", sandboxCleanup: "fails", evidence: "fails" },
      scripted: { participants: "evidence", sandboxCleanup: "warns", evidence: "fails" },
      preview: { participants: "evidence", sandboxCleanup: "warns", evidence: "warns" },
    });
  });

  // Harness, provider-cleanup, cap and run failures always fail the execution; sandbox-cleanup and
  // evidence fail it only where the policy says so, and are dropped where it lets them warn.
  it.each(["harness", "provider-cleanup", "cap", "run"] as const)(
    "always counts a %s failure",
    (kind) => {
      for (const policy of Object.values(OUTCOME_POLICIES)) {
        expect(judgeExecution([failure(kind)], policy)).toEqual({
          succeeded: false,
          failures: [failure(kind)],
        });
      }
    },
  );

  it("counts sandbox-cleanup and evidence failures as each policy says", () => {
    const counted = (route: keyof typeof OUTCOME_POLICIES) =>
      judgeExecution(
        [failure("sandbox-cleanup"), failure("evidence")],
        OUTCOME_POLICIES[route],
      ).failures.map((entry) => entry.kind);
    expect(counted("computer-use")).toEqual(["evidence"]);
    expect(counted("shared-world")).toEqual(["evidence"]);
    expect(counted("terminal")).toEqual(["sandbox-cleanup", "evidence"]);
    expect(counted("scripted")).toEqual(["evidence"]);
    expect(counted("preview")).toEqual([]);
  });

  // ok reads the execution and the scorer everywhere, and the participants only on a gate route:
  // on an evidence route a participant that did not pass is captured evidence.
  it.each<[string, boolean, boolean, string[], boolean, boolean]>([
    ["everything passed", true, true, [], true, true],
    ["a participant did not pass", false, true, [], false, true],
    ["the execution failed", true, false, [], false, false],
    ["a scorer failed", true, true, ["rubric failed"], false, false],
  ])(
    "%s: gate ok %s, evidence ok %s",
    (_name, wasPassed, succeeded, scorerFailures, gate, evidence) => {
      const args = {
        judgment: { verdict: wasPassed ? ("pass" as const) : ("fail" as const), passed: wasPassed },
        execution: { succeeded, failures: succeeded ? [] : [failure("harness")] },
        scorerFailures,
      };
      expect(resultOk({ ...args, policy: OUTCOME_POLICIES["computer-use"] })).toBe(gate);
      expect(resultOk({ ...args, policy: OUTCOME_POLICIES.terminal })).toBe(evidence);
    },
  );
});
