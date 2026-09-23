import type { AutomaticStudyAnalysisView } from "../../src/study-analysis-job";

export type { AutomaticStudyAnalysisView } from "../../src/study-analysis-job";

// Browser-only mirror: runtime imports from the producer are forbidden. The
// contract test pins this against AUTOMATIC_STUDY_ANALYSIS_STALE_MS.
export const AUTOMATIC_ANALYSIS_STALE_MS = 15_000;
export const ANALYSIS_ADMISSION_EXCEEDED_DETAIL = "Reported usage exceeded an admission estimate or configured limit. Findings and known usage were retained. Review the saved usage before making another request.";
const states = new Set(["queued", "running", "complete", "partial", "failed", "cancelled", "skipped", "unknown"]);
const code = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const unknown = (): AutomaticStudyAnalysisView => ({ state: "unknown", analysisId: null, reason: "ANALYSIS_AUTOMATIC_INVALID", updatedAt: "1970-01-01T00:00:00.000Z" });

// Fixed producer codes explain the next step without exposing provider errors or
// granting this read-only surface authority to launch or retry a paid request.
const reasonDetails: Record<string, string> = {
  AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE: "Codex account analysis could not complete. Check the attempt error and your qualified Codex installation/login, then explicitly retry humanish analyze --provider codex --rerun. No API fallback was attempted.",
  AUTOMATIC_ANALYSIS_KEY_MISSING: "Set OPENAI_API_KEY in the CLI environment, then explicitly run humanish analyze for this study with a cost limit.",
  AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE: "No participant activity was retained to analyze. The run's setup and failure records remain available.",
  AUTOMATIC_ANALYSIS_ADMISSION_REFUSED: "Analysis was refused before dispatch. Check the CLI admission details. If the estimate exceeds your budget, review it before choosing a higher --max-cost for an explicit humanish analyze request.",
  AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED: ANALYSIS_ADMISSION_EXCEEDED_DETAIL,
  AUTOMATIC_ANALYSIS_BUSY: "Another analysis request owns this study's lock. Let it finish, then inspect the analysis history before deciding whether to retry.",
  AUTOMATIC_ANALYSIS_ALREADY_REQUESTED: "An automatic request was already recorded for this study. Inspect the analysis history before making another explicit request.",
  AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE: "The automatic request could not be saved. Check local storage permissions and analysis history before retrying explicitly.",
  AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE: "The retained source was unavailable or not eligible. Check run verification before explicitly requesting analysis.",
  AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN: "Inspect the analysis history and usage before deciding whether to make another explicit request. Participant evidence remains available.",
  AUTOMATIC_ANALYSIS_CANCELLED: "This request has ended. Participant recordings and feedback remain available.",
  AUTOMATIC_ANALYSIS_ACTOR_CANCELLED: "The participant run was cancelled, so automatic analysis did not run. Retained participant evidence remains available.",
  AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE: "Cancellation could not be confirmed. Inspect the analysis history and usage before deciding whether to make another request.",
  AUTOMATIC_ANALYSIS_FAILED: "The request ended without a usable result. Inspect the analysis history and usage before deciding whether to retry explicitly.",
  AUTOMATIC_ANALYSIS_PUBLICATION_FAILED: "The request finished but its result could not be saved. Inspect the analysis history and usage before deciding whether to retry.",
  AUTOMATIC_ANALYSIS_REUSED: "An existing matching analysis was reused.",
  AUTOMATIC_ANALYSIS_LIMITATIONS: "Review the report's coverage and limitations alongside participant evidence.",
};

/** Optional execution metadata cannot invalidate an otherwise readable report. */
export function parseAutomaticAnalysis(value: unknown): AutomaticStudyAnalysisView | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return unknown();
  const v = value as Record<string, unknown>;
  if (typeof v.state !== "string" || !states.has(v.state)
    || !(v.analysisId === null || typeof v.analysisId === "string" && identifier.test(v.analysisId))
    || !(v.reason === null || typeof v.reason === "string" && code.test(v.reason))
    || typeof v.updatedAt !== "string" || !timestamp.test(v.updatedAt) || !Number.isFinite(Date.parse(v.updatedAt))
    || new Date(v.updatedAt).toISOString() !== v.updatedAt) return unknown();
  return { state: v.state as AutomaticStudyAnalysisView["state"], analysisId: v.analysisId as string | null, reason: v.reason as string | null, updatedAt: v.updatedAt };
}

export interface AutomaticAnalysisNotice {
  state: AutomaticStudyAnalysisView["state"];
  message: string;
  detail: string;
  pending: boolean;
}

/** A heartbeat is a display hint, never authority to resume or dispatch work. */
export function automaticAnalysisNotice(automatic: AutomaticStudyAnalysisView, snapshot: boolean, now: number): AutomaticAnalysisNotice {
  const value = parseAutomaticAnalysis(automatic)!;
  const nonterminal = value.state === "queued" || value.state === "running";
  const updated = Date.parse(value.updatedAt);
  if (nonterminal && snapshot && updated <= now) return {
    state: "unknown", message: `This snapshot was saved while analysis was ${value.state}.`,
    detail: "Reopen the served Observer to check its current status. Participant evidence remains available.", pending: false,
  };
  const state = nonterminal && (updated > now || now - updated > AUTOMATIC_ANALYSIS_STALE_MS) ? "unknown" : value.state;
  const message: Record<AutomaticStudyAnalysisView["state"], string> = {
    queued: "Analysis is queued.", running: "Analyzing recorded evidence…", complete: "Analysis finished.",
    partial: "Analysis finished with limitations.", failed: "Analysis failed.", cancelled: "Analysis was cancelled.",
    skipped: "Automatic analysis did not run.", unknown: "Analysis status is unknown.",
  };
  const pending = state === "queued" || state === "running";
  return { state, message: message[state], pending, detail: pending
    ? "You can review participant recordings and feedback while you wait."
    : nonterminal ? reasonDetails.AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN!
    : (value.reason ? reasonDetails[value.reason] : undefined)
      ?? (state === "unknown" ? reasonDetails.AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN! : "Participant recordings and feedback remain available.") };
}
