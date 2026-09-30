import { physicalCwdOf, validatePreparedRunRootIdentity } from "../run/paths.js";
import { FinishedRun } from "../run/run.js";
import type { StudyAnalysisConfig } from "./study-analysis.js";
import { runAutomaticStudyAnalysis, type AutomaticStudyAnalysisDeps } from "./automatic.js";
import type { AutomaticStudyAnalysisOutcome } from "./job.js";

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

/**
 * One post-completion boundary shared by all live recording producers. `finished` is the token
 * the producer's run scope issued when the run published its final bundle; without it, or when it
 * names another run than the result, there is no source to analyze.
 */
export async function completeAutomaticAnalysis<
  T extends {
    cwd: string;
    runId: string;
    dryRun: boolean;
  },
>(
  result: T,
  finished: FinishedRun | undefined,
  config: StudyAnalysisConfig | undefined,
  hooks?: AutomaticAnalysisHooks,
  trigger: "default" | "explicit" = "explicit",
  preferLargerOutput = false,
): Promise<T & AutomaticAnalysisResult> {
  if (config === undefined) return result;
  const origin = trigger === "default" ? { automaticAnalysisTrigger: trigger } : {};
  if (result.dryRun)
    return {
      ...result,
      ...origin,
      automaticAnalysis: { state: "skipped", reason: "analysis_dry_run" },
    };
  // An early refusal can echo a caller-supplied ID belonging to an older run, so the ID alone
  // proves nothing. Only this invocation's own publication token names a source.
  if (!FinishedRun.isIssued(finished) || finished.runId !== result.runId) {
    return {
      ...result,
      ...origin,
      automaticAnalysis: { state: "skipped", reason: "analysis_source_unavailable" },
    };
  }
  const prepared = finished.paths;
  let cleanup: void | (() => void) = undefined;
  try {
    cleanup = hooks?.onStart?.();
    try {
      await validatePreparedRunRootIdentity(prepared);
    } catch {
      return {
        ...result,
        ...origin,
        automaticAnalysis: { state: "failed", reason: "analysis_source_changed" },
      };
    }
    const sourceCwd = physicalCwdOf(prepared);
    const automaticAnalysis = await (hooks?.run ?? runAutomaticStudyAnalysis)(
      sourceCwd,
      finished.runId,
      config,
      {
        ...hooks?.deps,
        preferLargerOutput,
        ...(trigger === "default" ? { defaultRequest: true } : {}),
        expectedRun: prepared,
      },
    );
    return { ...result, ...origin, automaticAnalysis };
  } catch {
    // Preserve the producer result. Never put a hook exception or provider response in the envelope.
    return {
      ...result,
      ...origin,
      automaticAnalysis: { state: "failed", reason: "analysis_automatic_failed" },
    };
  } finally {
    try {
      cleanup?.();
    } catch {
      /* Cleanup cannot erase accounting or the completed recording. */
    }
  }
}

/**
 * True when an analysis the lab never declared was refused because its conservative estimate is
 * over the default cap. The author did not ask for it, so the refusal does not fail the run;
 * `humanish analyze --max-cost` can still run it.
 */
export function defaultAnalysisOverBudget(result: AutomaticAnalysisResult): boolean {
  const value = result.automaticAnalysis;
  return (
    result.automaticAnalysisTrigger === "default" &&
    value?.state === "skipped" &&
    value.reason === "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED" &&
    value.result?.error?.code === "analysis_budget_exceeded"
  );
}

export function automaticAnalysisSucceeded(result: AutomaticAnalysisResult): boolean {
  const value = result.automaticAnalysis;
  if (value === undefined) return true;
  if (value.state === "skipped")
    return (
      value.reason === "analysis_dry_run" ||
      (result.automaticAnalysisTrigger === "default" &&
        ["AUTOMATIC_ANALYSIS_KEY_MISSING", "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE"].includes(
          value.reason ?? "",
        )) ||
      defaultAnalysisOverBudget(result)
    );
  return (value.state === "complete" || value.state === "partial") && value.result?.ok === true;
}
