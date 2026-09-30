import path from "node:path";
import { resolveRunPath } from "../run/locate.js";
import { type RunBundle } from "../run/bundle.js";
import {
  refreshObserver,
  analyzeStudy,
  readCompletedStudyAnalysisSource,
  resolveStudyAnalysisRun,
  type AnalyzeDeps,
  type AnalyzeResult,
} from "./service.js";
import { preferLargerStudyAnalysisOutput, STUDY_ANALYSIS_PROMPT_VERSION } from "./engine.js";
import { captureStudyEvidence } from "./evidence.js";
import { hashStudyAnalysisValue } from "./validation.js";
import {
  claimAutomaticStudyAnalysis,
  readAutomaticStudyAnalysisPrepared,
  requestAutomaticStudyAnalysisCancellationPrepared,
  type AutomaticStudyAnalysisView,
  type AutomaticStudyAnalysisOutcome,
  type AutomaticStudyAnalysisCancellation,
  type AutomaticStudyAnalysisJob,
} from "./job.js";
import { ANALYSIS_ID_PATTERN, type StudyAnalysisConfig } from "./study-analysis.js";
import { readStudyAnalysisVersion } from "./store.js";
import { readStudyAnalysisExecution } from "./store-executions.js";
import { physicalCwdOf, resolvePhysicalCwd, type PreparedRunArtifactPaths } from "../run/paths.js";

export type {
  AutomaticStudyAnalysisView,
  AutomaticStudyAnalysisOutcome,
  AutomaticStudyAnalysisCancellation,
} from "./job.js";
export type AutomaticStudyAnalysisDeps = Omit<AnalyzeDeps, "analysisId" | "beforeDispatch"> & {
  /** A missing default key records a skip before admission, preserving a successful recording. */
  defaultRequest?: boolean;
  /** Expand an omitted output limit only within the existing admission budget. */
  preferLargerOutput?: boolean;
};

const CANCELLATION_POLL_MS = 250;
// Well inside AUTOMATIC_STUDY_ANALYSIS_STALE_MS, so a live owner never reads as stale.
const HEARTBEAT_MS = 5000;
const exactId = (runId: string): boolean => runId !== "latest" && ANALYSIS_ID_PATTERN.test(runId);
const skipped = (reason: string): AutomaticStudyAnalysisOutcome => ({ state: "skipped", reason });

function hasParticipantEvidence(bundle: RunBundle): boolean {
  return bundle.streams.some((stream) => {
    // Terminal commands and transcript messages also include launcher output.
    // Fresh producers count recognized participant runtime items separately.
    if (stream.actor?.lane === "terminal")
      return (stream.actor.counts.runtimeParticipantItems ?? 0) > 0;
    return stream.actor?.items.some(
      (item) =>
        ["screenshot", "ui_action", "command", "tool_call", "file_change", "approval"].includes(
          item.kind,
        ) ||
        (["message", "reasoning"].includes(item.kind) && !!item.text?.trim()),
    );
  });
}

/** Small read-only TUI/CLI projection. Neither this nor Observer can resume a job. */
export async function readAutomaticStudyAnalysis(
  cwd: string,
  runId: string,
): Promise<AutomaticStudyAnalysisView | undefined> {
  if (!exactId(runId)) return undefined;
  const prepared = await resolveRunPath(await resolvePhysicalCwd(cwd), runId).catch(() => null);
  return prepared ? readAutomaticStudyAnalysisPrepared(prepared) : undefined;
}

export async function requestAutomaticStudyAnalysisCancellation(
  cwd: string,
  runId: string,
): Promise<AutomaticStudyAnalysisCancellation> {
  if (!exactId(runId)) return { requested: false, reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" };
  const prepared = await resolveRunPath(await resolvePhysicalCwd(cwd), runId).catch(() => null);
  return prepared
    ? requestAutomaticStudyAnalysisCancellationPrepared(prepared)
    : { requested: false, reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" };
}

/** The job reason for an analysis that reached a status. */
function statusReason(result: AnalyzeResult): string | null {
  if (result.reused) return "AUTOMATIC_ANALYSIS_REUSED";
  if (result.status === "partial") {
    if (result.error?.code === "analysis_admission_estimate_exceeded")
      return "AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED";
    return result.ok ? "AUTOMATIC_ANALYSIS_LIMITATIONS" : "AUTOMATIC_ANALYSIS_FAILED";
  }
  if (result.status === "failed") return "AUTOMATIC_ANALYSIS_FAILED";
  if (result.status === "cancelled") return "AUTOMATIC_ANALYSIS_CANCELLED";
  return null;
}

function outcomeOf(result: AnalyzeResult): AutomaticStudyAnalysisOutcome {
  if (result.error?.code === "ANALYSIS_PUBLICATION_FAILED")
    return { state: "failed", reason: "AUTOMATIC_ANALYSIS_PUBLICATION_FAILED", result };
  if (result.error?.code?.startsWith("analysis_codex_"))
    return { state: "failed", reason: "AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE", result };
  if (result.status) return { state: result.status, result, reason: statusReason(result) };
  const code = result.error?.code;
  if (code === "ANALYSIS_CANCELLED")
    return { state: "cancelled", reason: "AUTOMATIC_ANALYSIS_CANCELLED", result };
  if (code === "ANALYSIS_API_KEY_MISSING")
    return { ...skipped("AUTOMATIC_ANALYSIS_KEY_MISSING"), result };
  if (code === "ANALYSIS_BUSY") return { ...skipped("AUTOMATIC_ANALYSIS_BUSY"), result };
  if (code === "ANALYSIS_HISTORY_UNAVAILABLE")
    return { ...skipped("AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE"), result };
  if (
    code === "ANALYSIS_CONFIG_INVALID" ||
    code === "ANALYSIS_QUESTION_UNSAFE" ||
    code?.startsWith("analysis_")
  ) {
    return { ...skipped("AUTOMATIC_ANALYSIS_ADMISSION_REFUSED"), result };
  }
  return { state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN", result };
}

/**
 * Read the finished source before claiming the run's one job, so a claim is never consumed while a
 * producer is still writing. Returns a skip outcome, or the participant-evidence flag and the
 * config the job binds (a defaulted output limit may grow within the admission budget).
 */
async function readAutomaticSource(
  cwd: string,
  prepared: PreparedRunArtifactPaths,
  configInput: StudyAnalysisConfig,
  deps: AutomaticStudyAnalysisDeps,
  hasKey: boolean,
): Promise<
  AutomaticStudyAnalysisOutcome | { participantEvidence: boolean; config: StudyAnalysisConfig }
> {
  let config = configInput;
  try {
    const bytes = await readCompletedStudyAnalysisSource(cwd, prepared);
    const bundle = JSON.parse(bytes.toString("utf8")) as RunBundle;
    if (bundle.streams.some((stream) => stream.actor?.stopCause === "harness_aborted"))
      return skipped("AUTOMATIC_ANALYSIS_ACTOR_CANCELLED");
    const participantEvidence = hasParticipantEvidence(bundle);
    // Bind the permanent job claim to the actual configuration before dispatch.
    // Missing-key/no-evidence skips don't need to read captured image bytes.
    if (
      config.provider !== "codex" &&
      deps.preferLargerOutput &&
      (!deps.defaultRequest || participantEvidence) &&
      hasKey
    ) {
      config = preferLargerStudyAnalysisOutput(await captureStudyEvidence(prepared, bytes), config);
    }
    return { participantEvidence, config };
  } catch {
    return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE");
  }
}

/**
 * Bind the job's terminal metadata to the exact safely published execution. Reads never promote a
 * completed-looking sidecar without rechecking these bindings. Null when storage failed.
 */
async function persistOutcome(
  job: AutomaticStudyAnalysisJob,
  prepared: PreparedRunArtifactPaths,
  outcome: AutomaticStudyAnalysisOutcome,
): Promise<AutomaticStudyAnalysisOutcome | null> {
  try {
    const analysisId = outcome.result?.analysisId;
    const [entry, receipt] = analysisId
      ? await Promise.all([
          readStudyAnalysisVersion(prepared, analysisId),
          readStudyAnalysisExecution(prepared, analysisId),
        ])
      : [null, null];
    await job.update({
      state: outcome.state,
      reason: outcome.reason as Exclude<
        Parameters<AutomaticStudyAnalysisJob["update"]>[0]["reason"],
        undefined
      >,
      analysisId: analysisId ?? null,
      ...(receipt === null
        ? {}
        : {
            sourceRunSha256: receipt.sourceRunSha256,
            inputDigest: receipt.inputDigest,
            receiptSha256: hashStudyAnalysisValue(receipt),
          }),
      ...(entry?.analysis ? { analysisSha256: hashStudyAnalysisValue(entry.analysis) } : {}),
    });
    const persisted = await readAutomaticStudyAnalysisPrepared(prepared);
    return persisted?.state === "unknown"
      ? { ...outcome, state: "unknown", reason: persisted.reason }
      : outcome;
  } catch {
    return null;
  }
}

/** One permanent claim per completed run, consumed even when preparation/cancellation fails.
 * Only the original producer calls this after all recording writes return.
 * No file reader, restart recovery, Observer poll or export calls this function. */
export async function runAutomaticStudyAnalysis(
  cwdInput: string,
  runId: string,
  configInput: StudyAnalysisConfig,
  deps: AutomaticStudyAnalysisDeps = {},
): Promise<AutomaticStudyAnalysisOutcome> {
  if (!exactId(runId)) return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE");
  let cwd = path.resolve(cwdInput);
  const prepared = await resolveStudyAnalysisRun(cwd, runId, deps.expectedRun).catch(() => null);
  if (!prepared) return skipped("AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE");
  cwd = physicalCwdOf(prepared);
  const hasKey = Boolean((deps.apiKey ?? process.env.OPENAI_API_KEY)?.trim());
  const source = await readAutomaticSource(
    cwd,
    prepared,
    structuredClone(configInput),
    deps,
    hasKey,
  );
  if ("state" in source) return source;
  const { participantEvidence } = source;
  let config = source.config;
  // The claim digest must cover the Codex release that will run.
  if (config.provider === "codex" && (deps.detectCodexCliVersion || !deps.codexProvider))
    config = await (
      await import("./restricted-codex.js")
    ).bindCodexAnalysisCliVersion(config, deps.detectCodexCliVersion);
  let job: AutomaticStudyAnalysisJob;
  try {
    const claimed = await claimAutomaticStudyAnalysis(prepared, {
      configDigest: hashStudyAnalysisValue(config),
      promptVersion: STUDY_ANALYSIS_PROMPT_VERSION,
    });
    if (!claimed) return skipped("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
    job = claimed;
  } catch {
    return { state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" };
  }

  const controller = new AbortController();
  const signal = deps.signal
    ? AbortSignal.any([deps.signal, controller.signal])
    : controller.signal;
  let polling = false;
  let storageFailed = false;
  let cancellationFailed = false;
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      if (await job.cancellationRequested()) controller.abort();
    } catch {
      cancellationFailed = true;
      controller.abort();
    } finally {
      polling = false;
    }
  };
  const cancellationTimer = setInterval(() => {
    void poll();
  }, CANCELLATION_POLL_MS);
  cancellationTimer.unref();
  const heartbeat = setInterval(() => {
    void job.touch().catch(() => {
      storageFailed = true;
      controller.abort();
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let outcome: AutomaticStudyAnalysisOutcome;
  try {
    await poll();
    const missingKey = config.provider !== "codex" && !hasKey;
    if (deps.defaultRequest === true && (missingKey || !participantEvidence)) {
      outcome = signal.aborted
        ? { state: "cancelled", reason: "AUTOMATIC_ANALYSIS_CANCELLED" }
        : skipped(
            missingKey
              ? "AUTOMATIC_ANALYSIS_KEY_MISSING"
              : "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE",
          );
    } else {
      const result = await analyzeStudy(
        cwd,
        runId,
        { config },
        {
          ...deps,
          signal,
          codexCliVersionBound: true,
          expectedRun: prepared,
          analysisId: job.attemptId,
          beforeDispatch: async (context) => {
            if (await job.cancellationRequested()) controller.abort();
            if (signal.aborted) return;
            await job.update({
              state: "running",
              analysisId: context.id,
              startedAt: new Date().toISOString(),
              sourceRunSha256: context.sourceRunSha256,
              inputDigest: context.inputDigest,
            });
          },
        },
      );
      outcome = outcomeOf(result);
    }
    if (cancellationFailed)
      outcome = {
        ...outcome,
        state: "unknown",
        reason: "AUTOMATIC_ANALYSIS_CANCELLATION_UNAVAILABLE",
      };
    if (storageFailed)
      outcome = { ...outcome, state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" };
  } catch {
    outcome = { state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" };
  } finally {
    clearInterval(cancellationTimer);
    clearInterval(heartbeat);
  }
  const persisted = await persistOutcome(job, prepared, outcome);
  if (persisted === null)
    return { ...outcome, state: "unknown", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" };
  outcome = persisted;
  // The service may render while this owner is still running. Freeze the final
  // job projection for direct file opening too, including no-request outcomes.
  // A failed refresh must never erase the durable outcome or measured usage.
  if (!(await refreshObserver(cwd, runId, prepared)) && outcome.result)
    outcome = {
      ...outcome,
      result: {
        ...outcome.result,
        warnings: [
          ...outcome.result.warnings,
          "Automatic analysis status was saved, but Observer could not be refreshed. Run humanish observe again.",
        ],
      },
    };
  return outcome;
}
