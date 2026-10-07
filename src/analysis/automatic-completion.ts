import { physicalCwdOf, validatePreparedRunRootIdentity } from "../run/paths.js";
import { FinishedRun } from "../run/run.js";
import type { AnalysisConfig } from "./types.js";
import type { StudyDeps } from "../study/study-deps.js";
import type { StudyEvent } from "../study/run-study-events.js";
import { runAutomaticAnalysis, type AutomaticAnalysisDeps } from "./automatic.js";
import type { AutomaticAnalysisOutcome } from "./job.js";

/** What a route's input gives its analysis: the test's runner and deps, the signal and onEvent. */
export interface AnalysisInput {
  readonly deps?: Pick<StudyDeps, "analysis">;
  /** Cancels the analysis only. */
  readonly analysisSignal?: AbortSignal;
  /** Receives analysis-started and analysis-finished, around the analysis of a run where a
   *  participant's session started. */
  readonly emit?: (event: StudyEvent) => void;
}

export interface AutomaticAnalysisResult {
  automaticAnalysis?: AutomaticAnalysisOutcome;
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
  config: AnalysisConfig | undefined,
  input: AnalysisInput | undefined,
  {
    trigger = "explicit",
    preferLargerOutput = false,
    refusal,
  }: {
    /** "default" when the study declared no analysis; its missing-key skip is not a failure. */
    trigger?: "default" | "explicit";
    /** The study omitted an output limit, so a larger one may be used within the admission budget. */
    preferLargerOutput?: boolean;
    /** The route's reason not to analyze this run; see AutomaticAnalysisDeps.refusal. */
    refusal?: AutomaticAnalysisDeps["refusal"];
  } = {},
): Promise<T & AutomaticAnalysisResult> {
  if (config === undefined) return result;
  const origin = trigger === "default" ? { automaticAnalysisTrigger: trigger } : {};
  if (result.dryRun)
    return {
      ...result,
      ...origin,
      automaticAnalysis: { state: "skipped", reason: "AUTOMATIC_ANALYSIS_DRY_RUN" },
    };
  // An early refusal can echo a caller-supplied ID belonging to an older run, so the ID alone
  // proves nothing. Only this invocation's own publication token names a source.
  if (!FinishedRun.isIssued(finished) || finished.runId !== result.runId) {
    return {
      ...result,
      ...origin,
      automaticAnalysis: { state: "skipped", reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" },
    };
  }
  // A signal is stopping this process: the run is recorded interrupted, and the process exits
  // once its sandboxes are reclaimed, so no analysis starts.
  if (finished.interrupted)
    return {
      ...result,
      ...origin,
      automaticAnalysis: { state: "skipped", reason: "AUTOMATIC_ANALYSIS_ACTOR_CANCELLED" },
    };
  const prepared = finished.paths;
  const seams = input?.deps?.analysis;
  const signal = input?.analysisSignal;
  let started = false;
  try {
    // The CLI prints "Participants finished" on analysis-started. A run where no participant's
    // session started (it failed before, such as at E2B login) still records its analysis
    // outcome, but without the two events.
    if (finished.participantsRan) {
      input?.emit?.({ type: "analysis-started" });
      started = true;
    }
    try {
      await validatePreparedRunRootIdentity(prepared);
    } catch {
      return {
        ...result,
        ...origin,
        automaticAnalysis: { state: "failed", reason: "AUTOMATIC_ANALYSIS_SOURCE_CHANGED" },
      };
    }
    const sourceCwd = physicalCwdOf(prepared);
    const automaticAnalysis = await (seams?.run ?? runAutomaticAnalysis)(
      sourceCwd,
      finished.runId,
      config,
      {
        ...seams?.deps,
        ...(signal === undefined ? {} : { signal }),
        ...(refusal === undefined ? {} : { refusal }),
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
      automaticAnalysis: { state: "failed", reason: "AUTOMATIC_ANALYSIS_FAILED" },
    };
  } finally {
    try {
      if (started) input?.emit?.({ type: "analysis-finished" });
    } catch {
      /* A report cannot erase accounting or the completed recording. */
    }
  }
}

/**
 * True when an analysis the study never declared was refused because its expected cost, with the
 * admission margin, is over the default cap. The author did not ask for it, so the refusal does not fail the run;
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
      value.reason === "AUTOMATIC_ANALYSIS_DRY_RUN" ||
      (result.automaticAnalysisTrigger === "default" &&
        ["AUTOMATIC_ANALYSIS_KEY_MISSING", "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE"].includes(
          value.reason ?? "",
        )) ||
      defaultAnalysisOverBudget(result)
    );
  return (value.state === "complete" || value.state === "partial") && value.result?.ok === true;
}
