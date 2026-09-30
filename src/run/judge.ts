// How humanish judges a participant. A route reduces what happened to plain facts and asks these
// predicates, so "did this participant pass?" has one answer on every route. The routes' verdict
// folds and the scorer's come here next.

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
    // A participant who abandoned, or a session that ran out before the goal, did not pass — but the
    // harness did not fail either. The run reports what happened rather than a verdict on the tool.
    case "abandoned":
    case "incomplete":
      return "fail";
  }
}

/** A run's judgment: the review verdict, and whether every expected participant passed. */
export interface Judgment {
  verdict: Verdict;
  /** Every expected participant passed. A dry run's participants pass as contracts. */
  allPassed: boolean;
}

/**
 * A run with one participant: its tallied status is the verdict, so a hollow pass fails and a
 * self-reported blocker reads as blocked. Without a session, a harness failure fails the run and
 * a dry run is a contract. A run still in progress is a contract until it finishes.
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
    allPassed: args.dryRun || (participant !== undefined && participantPassed(participant)),
  };
}

/**
 * A run with several participants: it passes only when every expected participant passed. When
 * one did not, a timeout among them makes the run timed_out; otherwise it fails. A dry run and a
 * run still in progress are contracts.
 */
export function judgeParticipants(args: {
  dryRun: boolean;
  inProgress: boolean;
  expected: number;
  participants: ParticipantFacts[];
}): Judgment {
  const { participants } = args;
  const complete = participants.length === args.expected;
  const allPassed = complete && participants.every(participantPassed);
  const verdict: Verdict =
    args.inProgress || args.dryRun
      ? "contract_proof_only"
      : allPassed
        ? "pass"
        : complete && participants.some((participant) => participant.status === "timed_out")
          ? "timed_out"
          : "fail";
  return { verdict, allPassed: args.dryRun || allPassed };
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

export interface SharedWorldJudgment extends Judgment {
  world: SharedWorldFacts;
}

/**
 * A shared-world run: it passes only when every expected seat passed, and otherwise fails (this
 * route has no timed_out verdict). A dry run and a run still in progress are contracts. The world
 * facts are recorded with the verdict; the verdict does not read them.
 */
export function judgeSharedWorld(args: {
  dryRun: boolean;
  inProgress: boolean;
  expected: number;
  participants: ParticipantFacts[];
  world: SharedWorldFacts;
}): SharedWorldJudgment {
  const allPassed =
    args.participants.length === args.expected && args.participants.every(participantPassed);
  const verdict: Verdict =
    args.dryRun || args.inProgress ? "contract_proof_only" : allPassed ? "pass" : "fail";
  return { verdict, allPassed: args.dryRun || allPassed, world: args.world };
}
