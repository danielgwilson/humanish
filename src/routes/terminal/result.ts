import type { ObserverResult } from "../../observer/render.js";
import type { ActorCompletionReason, ActorStatus, ActorTrace } from "../../actors/contract.js";
import type { HarnessJudgment, ParticipantFacts } from "../../run/judge.js";
import {
  TERMINAL_PRODUCT_LAB_SCHEMA,
  type NoSpendProof,
  type TerminalCostLedger,
  type TerminalLedgers,
  type TerminalProductLabResult,
} from "./types.js";

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

/** The terminal-product lab result for a live run, from its session, cleanup and cost ledger. */
export function terminalLabResult(args: {
  cwd: string;
  labId: string;
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
  capsExceeded: boolean;
  declaredScorerFailure: string | undefined;
  /** The run's judgment; ok reads its harnessFailed, not a pass. */
  judgment: HarnessJudgment;
  observer: ObserverResult;
  warnings: string[];
}): TerminalProductLabResult {
  const {
    cwd,
    labId,
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
    capsExceeded,
    declaredScorerFailure,
    judgment,
    observer,
    warnings,
  } = args;
  // The lab's exit code: verified evidence AND no harness error AND proven cleanup. A blocked/
  // timed-out agent run is STILL ok-as-evidence at the bundle level (the failure is the evidence),
  // but the LAB result surfaces ok:false on a harness error or unproven teardown (fail-closed).
  // remaining===0 is the by-id-confirmed-reclaimed state; remaining===1 (still present) and
  // remaining===-1 (kill(id) itself failed) are both unproven by design.
  const cleanupProven = cleanup.killed && cleanup.remaining === 0;
  // A CONFIG-DECLARED scorer that failed to render a pass (status:"fail" / malformed / throw) fails the
  // run RESULT too, not just the persisted verdict — the keystone lane's declared rubric is a gate, so
  // its fail must drive exit code. Library callers never set this (additive, back-compat).
  const ok =
    observer.ok && !judgment.harnessFailed && cleanupProven && declaredScorerFailure === undefined;

  return {
    schema: TERMINAL_PRODUCT_LAB_SCHEMA,
    ok,
    cwd,
    labId,
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
              ? "HUMANISH_TERMINAL_LAB_CLEANUP_UNPROVEN"
              : capsExceeded
                ? "HUMANISH_TERMINAL_LAB_CAPS_EXCEEDED"
                : "HUMANISH_TERMINAL_LAB_FAILED") as NonNullable<
              TerminalProductLabResult["error"]
            >["code"],
            message: !cleanupProven
              ? `Live terminal-product run could not prove sandbox teardown (killed=${cleanup.killed}, remaining=${cleanup.remaining}): ${cleanup.reason}. A run that cannot prove teardown fails closed.${sessionError ? ` Session failure: ${sessionError}` : ""}`
              : (declaredScorerFailure ?? sessionError ?? observer.error?.message ?? sessionReason),
          },
        }),
  };
}
