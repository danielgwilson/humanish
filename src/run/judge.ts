// How humanish judges a run. A route reduces what happened to plain facts and judges them here
// once. Two facts come out: what the participants experienced (the verdict, which the bundle and
// status.json show) and whether the run worked as an execution. The result's ok reads both under
// the route's policy. The file reads in the order a run is judged:
//   1. session and participant predicates (hollowCompletion, selfReportedBlocker, judgedStatus,
//      participantPassed, participantHarnessFailed);
//   2. the judgment shapes (Judgment and judgmentOf, SharedWorldJudgment, ExecutionOutcome,
//      OutcomePolicy);
//   3. one judge per route: computer-use calls judgeOneParticipant (one lane, no rerun) or
//      judgeParticipants, shared-world calls judgeSharedWorld, terminal calls judgeTerminal,
//      scripted calls judgeScripted and preview calls judgePreview;
//   4. foldScorerFailures, which every route with a scorer applies before the run finishes;
//   5. the outcome: judgeExecution applies the route's policy to its execution failures, and
//      resultOk gives the result's ok.

import type {
  ActorCompletionReason,
  ActorStatus,
  ParticipantDeclaredOutcome,
} from "../actors/contract.js";
import type { ReviewSummary } from "./bundle.js";

export type Verdict = ReviewSummary["verdict"];

/** How a finished session ended, as the blocker rule reads it. */
export interface BlockerFacts {
  completionReason: ActorCompletionReason;
  /** A harness-owned stop condition ended the session: a matched stopWhen or a completed dwell window. */
  stopConditionMatched: boolean;
  /** What the participant declared in a field, when its provider has one (#570). */
  declaredOutcome?: ParticipantDeclaredOutcome;
  /** The route's reading of the closing report: it describes a blocker or asks for instructions. */
  closingReportReadsBlocked: boolean;
}

/** How a finished session ended, as the engagement and blocker rules read it. */
export interface SessionEnding extends BlockerFacts {
  actions: number;
  messages: number;
}

/**
 * The participant said it reached the goal having taken no action and said nothing, and no stop
 * condition ended the session. It most likely saw a blank or loading screen, so it is not a pass.
 */
export function hollowCompletion(ending: SessionEnding): boolean {
  return (
    ending.completionReason === "goal_satisfied" &&
    ending.actions === 0 &&
    ending.messages === 0 &&
    !ending.stopConditionMatched
  );
}

/**
 * The participant said it reached the goal but reported a blocker. A declared outcome is its own
 * word and wins (#570). Without one, the closing report is read, unless a stop condition ended the
 * session: a matched stopWhen is structured completion evidence and overrides the text.
 */
export function selfReportedBlocker(ending: BlockerFacts): boolean {
  if (ending.declaredOutcome !== undefined)
    return ending.declaredOutcome === "blocked" && ending.completionReason === "goal_satisfied";
  return (
    ending.completionReason === "goal_satisfied" &&
    ending.closingReportReadsBlocked &&
    !ending.stopConditionMatched
  );
}

/** What a participant's pass reads: its session's end, or why it has none, and the two judgments above. */
export interface ParticipantFacts {
  /** Absent when no session reached a terminal status. */
  status?: ActorStatus;
  completionReason?: ActorCompletionReason;
  /** The harness failed before the session reached a terminal status. */
  sessionError?: string;
  /** The pipeline gate or fail-fast skipped the participant. */
  skipped: boolean;
  /** hollowCompletion held for its session. */
  noEngagement: boolean;
  /** selfReportedBlocker held for its session. */
  selfReportedBlocker: boolean;
}

/**
 * The status a participant is judged under. A harness failure is failed, and a skipped participant
 * is blocked, as the fan-out bundle and the result write it. Otherwise it is the tallied
 * participantStatus of its session, or undefined when no session reached a terminal status.
 * participantPassed and judgeOneParticipant's verdict both read it, so the two cannot disagree.
 */
export function judgedStatus(participant: ParticipantFacts): ActorStatus | undefined {
  if (participantHarnessFailed(participant)) return "failed";
  if (participant.skipped) return "blocked";
  return participant.status === undefined
    ? undefined
    : participantStatus(participant.status, participant);
}

/** A participant passed: its session passed without a harness error, engaged, and reported no blocker. */
export function participantPassed(participant: ParticipantFacts): boolean {
  return judgedStatus(participant) === "passed";
}

/**
 * The participant's session failed in the harness: it threw before a terminal status, or it ended
 * in a harness error. That is an execution failure, apart from what the participant experienced.
 */
export function participantHarnessFailed(participant: ParticipantFacts): boolean {
  return participant.sessionError !== undefined || participant.completionReason === "harness_error";
}

/**
 * The status a participant is tallied under, given what the route made of the session. A
 * goal_satisfied claim with zero engagement is a session that ran out before anything happened;
 * one whose final message describes a blocker is a participant who could not proceed and said so.
 * Both keep their trace status (the claim is evidence); neither is a participant who reached the
 * goal. One rule for the single lane and the fan-out roll-up (#476).
 */
export function participantStatus(
  status: ActorStatus,
  judgments: { noEngagement: boolean; selfReportedBlocker: boolean } | undefined,
): ActorStatus {
  if (status !== "passed" || judgments === undefined) return status;
  if (judgments.noEngagement) return "incomplete";
  if (judgments.selfReportedBlocker) return "blocked";
  return status;
}

/** The review verdict for one participant's status. */
export function verdictForStatus(status: ActorStatus): Verdict {
  switch (status) {
    case "passed":
      return "pass";
    case "failed":
      return "fail";
    case "blocked":
      return "blocked";
    case "timed_out":
      return "timed_out";
    // A participant who abandoned, or a session that ran out before the goal, did not pass, but the
    // harness did not fail either. The run reports what happened rather than a verdict on the tool.
    case "abandoned":
    case "incomplete":
      return "fail";
  }
}

declare const judged: unique symbol;

/**
 * A run's judgment: the review verdict, and whether the run met its route's pass rule. Only
 * judgmentOf builds one, so passed always follows from the verdict.
 */
export interface Judgment {
  readonly verdict: Verdict;
  /**
   * The run met its route's pass rule: every expected participant passed and, on shared-world,
   * the seats showed the concurrency verify requires. A dry run passes as a contract.
   */
  readonly passed: boolean;
  /** A type-only mark that judgmentOf made this judgment; it does not exist at runtime. */
  readonly [judged]: true;
}

/** The judgment for a verdict: a run passes when its verdict is pass, and a dry run passes. */
export function judgmentOf(verdict: Verdict, dryRun: boolean): Judgment {
  return { verdict, passed: dryRun || verdict === "pass" } as Judgment;
}

/** What kind of execution failure a run recorded. */
type ExecutionFailureKind =
  | "harness"
  | "provider-cleanup"
  | "sandbox-cleanup"
  | "evidence"
  | "cap"
  | "run";

/** One way the run failed as an execution. The message is scrubbed; status.json shows it. */
export interface ExecutionFailure {
  kind: ExecutionFailureKind;
  message: string;
}

/** Whether the run worked as an execution, apart from what its participants experienced. */
export interface ExecutionOutcome {
  /** True when no failure of a kind the route's policy counts was recorded. */
  succeeded: boolean;
  /** The failures the policy counts, in the order the route recorded them. */
  failures: ExecutionFailure[];
  /**
   * The failures the policy lets warn, such as a sandbox whose release is unconfirmed on a route
   * whose evidence stands. They leave `succeeded` and the result's ok alone but stay visible in
   * status.json. Omitted when there are none.
   */
  warnings?: ExecutionFailure[];
}

/**
 * The execution failure for one sandbox whose release is unconfirmed. `warning` is the route's
 * release warning, already scrubbed. `recovery` says how to release it by hand; without one,
 * reclaim kills by the id the run recorded at create time.
 */
export function sandboxCleanupFailure(
  owner: string,
  warning: string | undefined,
  runId: string,
  recovery?: string,
): ExecutionFailure {
  return {
    kind: "sandbox-cleanup",
    message: `${owner}: ${warning ?? "Sandbox release is unconfirmed."} ${recovery ?? `Reclaim it by recorded id with \`humanish reclaim --run ${runId}\`.`}`,
  };
}

/**
 * How a route turns the facts into its result's ok. A gate route needs every participant to
 * pass. On an evidence route a participant that failed, was blocked or timed out is captured
 * evidence, and only the execution and the scorer fail the result. Each of the two policy kinds
 * says whether that kind of failure fails the execution or stays a warning.
 */
export interface OutcomePolicy {
  participants: "gate" | "evidence";
  sandboxCleanup: "fails" | "warns";
  evidence: "fails" | "warns";
}

/** The routes a run is judged on. */
export type JudgedRoute = "computer-use" | "shared-world" | "terminal" | "scripted" | "preview";

/** Each route's outcome policy, in one place. */
export const OUTCOME_POLICIES: Readonly<Record<JudgedRoute, OutcomePolicy>> = {
  "computer-use": { participants: "gate", sandboxCleanup: "warns", evidence: "fails" },
  "shared-world": { participants: "gate", sandboxCleanup: "warns", evidence: "fails" },
  terminal: { participants: "evidence", sandboxCleanup: "fails", evidence: "fails" },
  scripted: { participants: "evidence", sandboxCleanup: "warns", evidence: "fails" },
  // The preview's bundle is evidence even when its Observer does not render; export renders it.
  preview: { participants: "evidence", sandboxCleanup: "warns", evidence: "warns" },
};

/** What a shared-world run observed about its one world, beside how each seat ended. */
export interface SharedWorldFacts {
  /** Two or more seats were live at the same time. */
  overlap: boolean;
  /** Provisioned plane only: the shared state changed at or after the first overlap started. */
  stateChangedUnderOverlap?: boolean;
  /** External-public plane only: every seat reached one lobby. */
  lobbyConvergence?: boolean;
}

/** A shared-world run's judgment, with the world facts its review and result also report. */
export interface SharedWorldJudgment extends Judgment {
  world: SharedWorldFacts;
}

/**
 * A run with one participant: its tallied status is the verdict, so a hollow pass fails and a
 * self-reported blocker reads as blocked. Without a session, a harness failure fails the run and
 * a dry run is a contract. A run still in progress is a contract until it finishes. Computer-use
 * calls it for one lane with no rerun, and terminal calls it through judgeTerminal.
 */
export function judgeOneParticipant(args: {
  dryRun: boolean;
  inProgress: boolean;
  participant: ParticipantFacts | undefined;
}): Judgment {
  const status = args.participant === undefined ? undefined : judgedStatus(args.participant);
  const verdict: Verdict =
    args.inProgress || status === undefined ? "contract_proof_only" : verdictForStatus(status);
  return judgmentOf(verdict, args.dryRun);
}

/**
 * A run with several participants: it passes only when every expected participant passed. When
 * one did not, a timeout among them makes the run timed_out; otherwise it fails. A dry run and a
 * run still in progress are contracts. Computer-use calls it for a fan-out or a rerun.
 */
export function judgeParticipants(args: {
  dryRun: boolean;
  inProgress: boolean;
  expected: number;
  participants: ParticipantFacts[];
}): Judgment {
  const { participants } = args;
  const complete = participants.length === args.expected;
  const passed = complete && participants.every(participantPassed);
  const verdict: Verdict =
    args.inProgress || args.dryRun
      ? "contract_proof_only"
      : passed
        ? "pass"
        : complete && participants.some((participant) => participant.status === "timed_out")
          ? "timed_out"
          : "fail";
  return judgmentOf(verdict, args.dryRun);
}

/**
 * Why a shared-world run whose seats all passed still fails, or undefined when its world facts
 * meet what verify's shared-world check requires of a pass: two seats live at the same time and,
 * on the provisioned plane, a shared-state change at or after the first overlap started.
 */
export function sharedWorldShortfall(world: SharedWorldFacts): string | undefined {
  if (!world.overlap) {
    return "No two participants were live at the same time, so the run shows no concurrency.";
  }
  if (world.stateChangedUnderOverlap === false) {
    return "The shared state did not change after the participants started overlapping.";
  }
  return undefined;
}

/**
 * A shared-world run: it passes only when every expected seat passed and the world facts have no
 * shortfall, and otherwise fails (this route has no timed_out verdict). A dry run and a run still
 * in progress are contracts. Lobby convergence is recorded but not read.
 */
export function judgeSharedWorld(args: {
  dryRun: boolean;
  inProgress: boolean;
  expected: number;
  participants: ParticipantFacts[];
  world: SharedWorldFacts;
}): SharedWorldJudgment {
  const passed =
    args.participants.length === args.expected &&
    args.participants.every(participantPassed) &&
    sharedWorldShortfall(args.world) === undefined;
  const verdict: Verdict =
    args.dryRun || args.inProgress ? "contract_proof_only" : passed ? "pass" : "fail";
  return { ...judgmentOf(verdict, args.dryRun), world: args.world };
}

/**
 * A terminal run: one agent session judged as a one-participant run. It has no engagement or
 * blocker rule; the agent's nonce-verified marker is its declared outcome.
 */
export function judgeTerminal(args: {
  dryRun: boolean;
  participant: ParticipantFacts | undefined;
}): Judgment {
  return judgeOneParticipant({
    dryRun: args.dryRun,
    inProgress: false,
    participant: args.participant,
  });
}

/**
 * A scripted run: the worst surface decides the verdict. A harness error or a failed step fails
 * the run, then a timeout makes it timed_out. Otherwise it passes when every expected surface
 * passed, and fails when one did not. A session error fails it and a run with no surface results
 * is a contract.
 */
export function judgeScripted(args: {
  dryRun: boolean;
  sessionError: string | undefined;
  expected: number;
  surfaces: ParticipantFacts[];
}): Judgment {
  const { surfaces } = args;
  const reasons = surfaces.map((surface) => surface.completionReason);
  const passed =
    args.sessionError === undefined &&
    surfaces.length === args.expected &&
    surfaces.every(participantPassed);
  const verdict: Verdict =
    args.sessionError !== undefined
      ? "fail"
      : surfaces.length === 0
        ? "contract_proof_only"
        : reasons.some((reason) => reason === "harness_error" || reason === "step_failed")
          ? "fail"
          : reasons.some((reason) => reason === "timed_out")
            ? "timed_out"
            : passed
              ? "pass"
              : "fail";
  return judgmentOf(verdict, args.dryRun);
}

/** The preview: a synthetic contract with no participants. */
export function judgePreview(): Judgment {
  return judgmentOf("contract_proof_only", true);
}

/**
 * The run's final review after scoring. Each scorer failure is recorded as a gap, and the first
 * turns a pass or a contract into a fail with that failure as the summary. Every other verdict
 * stays as it was, so scoring can never improve a verdict. No failures returns the review as is.
 */
export function foldScorerFailures(
  review: ReviewSummary,
  failures: readonly string[],
): ReviewSummary {
  let folded = review;
  for (const failure of failures) {
    folded = {
      ...folded,
      ...(folded.verdict === "pass" || folded.verdict === "contract_proof_only"
        ? { verdict: "fail" as const, summary: failure }
        : {}),
      gaps: folded.gaps.includes(failure) ? folded.gaps : [...folded.gaps, failure],
    };
  }
  return folded;
}

/** The run's execution outcome under its route's policy. A failure of a kind the policy lets warn is a warning. */
export function judgeExecution(
  failures: readonly ExecutionFailure[],
  policy: OutcomePolicy,
): ExecutionOutcome {
  const counts = (failure: ExecutionFailure): boolean =>
    failure.kind === "sandbox-cleanup"
      ? policy.sandboxCleanup === "fails"
      : failure.kind === "evidence"
        ? policy.evidence === "fails"
        : true;
  const counted = failures.filter(counts);
  const warnings = failures.filter((failure) => !counts(failure));
  return {
    succeeded: counted.length === 0,
    failures: counted,
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * The result's ok: the run worked as an execution, no scorer failed it, and on a gate route every
 * participant passed. An evidence route ignores how its participants did.
 */
export function resultOk(args: {
  judgment: Judgment;
  execution: ExecutionOutcome;
  scorerFailures: readonly string[];
  policy: OutcomePolicy;
}): boolean {
  return (
    args.execution.succeeded &&
    args.scorerFailures.length === 0 &&
    (args.policy.participants === "evidence" || args.judgment.passed)
  );
}
