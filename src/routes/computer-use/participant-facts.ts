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
 * One sandbox-cleanup failure per participant desktop not confirmed released: an E2B sandbox that
 * was not killed, or a desktop whose release says why (a local VM names its container). A
 * participant that never acquired a desktop (skipped, in-process) adds none.
 */
export function unreleasedSandboxFailures(
  outcomes: readonly ParticipantRunOutcome[] | undefined,
  runId: string,
): ExecutionFailure[] {
  return (outcomes ?? [])
    .filter(
      (outcome) =>
        outcome.sandboxRelease !== undefined ||
        (outcome.sandboxId !== undefined && !outcome.killed),
    )
    .map((outcome) =>
      sandboxCleanupFailure(
        outcome.spec.planned.id,
        outcome.sandboxRelease?.warning,
        runId,
        outcome.sandboxRelease?.recovery,
      ),
    );
}
