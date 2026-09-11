import { actorStopCauseLabel } from "./actor-stop-cause.js";
import type { ActorCompletionReason, ActorStatus, ActorStopCause } from "./actor-contract.js";

/** Diagnostic categories describe the instrument's result, never prove a target-app defect. */
export const CUA_DIAGNOSTIC_CATEGORIES = [
  "preview", "participant_outcome", "session_interrupted", "execution_error",
  "evidence_invalid", "mixed", "unknown"
] as const;
export type CuaDiagnosticCategory = typeof CUA_DIAGNOSTIC_CATEGORIES[number];

/** Closed at both projection and telemetry boundaries. No provider messages are classified. */
export const CUA_DIAGNOSTIC_STOP_CAUSES = [
  "provider_output_limit", "provider_token_limit", "time_limit", "spend_limit", "study_spend_limit",
  "provider_incomplete", "provider_status", "harness_aborted", "adapter_limit",
  "unspecified_limit", "mixed", "unknown"
] as const;
export type CuaDiagnosticStopCause = typeof CUA_DIAGNOSTIC_STOP_CAUSES[number];

export interface CuaDiagnostics {
  category: CuaDiagnosticCategory;
  stopCause?: CuaDiagnosticStopCause;
}

export const isCuaDiagnosticCategory = (value: unknown): value is CuaDiagnosticCategory =>
  typeof value === "string" && (CUA_DIAGNOSTIC_CATEGORIES as readonly string[]).includes(value);
export const isCuaDiagnosticStopCause = (value: unknown): value is CuaDiagnosticStopCause =>
  typeof value === "string" && (CUA_DIAGNOSTIC_STOP_CAUSES as readonly string[]).includes(value);

interface SessionEnding {
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  stopCause?: ActorStopCause;
}

export function cuaLaneDiagnostics(input: {
  dryRun: boolean;
  skipped?: boolean;
  executionError?: boolean;
  noEngagement?: boolean;
  session?: SessionEnding;
}): CuaDiagnostics {
  if (input.dryRun) return { category: "preview" };
  // A skipped follower never started; it has no participant ending or proved execution error.
  if (input.skipped) return { category: "unknown" };
  if (input.executionError) return { category: "execution_error" };
  const session = input.session;
  if (!session) return { category: "unknown" };
  if (session.stopCause !== undefined) {
    return { category: "session_interrupted", stopCause: isCuaDiagnosticStopCause(session.stopCause) ? session.stopCause : "unknown" };
  }
  if (session.completionReason === "budget_reached") return { category: "session_interrupted", stopCause: "unspecified_limit" };
  if (session.completionReason === "timed_out") return { category: "session_interrupted", stopCause: "time_limit" };
  if (session.completionReason === "actor_error" || session.completionReason === "harness_error") return { category: "execution_error" };
  if (input.noEngagement) return { category: "unknown" };
  return ["goal_satisfied", "turn_completed", "gave_up", "blocked_approval", "step_failed"].includes(session.completionReason)
    ? { category: "participant_outcome" } : { category: "unknown" };
}

/** Each lane retains its details. The summary never borrows lane one's ending for other lanes. */
export function summarizeCuaDiagnostics(input: {
  dryRun: boolean;
  evidenceInvalid: boolean;
  lanes: readonly { status: string; ok: boolean; diagnostics?: CuaDiagnostics }[];
}): CuaDiagnostics {
  if (input.evidenceInvalid) return { category: "evidence_invalid" };
  if (input.dryRun) return { category: "preview" };
  if (input.lanes.length === 0) return { category: "unknown" };
  const diagnostics = input.lanes.map(lane => lane.diagnostics ?? { category: "unknown" as const });
  const signatures = input.lanes.map((lane, index) => JSON.stringify([diagnostics[index]!.category, diagnostics[index]!.stopCause, lane.status, lane.ok]));
  const endings = new Set(signatures);
  const causes = new Set(diagnostics.map(item => item.stopCause ?? "unknown"));
  const hasCause = diagnostics.some(item => item.stopCause !== undefined);
  return {
    category: endings.size === 1 ? diagnostics[0]!.category : "mixed",
    ...(hasCause ? { stopCause: causes.size === 1 ? diagnostics[0]!.stopCause! : "mixed" } : {})
  };
}

const categoryLabels: Record<CuaDiagnosticCategory, string> = {
  preview: "preview", participant_outcome: "participant outcome", session_interrupted: "session interrupted",
  execution_error: "execution error", evidence_invalid: "invalid evidence", mixed: "mixed endings", unknown: "unknown ending"
};

export function formatCuaStopCause(cause: CuaDiagnosticStopCause): string {
  return cause === "mixed" || cause === "unknown" ? cause : actorStopCauseLabel(cause);
}

export function formatCuaDiagnostics(diagnostics: CuaDiagnostics): string {
  return `${categoryLabels[diagnostics.category]}${diagnostics.stopCause ? ` (${formatCuaStopCause(diagnostics.stopCause)})` : ""}`;
}
