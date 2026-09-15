import path from "node:path";
import { resolveRunPath } from "./run.js";
import { analyzeStudy, readCompletedStudyAnalysisSource, type AnalyzeDeps, type AnalyzeResult } from "./study-analysis-service.js";
import { STUDY_ANALYSIS_PROMPT_VERSION } from "./study-analysis-engine.js";
import { hashStudyAnalysisValue } from "./study-analysis-validation.js";
import { claimAutomaticStudyAnalysis, readAutomaticStudyAnalysisPrepared, requestAutomaticStudyAnalysisCancellationPrepared,
  type AutomaticStudyAnalysisView, type AutomaticStudyAnalysisOutcome, type AutomaticStudyAnalysisCancellation,
  type AutomaticStudyAnalysisJob } from "./study-analysis-job.js";
import type { StudyAnalysisConfig } from "./study-analysis.js";

export type { AutomaticStudyAnalysisView, AutomaticStudyAnalysisOutcome, AutomaticStudyAnalysisCancellation } from "./study-analysis-job.js";
export type AutomaticStudyAnalysisDeps = Omit<AnalyzeDeps, "analysisId" | "beforeDispatch">;

const exactId = (runId: string): boolean => runId !== "latest" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId);
const skipped = (reason: string): AutomaticStudyAnalysisOutcome => ({ state: "skipped", reason });

/** Small read-only TUI/CLI projection. Neither this nor Observer can resume a job. */
export async function readAutomaticStudyAnalysis(cwd: string, runId: string): Promise<AutomaticStudyAnalysisView | undefined> {
  if (!exactId(runId)) return undefined;
  const prepared = await resolveRunPath(path.resolve(cwd), runId).catch(() => null);
  return prepared ? readAutomaticStudyAnalysisPrepared(prepared) : undefined;
}

export async function requestAutomaticStudyAnalysisCancellation(cwd: string, runId: string): Promise<AutomaticStudyAnalysisCancellation> {
  if (!exactId(runId)) return { requested: false, reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" };
  const prepared = await resolveRunPath(path.resolve(cwd), runId).catch(() => null);
  return prepared ? requestAutomaticStudyAnalysisCancellationPrepared(prepared)
    : { requested: false, reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" };
}

function outcomeOf(result: AnalyzeResult): AutomaticStudyAnalysisOutcome {
  if (result.error?.code === "ANALYSIS_PUBLICATION_FAILED") return { state: "failed", reason: "AUTOMATIC_ANALYSIS_PUBLICATION_FAILED", result };
  if (result.status) return { state: result.status, result, reason: result.reused ? "AUTOMATIC_ANALYSIS_REUSED"
    : result.status === "partial" ? "AUTOMATIC_ANALYSIS_LIMITATIONS"
    : result.status === "failed" ? "AUTOMATIC_ANALYSIS_FAILED"
    : result.status === "cancelled" ? "AUTOMATIC_ANALYSIS_CANCELLED" : null };
  const code = result.error?.code;
  if (code === "ANALYSIS_CANCELLED") return { state: "cancelled", reason: "AUTOMATIC_ANALYSIS_CANCELLED", result };
  if (code === "ANALYSIS_API_KEY_MISSING") return { ...skipped("AUTOMATIC_ANALYSIS_KEY_MISSING"), result };
  if (code === "ANALYSIS_BUSY") return { ...skipped("AUTOMATIC_ANALYSIS_BUSY"), result };
  if (code === "ANALYSIS_HISTORY_UNAVAILABLE") return { ...skipped("AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE"), result };
  if (code === "ANALYSIS_CONFIG_INVALID" || code === "ANALYSIS_QUESTION_UNSAFE" || code?.startsWith("analysis_")) {
    return { ...skipped("AUTOMATIC_ANALYSIS_ADMISSION_REFUSED"), result };
  }
  return { state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN", result };
}

/** One permanent claim per completed run, consumed even when preparation/cancellation fails.
 * Only the original opted-in producer calls this after all recording writes return.
 * No file reader, restart recovery, Observer poll or export calls this function. */
export async function runAutomaticStudyAnalysis(cwdInput: string, runId: string, configInput: StudyAnalysisConfig,
  deps: AutomaticStudyAnalysisDeps = {}): Promise<AutomaticStudyAnalysisOutcome> {
  if (!exactId(runId)) return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE");
  const cwd = path.resolve(cwdInput);
  const prepared = await resolveRunPath(cwd, runId).catch(() => null);
  if (!prepared) return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE");
  // Do not consume a future run's one claim while a producer is still writing it.
  try { await readCompletedStudyAnalysisSource(cwd, prepared); }
  catch { return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE"); }
  const config = structuredClone(configInput);
  let job: AutomaticStudyAnalysisJob;
  try {
    const claimed = await claimAutomaticStudyAnalysis(prepared, { configDigest: hashStudyAnalysisValue(config), promptVersion: STUDY_ANALYSIS_PROMPT_VERSION });
    if (!claimed) return skipped("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
    job = claimed;
  } catch { return { state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" }; }

  const controller = new AbortController();
  const signal = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
  let polling = false;
  let storageFailed = false;
  let cancellationFailed = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try { if (await job.cancellationRequested()) controller.abort(); }
    catch { cancellationFailed = true; controller.abort(); }
    finally { polling = false; }
  };
  const cancellationTimer = setInterval(() => { void poll(); }, 250);
  cancellationTimer.unref();
  const heartbeat = setInterval(() => {
    void job.touch().catch(() => { storageFailed = true; controller.abort(); });
  }, 5000);
  heartbeat.unref();
  let outcome: AutomaticStudyAnalysisOutcome;
  try {
    await poll();
    const result = await analyzeStudy(cwd, runId, { config }, {
      ...deps, signal, analysisId: job.attemptId,
      beforeDispatch: async (context) => {
        if (await job.cancellationRequested()) controller.abort();
        if (signal.aborted) return;
        await job.update({ state: "running", analysisId: context.id, startedAt: new Date().toISOString(),
          sourceRunSha256: context.sourceRunSha256, inputDigest: context.inputDigest });
      }
    });
    outcome = outcomeOf(result);
    if (cancellationFailed) outcome = { state: "unknown", reason: "AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE", result };
    if (storageFailed) outcome = { state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE", result };
  } catch { outcome = { state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" }; }
  finally { clearInterval(cancellationTimer); clearInterval(heartbeat); }
  try {
    await job.update({ state: outcome.state, reason: outcome.reason as Exclude<Parameters<AutomaticStudyAnalysisJob["update"]>[0]["reason"], undefined>,
      analysisId: outcome.result?.analysisId ?? null });
  } catch { return { ...outcome, state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" }; }
  return outcome;
}
