import path from "node:path";
import { renderObserver } from "./observer.js";
import { resolveRunPath, type RunBundle } from "./run.js";
import { analyzeStudy, readCompletedStudyAnalysisSource, resolveStudyAnalysisRun, type AnalyzeDeps, type AnalyzeResult } from "./study-analysis-service.js";
import { STUDY_ANALYSIS_PROMPT_VERSION } from "./study-analysis-engine.js";
import { hashStudyAnalysisValue } from "./study-analysis-validation.js";
import { claimAutomaticStudyAnalysis, readAutomaticStudyAnalysisPrepared, requestAutomaticStudyAnalysisCancellationPrepared,
  type AutomaticStudyAnalysisView, type AutomaticStudyAnalysisOutcome, type AutomaticStudyAnalysisCancellation,
  type AutomaticStudyAnalysisJob } from "./study-analysis-job.js";
import type { StudyAnalysisConfig } from "./study-analysis.js";
import { readStudyAnalysisExecution, readStudyAnalysisVersion } from "./study-analysis-store.js";

export type { AutomaticStudyAnalysisView, AutomaticStudyAnalysisOutcome, AutomaticStudyAnalysisCancellation } from "./study-analysis-job.js";
export type AutomaticStudyAnalysisDeps = Omit<AnalyzeDeps, "analysisId" | "beforeDispatch"> & {
  /** A missing default key records a skip before admission, preserving a successful recording. */
  defaultRequest?: boolean;
};

const exactId = (runId: string): boolean => runId !== "latest" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId);
const skipped = (reason: string): AutomaticStudyAnalysisOutcome => ({ state: "skipped", reason });

function hasParticipantEvidence(bundle: RunBundle): boolean {
  return bundle.streams.some(stream => {
    // Terminal commands and transcript messages also include launcher output.
    // Fresh producers count recognized participant runtime items separately.
    if (stream.actor?.lane === "terminal") return (stream.actor.counts.runtimeParticipantItems ?? 0) > 0;
    return stream.actor?.items.some(item => ["screenshot", "ui_action", "command", "tool_call", "file_change", "approval"].includes(item.kind)
      || (["message", "reasoning"].includes(item.kind) && !!item.text?.trim()));
  });
}

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
    : result.status === "partial" ? (result.error?.code === "analysis_admission_estimate_exceeded"
      ? "AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED" : result.ok ? "AUTOMATIC_ANALYSIS_LIMITATIONS" : "AUTOMATIC_ANALYSIS_FAILED")
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
 * Only the original producer calls this after all recording writes return.
 * No file reader, restart recovery, Observer poll or export calls this function. */
export async function runAutomaticStudyAnalysis(cwdInput: string, runId: string, configInput: StudyAnalysisConfig,
  deps: AutomaticStudyAnalysisDeps = {}): Promise<AutomaticStudyAnalysisOutcome> {
  if (!exactId(runId)) return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE");
  let cwd = path.resolve(cwdInput);
  const prepared = await resolveStudyAnalysisRun(cwd, runId, deps.expectedRun).catch(() => null);
  if (!prepared) return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE");
  cwd = path.dirname(path.dirname(prepared.physicalRunsRoot));
  let participantEvidence = false;
  // Do not consume a future run's one claim while a producer is still writing it.
  try {
    const bytes = await readCompletedStudyAnalysisSource(cwd, prepared);
    const bundle = JSON.parse(bytes.toString("utf8")) as RunBundle;
    if (bundle.streams.some(stream => stream.actor?.stopCause === "harness_aborted")) return skipped("AUTOMATIC_ANALYSIS_ACTOR_CANCELLED");
    participantEvidence = hasParticipantEvidence(bundle);
  }
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
    const missingKey = !(deps.apiKey ?? process.env.OPENAI_API_KEY)?.trim();
    if (deps.defaultRequest === true && (missingKey || !participantEvidence)) {
      outcome = signal.aborted ? { state: "cancelled", reason: "AUTOMATIC_ANALYSIS_CANCELLED" }
        : skipped(missingKey ? "AUTOMATIC_ANALYSIS_KEY_MISSING" : "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE");
    } else {
      const result = await analyzeStudy(cwd, runId, { config }, {
        ...deps, signal, expectedRun: prepared, analysisId: job.attemptId,
        beforeDispatch: async (context) => {
          if (await job.cancellationRequested()) controller.abort();
          if (signal.aborted) return;
          await job.update({ state: "running", analysisId: context.id, startedAt: new Date().toISOString(),
            sourceRunSha256: context.sourceRunSha256, inputDigest: context.inputDigest });
        }
      });
      outcome = outcomeOf(result);
    }
    if (cancellationFailed) outcome = { ...outcome, state: "unknown", reason: "AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE" };
    if (storageFailed) outcome = { ...outcome, state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" };
  } catch { outcome = { state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" }; }
  finally { clearInterval(cancellationTimer); clearInterval(heartbeat); }
  try {
    // Bind terminal metadata to the exact safely published execution. Reads never
    // promote a completed-looking sidecar without rechecking these bindings.
    const analysisId = outcome.result?.analysisId;
    const [entry, receipt] = analysisId ? await Promise.all([
      readStudyAnalysisVersion(prepared, analysisId), readStudyAnalysisExecution(prepared, analysisId)
    ]) : [null, null];
    await job.update({ state: outcome.state, reason: outcome.reason as Exclude<Parameters<AutomaticStudyAnalysisJob["update"]>[0]["reason"], undefined>,
      analysisId: analysisId ?? null,
      ...(receipt === null ? {} : { sourceRunSha256: receipt.sourceRunSha256, inputDigest: receipt.inputDigest,
        receiptSha256: hashStudyAnalysisValue(receipt) }),
      ...(entry?.analysis ? { analysisSha256: hashStudyAnalysisValue(entry.analysis) } : {}) });
    const persisted = await readAutomaticStudyAnalysisPrepared(prepared);
    if (persisted?.state === "unknown") outcome = { ...outcome, state: "unknown", reason: persisted.reason };
  } catch { return { ...outcome, state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" }; }
  // The service may render while this owner is still running. Freeze the final
  // job projection for direct file opening too, including no-request outcomes.
  // A failed refresh must never erase the durable outcome or measured usage.
  try {
    const rendered = await renderObserver(cwd, runId, { open: false, expectedRun: prepared });
    if (!rendered.ok) throw new Error("AUTOMATIC_ANALYSIS_OBSERVER_UNAVAILABLE");
  } catch {
    if (outcome.result) outcome = { ...outcome, result: { ...outcome.result,
      warnings: [...outcome.result.warnings, "Automatic analysis status was saved, but Observer could not be refreshed. Run humanish observe again."] } };
  }
  return outcome;
}
