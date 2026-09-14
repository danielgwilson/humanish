import { containsSensitive } from "./redaction.js";
import type { LoadedStudyAnalysis } from "./study-analysis.js";

/** Check the exact in-memory snapshot being projected; a prior filesystem scan cannot approve a later write. */
export function studyAnalysisSharingProblems(loaded: LoadedStudyAnalysis): { sensitive: boolean; unverified: boolean } {
  const benignAttempt = loaded.analysis?.result === null
    && (loaded.analysis.status === "failed" || loaded.analysis.status === "cancelled");
  const validationWarnings = loaded.warnings.filter((warning) => warning !== "ANALYSIS_FAILED" && warning !== "ANALYSIS_CANCELLED");
  return {
    sensitive: containsSensitive(JSON.stringify(loaded)),
    unverified: loaded.state === "stale" || (loaded.state === "invalid" && !benignAttempt) || validationWarnings.length > 0
  };
}

/** Unsafe generated text is quarantined without hiding the original recording. */
export function projectShareCheckedAnalysis(loaded: LoadedStudyAnalysis): LoadedStudyAnalysis {
  return studyAnalysisSharingProblems(loaded).sensitive
    ? { state: "invalid", analysis: null, corrections: [], warnings: ["ANALYSIS_SENSITIVE_TEXT_QUARANTINED"] }
    : loaded;
}
