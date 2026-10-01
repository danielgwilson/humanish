// A participant run outcome's facts for the judge (src/run/judge.ts), and the pass check built on
// them. The bundle builders, the result, the participant runner and shared-world all read these,
// so they sit in a file that imports only the judge and the types.

import {
  participantPassed,
  sandboxCleanupFailure,
  type ExecutionFailure,
  type ParticipantFacts,
} from "../../run/judge.js";
import type { ParticipantRunOutcome } from "./types.js";

/** A participant outcome's facts for the judge. */
export function participantFactsOf(outcome: ParticipantRunOutcome): ParticipantFacts {
  return {
    ...(outcome.session === undefined
      ? {}
      : { status: outcome.session.status, completionReason: outcome.session.completionReason }),
    ...(outcome.sessionError === undefined ? {} : { sessionError: outcome.sessionError }),
    skipped: outcome.skippedReason !== undefined,
    noEngagement: outcome.noEngagement === true,
    selfReportedBlocker: outcome.selfReportedBlocker === true,
  };
}

/** Whether a participant passed. A dry-run participant passes as a contract. */
export function participantOutcomeOk(
  outcome: ParticipantRunOutcome | undefined,
  dryRun: boolean,
): boolean {
  if (dryRun) return true;
  return outcome !== undefined && participantPassed(participantFactsOf(outcome));
}

/**
 * One sandbox-cleanup failure per participant sandbox not confirmed released. A participant that
 * never acquired a sandbox (skipped, in-process or a local VM) has no sandbox id and adds none.
 */
export function unreleasedSandboxFailures(
  outcomes: readonly ParticipantRunOutcome[] | undefined,
  runId: string,
): ExecutionFailure[] {
  return (outcomes ?? [])
    .filter((outcome) => outcome.sandboxId !== undefined && !outcome.killed)
    .map((outcome) =>
      sandboxCleanupFailure(outcome.spec.planned.id, outcome.sandboxRelease?.warning, runId),
    );
}
