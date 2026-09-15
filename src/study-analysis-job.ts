import type { AnalyzeResult } from "./study-analysis-service.js";

export const AUTOMATIC_STUDY_ANALYSIS_DIRECTORY = "analysis-automatic";
export const AUTOMATIC_STUDY_ANALYSIS_SCHEMA = "humanish.automatic-study-analysis.v1";
export const AUTOMATIC_STUDY_ANALYSIS_STALE_MS = 15_000;

/** Execution metadata only. Never a participant outcome or permission to dispatch. */
export interface AutomaticStudyAnalysisView {
  state: "queued" | "running" | "complete" | "partial" | "failed" | "cancelled" | "skipped" | "unknown";
  analysisId: string | null;
  /** Safe stable code, not provider text. */
  reason: string | null;
  updatedAt: string;
}

export interface AutomaticStudyAnalysisOutcome {
  state: "complete" | "partial" | "failed" | "cancelled" | "skipped" | "unknown";
  reason: string | null;
  result?: AnalyzeResult;
}

export interface AutomaticStudyAnalysisCancellation {
  requested: boolean;
  reason: string | null;
}
