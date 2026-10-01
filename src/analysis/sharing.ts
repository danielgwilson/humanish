import { containsSensitive } from "../evidence/redaction.js";
import type { LoadedAnalysis } from "./study-analysis.js";
import { AUTOMATIC_STUDY_ANALYSIS_DIRECTORY, projectAutomaticStudyAnalysisView } from "./job.js";
import { STUDY_ANALYSIS_DIRECTORY, STUDY_ANALYSIS_EXECUTION_DIRECTORY } from "./store.js";

/** True for the analysis record files, matched by name inside their directories. Any other file
 * under analysis/ is ordinary evidence and follows the ordinary evidence policy. */
export function isStudyAnalysisRecordPath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  const leaf = parts.at(-1)!;
  const directory = parts[0];
  return (
    (directory === STUDY_ANALYSIS_DIRECTORY &&
      ["analysis.json", "correction.json"].includes(leaf)) ||
    (directory === STUDY_ANALYSIS_EXECUTION_DIRECTORY &&
      ["receipt.json", "start.json"].includes(leaf)) ||
    (directory === AUTOMATIC_STUDY_ANALYSIS_DIRECTORY &&
      ["job.json", "cancel.json"].includes(leaf)) ||
    ([
      STUDY_ANALYSIS_DIRECTORY,
      STUDY_ANALYSIS_EXECUTION_DIRECTORY,
      AUTOMATIC_STUDY_ANALYSIS_DIRECTORY,
    ].includes(directory!) &&
      leaf.startsWith(".humanish-write-"))
  );
}

/** Check the exact in-memory snapshot being projected; a prior filesystem scan cannot approve a later write. */
export function studyAnalysisSharingProblems(loaded: LoadedAnalysis): {
  sensitive: boolean;
  unverified: boolean;
} {
  // Job metadata never approves evidence, nor does uncertain liveness revoke its approval.
  const { automatic: _automatic, ...evidence } = loaded;
  const benignAttempt =
    loaded.analysis?.result === null &&
    (loaded.analysis.status === "failed" || loaded.analysis.status === "cancelled");
  const validationWarnings = loaded.warnings.filter(
    (warning) => warning !== "ANALYSIS_FAILED" && warning !== "ANALYSIS_CANCELLED",
  );
  return {
    sensitive: containsSensitive(JSON.stringify(evidence)),
    unverified:
      loaded.state === "stale" ||
      (loaded.state === "invalid" && !benignAttempt) ||
      validationWarnings.length > 0,
  };
}

/** Unsafe generated text is quarantined without hiding the original recording. */
export function projectShareCheckedAnalysis(loaded: LoadedAnalysis): LoadedAnalysis {
  const { automatic: _automatic, ...evidence } = loaded;
  const automatic = projectAutomaticStudyAnalysisView(loaded.automatic);
  const safe = automatic === undefined ? evidence : { ...evidence, automatic };
  return studyAnalysisSharingProblems(safe).sensitive
    ? {
        state: "invalid",
        analysis: null,
        corrections: [],
        warnings: ["ANALYSIS_SENSITIVE_TEXT_QUARANTINED"],
        ...(automatic === undefined ? {} : { automatic }),
      }
    : safe;
}
