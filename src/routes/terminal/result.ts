import type { ObserverResult } from "../../observer/render.js";
import type { ActorCompletionReason, ActorStatus, ActorTrace } from "../../actors/contract.js";
import {
  OUTCOME_POLICIES,
  participantHarnessFailed,
  resultOk,
  type ExecutionFailure,
  type ExecutionOutcome,
  type Judgment,
  type ParticipantFacts,
} from "../../run/judge.js";
import {
  type NoSpendProof,
  type TerminalCostLedger,
  type TerminalLedgers,
  type TerminalProductStudyResult,
} from "./types.js";
import { studyResultIdentity } from "../../run/study-result.js";

/**
 * What judge.ts reads from a finished terminal session, after a blown cap has overridden it. It has
 * no engagement or blocker rule: the agent's nonce-verified marker is its declared outcome.
 */
export function terminalParticipantFacts(
  trace: ActorTrace,
  sessionError: string | undefined,
): ParticipantFacts {
  return {
    status: trace.status,
    completionReason: trace.completionReason,
    ...(sessionError === undefined ? {} : { sessionError }),
    skipped: false,
    noEngagement: false,
    selfReportedBlocker: false,
  };
}

/**
 * The live run's execution failures: a harness error, a blown spend cap, an unproven sandbox
 * teardown, and an Observer that failed.
 */
export function terminalExecutionFailures(args: {
  participant: ParticipantFacts;
  /** The cap check's message when known spend or jobs exceeded the caps. */
  capFailure: string | undefined;
  /** Already scrubbed and redacted. */
  sessionReason: string;
  cleanup: TerminalLedgers["cleanup"];
  observer: Pick<ObserverResult, "ok" | "error">;
}): ExecutionFailure[] {
  const { participant, cleanup, observer } = args;
  return [
    ...(participantHarnessFailed(participant)
      ? [{ kind: "harness" as const, message: participant.sessionError ?? args.sessionReason }]
      : []),
    ...(args.capFailure === undefined ? [] : [{ kind: "cap" as const, message: args.capFailure }]),
    ...(cleanup.killed && cleanup.remaining === 0
      ? []
      : [
          {
            kind: "sandbox-cleanup" as const,
            message: `Sandbox teardown unproven (killed=${cleanup.killed}, remaining=${cleanup.remaining}): ${cleanup.reason}`,
          },
        ]),
    ...(observer.ok
      ? []
      : [
          {
            kind: "evidence" as const,
            message: observer.error?.message ?? "Observer failed for the terminal-product run.",
          },
        ]),
  ];
}

/** The terminal-product lab result for a live run, from its session, cleanup and cost ledger. */
export function terminalStudyResult(args: {
  cwd: string;
  studyId: string;
  actorId: string;
  productName: string;
  runId: string;
  sessionStatus: ActorStatus;
  completionReason: ActorCompletionReason;
  /** Already scrubbed and redacted. */
  sessionReason: string;
  sessionError: string | undefined;
  sandboxId: string | undefined;
  cleanup: TerminalLedgers["cleanup"];
  cost: TerminalCostLedger;
  noSpendProof: NoSpendProof;
  /** The cap check's message when known spend or jobs exceeded the caps. */
  capFailure: string | undefined;
  declaredScorerFailure: string | undefined;
  /** The run's judgment. On this evidence route ok does not read whether the agent passed. */
  judgment: Judgment;
  execution: ExecutionOutcome;
  observer: ObserverResult;
  warnings: string[];
}): TerminalProductStudyResult {
  const {
    cwd,
    studyId,
    actorId,
    productName,
    runId,
    sessionStatus,
    completionReason,
    sessionReason,
    sessionError,
    sandboxId,
    cleanup,
    cost,
    noSpendProof,
    capFailure,
    declaredScorerFailure,
    judgment,
    execution,
    observer,
    warnings,
  } = args;
  // The lab's exit code: verified evidence, no harness error and proven cleanup. A blocked/
  // timed-out agent run is still ok-as-evidence at the bundle level (the failure is the evidence),
  // but the lab result surfaces ok:false on a harness error or unproven teardown (fail-closed).
  // remaining===0 is the by-id-confirmed-reclaimed state; remaining===1 (still present) and
  // remaining===-1 (kill(id) itself failed) are both unproven by design.
  const cleanupProven = cleanup.killed && cleanup.remaining === 0;
  // A config-declared scorer that failed to render a pass (status:"fail" / malformed / throw) fails the
  // run result as well as the persisted verdict: the keystone route's declared rubric is a gate, so
  // its fail must drive exit code. Library callers never set this (additive, back-compat).
  const ok = resultOk({
    judgment,
    execution,
    scorerFailures: declaredScorerFailure === undefined ? [] : [declaredScorerFailure],
    policy: OUTCOME_POLICIES.terminal,
  });

  return {
    ...studyResultIdentity("terminal", studyId),
    ok,
    cwd,
    actor: actorId,
    product: productName,
    dryRun: false,
    runId,
    session: { status: sessionStatus, completionReason, reason: sessionReason },
    ...(sandboxId
      ? { sandbox: { sandboxId, killed: cleanup.killed, remaining: cleanup.remaining } }
      : {}),
    cost: {
      knownTotalUsd: cost.knownTotalUsd,
      fullyMeasured: cost.fullyMeasured,
      lines: {
        product: cost.lines.product.usd,
        media: cost.lines.media.usd,
        payment: cost.lines.payment.usd,
        provider: cost.lines.provider.usd,
      },
    },
    noSpend: {
      satisfied: noSpendProof.satisfied,
      maxUsd: noSpendProof.maxUsd,
      knownZeroLines: noSpendProof.knownZeroLines,
      unmeasuredLines: noSpendProof.unmeasuredLines,
    },
    observer,
    warnings: [...warnings, ...observer.warnings],
    ...(ok
      ? {}
      : {
          error: {
            code: (!cleanupProven
              ? "HUMANISH_TERMINAL_CLEANUP_UNPROVEN"
              : capFailure !== undefined
                ? "HUMANISH_TERMINAL_CAPS_EXCEEDED"
                : "HUMANISH_TERMINAL_FAILED") as NonNullable<
              TerminalProductStudyResult["error"]
            >["code"],
            message: !cleanupProven
              ? `Live terminal-product run could not prove sandbox teardown (killed=${cleanup.killed}, remaining=${cleanup.remaining}): ${cleanup.reason}. A run that cannot prove its sandbox was removed does not pass.${sessionError !== undefined ? ` Session failure: ${sessionError}` : ""}`
              : (declaredScorerFailure ??
                capFailure ??
                sessionError ??
                observer.error?.message ??
                sessionReason),
          },
        }),
  };
}
