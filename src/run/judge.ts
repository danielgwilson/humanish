// How humanish judges a run. A route reduces what happened to plain facts and judges them here
// once, and its bundle's verdict and its result's ok both read that judgment. The file reads in
// the order a run is judged:
//   1. session and participant predicates (hollowCompletion, selfReportedBlocker, participantPassed);
//   2. the judgment shapes (Judgment, HarnessJudgment, SharedWorldJudgment);
//   3. one judge per route: computer-use calls judgeOneParticipant (one lane, no rerun) or
//      judgeParticipants, shared-world calls judgeSharedWorld, terminal calls judgeTerminal and
//      scripted calls judgeScripted;
//   4. foldScorerFailures, which every route with a scorer applies last, before the run finishes.

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

/** A participant passed: its session passed without a harness error, engaged, and reported no blocker. */
export function participantPassed(participant: ParticipantFacts): boolean {
  return (
    !participant.skipped &&
    participant.status === "passed" &&
    participant.completionReason !== "harness_error" &&
    participant.sessionError === undefined &&
    !participant.noEngagement &&
    !participant.selfReportedBlocker
  );
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

/** A run's judgment: the review verdict, and whether the run met its route's pass rule. */
export interface Judgment {
  verdict: Verdict;
  /**
   * The run met its route's pass rule: every expected participant passed and, on shared-world,
   * the seats showed the concurrency verify requires. A dry run passes as a contract.
   */
  passed: boolean;
}

/**
 * The judgment of a route whose result reads harnessFailed: terminal and scripted. A participant
 * that ended failed, blocked or timed out is still evidence there, and only a harness failure
 * fails the result.
 */
export interface HarnessJudgment {
  verdict: Verdict;
  harnessFailed: boolean;
}

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
  const { participant } = args;
  const verdict: Verdict = args.inProgress
    ? "contract_proof_only"
    : participant?.status !== undefined
      ? verdictForStatus(participantStatus(participant.status, participant))
      : participant?.sessionError
        ? "fail"
        : "contract_proof_only";
  return {
    verdict,
    passed: args.dryRun || (participant !== undefined && participantPassed(participant)),
  };
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
  return { verdict, passed: args.dryRun || passed };
}

/**
 * Why a shared-world run whose seats all passed still fails, or undefined when its world facts
 * meet what verify's shared-world check requires of a pass: two seats live at the same time and,
 * on the provisioned plane, a shared-state change at or after the first overlap started.
 */
export function sharedWorldShortfall(world: SharedWorldFacts): string | undefined {
  if (!world.overlap) {
    return "No two seats were live at the same time, so the run shows no concurrency.";
  }
  if (world.stateChangedUnderOverlap === false) {
    return "The shared state did not change after the seats started overlapping.";
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
  return { verdict, passed: args.dryRun || passed, world: args.world };
}

/**
 * A terminal run: one agent session judged as a one-participant run. It has no engagement or
 * blocker rule; the agent's nonce-verified marker is its declared outcome.
 */
export function judgeTerminal(args: {
  dryRun: boolean;
  participant: ParticipantFacts | undefined;
}): HarnessJudgment {
  return {
    verdict: judgeOneParticipant({
      dryRun: args.dryRun,
      inProgress: false,
      participant: args.participant,
    }).verdict,
    harnessFailed: args.participant?.completionReason === "harness_error",
  };
}

/**
 * A scripted run: the worst surface decides the verdict. A harness error or a failed step fails
 * the run, then a timeout makes it timed_out, and otherwise it passes. A session error fails it
 * and a run with no surface results is a contract. The harness failed when the session erred, a
 * live surface never returned, or a surface ended in a harness error.
 */
export function judgeScripted(args: {
  dryRun: boolean;
  sessionError: string | undefined;
  expected: number;
  surfaces: ParticipantFacts[];
}): HarnessJudgment {
  const { surfaces } = args;
  const reasons = surfaces.map((surface) => surface.completionReason);
  const verdict: Verdict = args.sessionError
    ? "fail"
    : surfaces.length === 0
      ? "contract_proof_only"
      : reasons.some((reason) => reason === "harness_error" || reason === "step_failed")
        ? "fail"
        : reasons.some((reason) => reason === "timed_out")
          ? "timed_out"
          : "pass";
  const complete = surfaces.length === args.expected;
  return {
    verdict,
    harnessFailed:
      args.sessionError !== undefined ||
      (!args.dryRun && (!complete || reasons.includes("harness_error"))),
  };
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
