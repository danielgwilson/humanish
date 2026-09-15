import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { renderObserver } from "./observer.js";
import { containsSensitive } from "./redaction.js";
import { loadRunBundlePrepared, resolveRunPath, verifyRunPrepared } from "./run.js";
import { validatePreparedRunRootIdentity, type PreparedRunArtifactPaths } from "./run-paths.js";
import { isRunStatusRecord, RUN_STATUS_FILE } from "./run-status.js";
import { captureStudyEvidence, readBoundedStudyFile, STUDY_EVIDENCE_LIMITS } from "./study-analysis-evidence.js";
import { estimateStudyAnalysisAdmission, runStudyAnalysis, STUDY_ANALYSIS_PROMPT_VERSION,
  type StudyAnalysisAdmission, type StudyAnalysisProgress, type StudyAnalysisDispatchContext } from "./study-analysis-engine.js";
import { appendStudyAnalysisCorrection, assertStudyAnalysisPublicationCapacity, listStudyAnalyses, loadStudyAnalysis, writeStudyAnalysis, writeStudyAnalysisExecutionReceipt } from "./study-analysis-store.js";
import { hashStudyAnalysisValue } from "./study-analysis-validation.js";
import { STUDY_ANALYSIS_CORRECTION_SCHEMA, type StudyAnalysisArtifact, type StudyAnalysisConfig,
  type StudyAnalysisCorrection, type LoadedStudyAnalysis } from "./study-analysis.js";

export const ANALYZE_RESULT_SCHEMA = "humanish.analyze-result.v1";
export interface AnalyzeOptions {
  config: StudyAnalysisConfig;
  dryRun?: boolean;
  rerun?: boolean;
}
export interface AnalyzeResult {
  schema: typeof ANALYZE_RESULT_SCHEMA;
  ok: boolean;
  run: string;
  dryRun: boolean;
  reused: boolean;
  analysisId?: string;
  artifactPath?: string;
  executionReceiptPath?: string;
  status?: StudyAnalysisArtifact["status"];
  usage?: StudyAnalysisArtifact["usage"];
  admission?: StudyAnalysisAdmission;
  warnings: string[];
  error?: { code: string; message: string };
}
export interface AnalyzeDeps {
  apiKey?: string;
  signal?: AbortSignal;
  onProgress?: (progress: StudyAnalysisProgress) => void;
  /** Request boundary only: evidence capture, admission, validation and writes remain real. */
  fetch?: typeof fetch;
  /** Internal producer pin: use this original run identity without resolving a replacement. */
  expectedRun?: PreparedRunArtifactPaths;
  /** Internal post-run orchestration; never populated from an Observer request. */
  analysisId?: string;
  beforeDispatch?: (context: StudyAnalysisDispatchContext) => Promise<void>;
}

/** A producer pin is authority for one physical project and exact run ID only. */
export async function resolveStudyAnalysisRun(cwd: string, run: string, expectedRun?: PreparedRunArtifactPaths): Promise<PreparedRunArtifactPaths | null> {
  if (expectedRun === undefined) return resolveRunPath(cwd, run);
  const physicalCwd = path.dirname(path.dirname(expectedRun.physicalRunsRoot));
  const selectedCwd = await realpath(cwd).catch(() => null);
  if (selectedCwd !== physicalCwd || run !== path.basename(expectedRun.physicalRunRoot)) throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
  try { await validatePreparedRunRootIdentity(expectedRun); }
  catch { throw new Error("ANALYSIS_SOURCE_CHANGED"); }
  return expectedRun;
}

const messages: Record<string, string> = {
  ANALYSIS_RUN_NOT_FOUND: "The selected run is unavailable or its storage is unsafe.",
  ANALYSIS_VERIFY_FAILED: "The run must pass verification before analysis.",
  ANALYSIS_RUN_ACTIVE: "Analysis requires a completed recording. Wait for the study to finish.",
  ANALYSIS_NO_PARTICIPANTS: "This run contains no participant evidence to analyze.",
  ANALYSIS_REQUIRES_LIVE_RUN: "A dry-run proves harness contracts, not participant behavior. Select a completed live study for analysis.",
  ANALYSIS_SOURCE_UNAVAILABLE: "The source recording is missing, unsafe, or exceeds the input limit.",
  ANALYSIS_SOURCE_CHANGED: "The source recording changed during analysis. The result cannot be published against different evidence.",
  ANALYSIS_BUSY: "Another analysis holds this run's .analysis-lock directory. If it was interrupted, confirm it has stopped before removing that empty directory.",
  ANALYSIS_HISTORY_UNAVAILABLE: "Analysis history is unavailable or full. No request was sent. Inspect this run's analysis and analysis-attempts storage before retrying.",
  ANALYSIS_CONFIG_INVALID: "Use a supported analysis model, a positive cost ceiling up to 1000 USD, a timeout of 1–600000 ms, and 256–32768 output tokens.",
  ANALYSIS_QUESTION_UNSAFE: "The reviewer question matched a sensitive-text pattern. Remove sensitive details before retrying.",
  ANALYSIS_API_KEY_MISSING: "Set OPENAI_API_KEY to run analysis. --dry-run checks admission without a key or provider request.",
  ANALYSIS_CANCELLED: "Analysis was cancelled before dispatch.",
  ANALYSIS_UNAVAILABLE: "Analysis could not be completed safely. Source evidence was not changed."
};
const fail = (run: string, dryRun: boolean, code: string): AnalyzeResult => ({
  schema: ANALYZE_RESULT_SCHEMA, ok: false, run, dryRun, reused: false, warnings: [],
  error: { code, message: messages[code] ?? messages.ANALYSIS_UNAVAILABLE! }
});

/** One analysis or correction writer per run. Never steal a lock based on an untrusted PID. */
export async function withStudyAnalysisLock<T>(prepared: PreparedRunArtifactPaths, action: () => Promise<T>): Promise<T> {
  await validatePreparedRunRootIdentity(prepared);
  const target = path.join(prepared.physicalRunRoot, ".analysis-lock");
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ANALYSIS_BUSY");
    throw new Error("ANALYSIS_UNAVAILABLE");
  }
  const identity = await lstat(target, { bigint: true });
  try {
    await validatePreparedRunRootIdentity(prepared);
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("ANALYSIS_UNAVAILABLE");
    return await action();
  } finally {
    // Only remove our empty, unchanged directory. No recursive deletion and no replacement authority.
    try {
      await validatePreparedRunRootIdentity(prepared);
      const current = await lstat(target, { bigint: true });
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === identity.dev
        && current.ino === identity.ino && current.birthtimeNs === identity.birthtimeNs) await rmdir(target);
    } catch { /* Leave ambiguous storage in place for explicit operator inspection. */ }
  }
}

/** Internal completion gate shared with the opt-in post-run owner. */
export async function readCompletedStudyAnalysisSource(cwd: string, prepared: PreparedRunArtifactPaths): Promise<Buffer> {
  const bytes = await readBoundedStudyFile(prepared, "run.json", STUDY_EVIDENCE_LIMITS.sourceBytes);
  if (!bytes) throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
  const verified = await verifyRunPrepared(cwd, path.basename(prepared.physicalRunRoot), prepared);
  if (!verified.ok && verified.recordingOk !== true) throw new Error("ANALYSIS_VERIFY_FAILED");
  const loaded = await loadRunBundlePrepared(cwd, prepared);
  if (!loaded || loaded.bundle.streams.length === 0) throw new Error("ANALYSIS_NO_PARTICIPANTS");
  if (loaded.bundle.mode !== "live") throw new Error("ANALYSIS_REQUIRES_LIVE_RUN");
  const statusBytes = await readBoundedStudyFile(prepared, RUN_STATUS_FILE, 64 * 1024);
  if (!statusBytes) {
    const statusExists = await lstat(path.join(prepared.physicalRunRoot, RUN_STATUS_FILE)).then(() => true, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
    });
    if (statusExists) throw new Error("ANALYSIS_RUN_ACTIVE");
  }
  if (statusBytes) {
    const status: unknown = JSON.parse(statusBytes.toString("utf8"));
    // An old heartbeat is unknown, not proof that a process stopped writing evidence.
    if (!isRunStatusRecord(status) || status.runId !== loaded.bundle.runId || status.state !== "finished") {
      throw new Error("ANALYSIS_RUN_ACTIVE");
    }
  }
  const terminal = new Set(["complete", "passed", "failed", "blocked", "timed_out", "abandoned", "incomplete"]);
  if (loaded.bundle.streams.some((stream) => !terminal.has(stream.status) || stream.liveActor !== undefined)) {
    throw new Error("ANALYSIS_RUN_ACTIVE");
  }
  return bytes;
}

export async function analyzeStudy(cwdInput: string, run: string, options: AnalyzeOptions, deps: AnalyzeDeps = {}): Promise<AnalyzeResult> {
  let cwd = path.resolve(cwdInput);
  const dryRun = options.dryRun === true;
  const config = structuredClone(options.config);
  if (!Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0 || config.maxCostUsd > 1000) return fail(run, dryRun, "ANALYSIS_CONFIG_INVALID");
  if (config.question !== null && containsSensitive(config.question)) return fail(run, dryRun, "ANALYSIS_QUESTION_UNSAFE");
  try {
    const prepared = await resolveStudyAnalysisRun(cwd, run, deps.expectedRun);
    if (!prepared) return fail(run, dryRun, "ANALYSIS_RUN_NOT_FOUND");
    if (deps.expectedRun !== undefined) cwd = path.dirname(path.dirname(prepared.physicalRunsRoot));
    const execute = async (): Promise<AnalyzeResult> => {
      if (deps.signal?.aborted) return fail(run, dryRun, "ANALYSIS_CANCELLED");
      const bytes = await readCompletedStudyAnalysisSource(cwd, prepared);
      const input = await captureStudyEvidence(prepared, bytes);
      if (input.evidence.length === 0) return fail(input.runId, dryRun, "ANALYSIS_NO_PARTICIPANTS");
      const admission = estimateStudyAnalysisAdmission(input, config);
      const base = { schema: ANALYZE_RESULT_SCHEMA as typeof ANALYZE_RESULT_SCHEMA, run: input.runId, dryRun, reused: false, admission, warnings: [] as string[] };
      if (!admission.allowed) return { ...base, ok: false,
        error: { code: admission.error ?? "analysis_admission_denied", message: admission.error === "analysis_budget_exceeded"
          ? "The conservative admission estimate exceeds --max-cost. No provider request was sent."
          : "The analysis input or configuration did not pass admission. No provider request was sent." } };
      if (dryRun) return { ...base, ok: true };
      if (!options.rerun) {
        const prior = (await listStudyAnalyses(prepared)).find((entry) => entry.state === "ready"
          && entry.analysis?.inputDigest === input.inputDigest && entry.analysis.configDigest === hashStudyAnalysisValue(config)
          && entry.analysis.promptVersion === STUDY_ANALYSIS_PROMPT_VERSION)?.analysis;
        if (prior) {
          await validatePreparedRunRootIdentity(prepared);
          return { ...base, ok: prior.error === null, reused: true, analysisId: prior.id, status: prior.status, usage: prior.usage,
            ...(prior.error === null ? {} : { error: { code: prior.error, message: "The saved analysis exceeded its admission estimate. Findings and usage are retained; no new request was sent." } }),
            artifactPath: path.join(prepared.relativeRunRoot, "analysis", prior.id, "analysis.json") };
        }
      }
      // An unreadable inventory is not evidence of an absent prior result.
      // Check readable history capacity before any new paid attempt.
      await assertStudyAnalysisPublicationCapacity(prepared);
      const apiKey = deps.apiKey ?? process.env.OPENAI_API_KEY ?? "";
      if (!apiKey.trim()) return { ...fail(input.runId, false, "ANALYSIS_API_KEY_MISSING"), admission };
      const analysis = await runStudyAnalysis(input, config, { apiKey,
        ...(deps.analysisId === undefined ? {} : { analysisId: deps.analysisId }),
        ...(deps.beforeDispatch === undefined ? {} : { beforeDispatch: deps.beforeDispatch }),
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
        ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }),
        ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
      const result: AnalyzeResult = { ...base, ok: analysis.result !== null && analysis.error === null, analysisId: analysis.id, status: analysis.status,
        usage: analysis.usage,
        ...(analysis.error === null ? {} : { error: { code: analysis.error, message: "The attempt retained its status and any known usage. Inspect it with humanish analyze show." } }) };
      try {
        await writeStudyAnalysisExecutionReceipt(prepared, analysis);
        result.executionReceiptPath = path.join(prepared.relativeRunRoot, "analysis-attempts", analysis.id, "receipt.json");
        await writeStudyAnalysis(prepared, analysis);
        result.artifactPath = path.join(prepared.relativeRunRoot, "analysis", analysis.id, "analysis.json");
      } catch {
        return { ...result, ok: false, error: { code: "ANALYSIS_PUBLICATION_FAILED",
          message: result.executionReceiptPath ? "The attempt's usage was saved, but changed or unsafe evidence prevented report publication."
            : "Storage changed or became unavailable after the attempt. Usage is retained in this response; no durable receipt could be written." } };
      }
      try {
        const rendered = await renderObserver(cwd, input.runId, { open: false });
        if (!rendered.ok) result.warnings.push("Analysis was saved, but Observer could not be refreshed. Run humanish observe again.");
      } catch { result.warnings.push("Analysis was saved, but Observer could not be refreshed. Run humanish observe again."); }
      return result;
    };
    return dryRun ? await execute() : await withStudyAnalysisLock(prepared, execute);
  } catch (error) {
    const code = error instanceof Error && Object.hasOwn(messages, error.message) ? error.message : "ANALYSIS_UNAVAILABLE";
    return fail(run, dryRun, code);
  }
}

export async function showStudyAnalysis(cwd: string, run: string, id?: string): Promise<LoadedStudyAnalysis> {
  const prepared = await resolveRunPath(path.resolve(cwd), run).catch(() => null);
  return prepared ? loadStudyAnalysis(prepared, id)
    : { state: "invalid", analysis: null, corrections: [], warnings: ["ANALYSIS_RUN_NOT_FOUND"] };
}

export async function correctStudyAnalysis(cwd: string, run: string, options: {
  analysisId: string; findingId: string; status: StudyAnalysisCorrection["status"]; reason: string; replacementClaim?: string;
}): Promise<StudyAnalysisCorrection> {
  const prepared = await resolveRunPath(path.resolve(cwd), run);
  if (!prepared) throw new Error("ANALYSIS_RUN_NOT_FOUND");
  return withStudyAnalysisLock(prepared, async () => {
    const loaded = await loadStudyAnalysis(prepared, options.analysisId);
    const analysis = loaded.analysis;
    const finding = analysis?.result?.findings.find((item) => item.id === options.findingId);
    if (loaded.state !== "ready" || !analysis || !finding) throw new Error("ANALYSIS_CORRECTION_SOURCE_UNAVAILABLE");
    if (containsSensitive(options.reason) || containsSensitive(options.replacementClaim ?? "")) throw new Error("ANALYSIS_CORRECTION_TEXT_UNSAFE");
    const correction: StudyAnalysisCorrection = {
      schema: STUDY_ANALYSIS_CORRECTION_SCHEMA, id: `correction-${randomUUID()}`,
      analysisId: analysis.id, analysisSha256: hashStudyAnalysisValue(analysis), findingId: finding.id,
      findingSha256: hashStudyAnalysisValue(finding), createdAt: new Date().toISOString(),
      status: options.status, reason: options.reason, replacementClaim: options.replacementClaim ?? null
    };
    await appendStudyAnalysisCorrection(prepared, correction);
    await renderObserver(cwd, run, { open: false }).catch(() => null);
    return correction;
  });
}
