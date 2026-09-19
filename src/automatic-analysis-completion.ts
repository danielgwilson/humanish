import path from "node:path";
import { validatePreparedRunRootIdentity, type PreparedRunArtifactPaths } from "./run-paths.js";
import type { StudyAnalysisConfig } from "./study-analysis.js";
import { runAutomaticStudyAnalysis, type AutomaticStudyAnalysisDeps } from "./automatic-study-analysis.js";
import type { AutomaticStudyAnalysisOutcome } from "./study-analysis-job.js";

export interface AutomaticAnalysisHooks {
  /** Provider/test dependencies apply only to analysis, never to the participant. */
  deps?: AutomaticStudyAnalysisDeps;
  /** Called after the source is finalized; the returned cleanup always runs. */
  onStart?: () => void | (() => void);
  run?: typeof runAutomaticStudyAnalysis;
}

export interface AutomaticAnalysisResult {
  automaticAnalysis?: AutomaticStudyAnalysisOutcome;
  /** Distinguishes the default missing-key skip from failure of an explicit request. */
  automaticAnalysisTrigger?: "default" | "explicit";
}

const finalizedResults = new WeakMap<object, PreparedRunArtifactPaths>();

/** Internal producer receipt: call only after final source publication, never for an early refusal. */
export function markFinalizedStudyResult<T extends object>(result: T, prepared: PreparedRunArtifactPaths): T {
  finalizedResults.set(result, prepared);
  return result;
}

/** One post-completion boundary shared by all live recording producers. */
export async function completeAutomaticAnalysis<T extends {
  cwd: string; runId: string; dryRun: boolean;
}>(result: T, config: StudyAnalysisConfig | undefined, hooks?: AutomaticAnalysisHooks, trigger: "default" | "explicit" = "explicit", preferLargerOutput = false): Promise<T & AutomaticAnalysisResult> {
  if (config === undefined) return result;
  const origin = trigger === "default" ? { automaticAnalysisTrigger: trigger } : {};
  if (result.dryRun) return { ...result, ...origin, automaticAnalysis: { state: "skipped", reason: "analysis_dry_run" } };
  // An early refusal can echo a caller-supplied ID belonging to an older run.
  // Require this invocation's internal final-publication receipt before reading that ID.
  const prepared = finalizedResults.get(result);
  if (!result.runId || result.runId === "not-created" || prepared === undefined) {
    return { ...result, ...origin, automaticAnalysis: { state: "skipped", reason: "analysis_source_unavailable" } };
  }
  let cleanup: void | (() => void) = undefined;
  try {
    cleanup = hooks?.onStart?.();
    try { await validatePreparedRunRootIdentity(prepared); }
    catch { return { ...result, ...origin, automaticAnalysis: { state: "failed", reason: "analysis_source_changed" } }; }
    const sourceCwd = path.dirname(path.dirname(prepared.physicalRunsRoot));
    const automaticAnalysis = await (hooks?.run ?? runAutomaticStudyAnalysis)(sourceCwd, result.runId, config,
      { ...hooks?.deps, preferLargerOutput, ...(trigger === "default" ? { defaultRequest: true } : {}), expectedRun: prepared });
    return { ...result, ...origin, automaticAnalysis };
  } catch {
    // Preserve the producer result. Never put a hook exception or provider response in the envelope.
    return { ...result, ...origin, automaticAnalysis: { state: "failed", reason: "analysis_automatic_failed" } };
  } finally {
    try { cleanup?.(); } catch { /* Cleanup cannot erase accounting or the completed recording. */ }
  }
}

export function automaticAnalysisSucceeded(result: AutomaticAnalysisResult): boolean {
  const value = result.automaticAnalysis;
  if (value === undefined) return true;
  if (value.state === "skipped") return value.reason === "analysis_dry_run"
    || (result.automaticAnalysisTrigger === "default" && ["AUTOMATIC_ANALYSIS_KEY_MISSING", "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE"].includes(value.reason ?? ""));
  return (value.state === "complete" || value.state === "partial") && value.result?.ok === true;
}
