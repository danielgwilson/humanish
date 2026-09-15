import { containsSensitive } from "./redaction.js";
import type { LoadedStudyAnalysis } from "./study-analysis.js";
import { projectAutomaticStudyAnalysisView } from "./study-analysis-job.js";

/** Owned file names in normalized run-relative paths, not directory ownership.
 * Legacy evidence under analysis/ still follows ordinary evidence policy. */
export function isStudyAnalysisRecordPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const leaf = parts.at(-1)!;
  return (parts[0] === "analysis" && ["analysis.json", "correction.json"].includes(leaf))
    || (parts[0] === "analysis-attempts" && leaf === "receipt.json")
    || (parts[0] === "analysis-automatic" && ["job.json", "cancel.json"].includes(leaf))
    || (["analysis", "analysis-attempts", "analysis-automatic"].includes(parts[0]!) && leaf.startsWith(".humanish-write-"));
}

/** Check the exact in-memory snapshot being projected; a prior filesystem scan cannot approve a later write. */
export function studyAnalysisSharingProblems(loaded: LoadedStudyAnalysis): { sensitive: boolean; unverified: boolean } {
  // Job metadata never approves evidence, nor does uncertain liveness revoke its approval.
  const { automatic: _automatic, ...evidence } = loaded;
  const benignAttempt = loaded.analysis?.result === null
    && (loaded.analysis.status === "failed" || loaded.analysis.status === "cancelled");
  const validationWarnings = loaded.warnings.filter((warning) => warning !== "ANALYSIS_FAILED" && warning !== "ANALYSIS_CANCELLED");
  return {
    sensitive: containsSensitive(JSON.stringify(evidence)),
    unverified: loaded.state === "stale" || (loaded.state === "invalid" && !benignAttempt) || validationWarnings.length > 0
  };
}

/** Unsafe generated text is quarantined without hiding the original recording. */
export function projectShareCheckedAnalysis(loaded: LoadedStudyAnalysis): LoadedStudyAnalysis {
  const { automatic: _automatic, ...evidence } = loaded;
  const automatic = projectAutomaticStudyAnalysisView(loaded.automatic);
  const safe = automatic === undefined ? evidence : { ...evidence, automatic };
  return studyAnalysisSharingProblems(safe).sensitive
    ? { state: "invalid", analysis: null, corrections: [], warnings: ["ANALYSIS_SENSITIVE_TEXT_QUARANTINED"],
      ...(automatic === undefined ? {} : { automatic }) }
    : safe;
}
