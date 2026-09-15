import type { AutomaticStudyAnalysisView } from "../../src/study-analysis-job";

export type { AutomaticStudyAnalysisView } from "../../src/study-analysis-job";

// Browser-only mirror: runtime imports from the producer are forbidden. The
// contract test pins this against AUTOMATIC_STUDY_ANALYSIS_STALE_MS.
export const AUTOMATIC_ANALYSIS_STALE_MS = 15_000;
const states = new Set(["queued", "running", "complete", "partial", "failed", "cancelled", "skipped", "unknown"]);
const code = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const unknown = (): AutomaticStudyAnalysisView => ({ state: "unknown", analysisId: null, reason: "ANALYSIS_AUTOMATIC_INVALID", updatedAt: "1970-01-01T00:00:00.000Z" });

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
    : state === "unknown" ? "The latest analysis status could not be confirmed. Participant evidence remains available."
    : "Participant recordings and feedback remain available." };
}
