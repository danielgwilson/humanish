// A participant run outcome's facts for the judge (src/run/judge.ts), and the pass check built on
// them. The bundle builders, the result, the participant runner and shared-world all read these,
// so they sit in a file that imports only the judge and the types.

import {
  participantHarnessFailed,
  participantPassed,
  sandboxCleanupFailure,
  type ExecutionFailure,
  type ParticipantRecordFacts,
} from "../../run/judge.js";
import type { ParticipantRunOutcome } from "./types.js";

/** A participant outcome's facts for the judge. */
export function participantFactsOf(
  outcome: ParticipantRunOutcome | undefined,
): ParticipantRecordFacts {
  if (outcome === undefined)
    return { skipped: false, noEngagement: false, selfReportedBlocker: false };
  return {
    id: outcome.spec.planned.id,
    ...(outcome.skippedReason === undefined ? {} : { skippedReason: outcome.skippedReason }),
    reportedFriction: outcome.reportedFriction === true,
    ...(outcome.session === undefined
      ? {}
      : {
          status: outcome.session.status,
          completionReason: outcome.session.completionReason,
          reason: outcome.session.reason,
        }),
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
 * The execution failures a run's participants caused, by kind: each session that failed in the
 * harness, each provider whose cleanup is unconfirmed, each provider that reported a disallowed
 * item after its last request, then each desktop not confirmed released. Participants keep their
 * order within each kind.
 */
export function participantExecutionFailures(
  outcomes: readonly ParticipantRunOutcome[] | undefined,
  runId: string,
): ExecutionFailure[] {
  const all = outcomes ?? [];
  const named = (outcome: ParticipantRunOutcome, text: string) =>
    `${outcome.spec.planned.id}: ${text}`;
  return [
    ...all
      .filter((outcome) => participantHarnessFailed(participantFactsOf(outcome)))
      .map((outcome) => ({
        kind: "harness" as const,
        message: named(outcome, outcome.sessionError ?? outcome.session?.reason ?? "harness error"),
      })),
    ...all.flatMap((outcome) =>
      outcome.providerCleanupError === undefined
        ? []
        : [
            {
              kind: "provider-cleanup" as const,
              message: named(outcome, outcome.providerCleanupError),
            },
          ],
    ),
    ...all.flatMap((outcome) =>
      outcome.providerPolicyError === undefined
        ? []
        : [
            {
              kind: "provider-policy" as const,
              message: named(outcome, outcome.providerPolicyError),
            },
          ],
    ),
    ...unreleasedSandboxFailures(all, runId),
  ];
}

/**
 * One sandbox-cleanup failure per participant desktop not confirmed released: an E2B sandbox that
 * was not killed, or a desktop whose release says why (a local VM names its container). A
 * participant that never acquired a desktop (skipped, in-process) adds none.
 */
function unreleasedSandboxFailures(
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
