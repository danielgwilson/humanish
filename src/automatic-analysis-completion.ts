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
}

const finalizedResults = new WeakMap<object, string>();

/** Internal producer receipt: call only after final source publication, never for an early refusal. */
export function markFinalizedStudyResult<T extends object>(result: T, physicalCwd: string): T {
  finalizedResults.set(result, physicalCwd);
  return result;
}

/** One post-completion boundary shared by all live recording producers. */
export async function completeAutomaticAnalysis<T extends {
  cwd: string; runId: string; dryRun: boolean;
}>(result: T, config: StudyAnalysisConfig | undefined, hooks?: AutomaticAnalysisHooks): Promise<T & AutomaticAnalysisResult> {
  if (config === undefined) return result;
  if (result.dryRun) return { ...result, automaticAnalysis: { state: "skipped", reason: "analysis_dry_run" } };
  // An early refusal can echo a caller-supplied ID belonging to an older run.
  // Require this invocation's internal final-publication receipt before reading that ID.
  const sourceCwd = finalizedResults.get(result);
  if (!result.runId || result.runId === "not-created" || sourceCwd === undefined) {
    return { ...result, automaticAnalysis: { state: "skipped", reason: "analysis_source_unavailable" } };
  }
  let cleanup: void | (() => void) = undefined;
  try {
    cleanup = hooks?.onStart?.();
    const automaticAnalysis = await (hooks?.run ?? runAutomaticStudyAnalysis)(sourceCwd, result.runId, config, hooks?.deps);
    return { ...result, automaticAnalysis };
  } catch {
    // Preserve the producer result. Never put a hook exception or provider response in the envelope.
    return { ...result, automaticAnalysis: { state: "failed", reason: "analysis_automatic_failed" } };
  } finally {
    try { cleanup?.(); } catch { /* Cleanup cannot erase accounting or the completed recording. */ }
  }
}

export function automaticAnalysisSucceeded(result: { automaticAnalysis?: AutomaticStudyAnalysisOutcome }): boolean {
  const value = result.automaticAnalysis;
  if (value === undefined) return true;
  if (value.state === "skipped") return value.reason === "analysis_dry_run";
  return (value.state === "complete" || value.state === "partial") && value.result?.ok === true;
}
