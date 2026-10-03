import {
  defaultCodexCliVersion,
  describeCodexCliAdmission,
} from "../actors/codex/codex-admission.js";
import { validCodexAnalysisConfig } from "./codex-config.js";
import type { AnalysisFetch, AnalysisProvider } from "./provider.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";
import { renderObserver } from "../observer/render.js";
import { containsSensitive } from "../evidence/redaction.js";
import { verifyRunPrepared } from "../verify/verify.js";
import { loadRunBundlePrepared, resolveRunPath } from "../run/locate.js";
import {
  physicalCwdOf,
  runIdOf,
  resolvePhysicalCwd,
  validatePreparedRunRootIdentity,
  type PreparedRunArtifactPaths,
} from "../run/paths.js";
import { isRunStatusRecord, RUN_STATUS_FILE } from "../run/status.js";
import { captureEvidence, EVIDENCE_LIMITS } from "./evidence.js";
import { pathMissing, readBoundedFile } from "../run/evidence-files.js";
import {
  estimateAnalysisAdmission,
  preferLargerAnalysisOutput,
  runAnalysis,
  ANALYSIS_PROMPT_VERSION,
  type AnalysisAdmission,
  type AnalysisProgress,
  type AnalysisDispatchContext,
} from "./execute.js";
import {
  appendAnalysisCorrection,
  assertAnalysisPublicationCapacity,
  listAnalyses,
  writeAnalysis,
} from "./store.js";
import { beginAnalysisExecution, writeAnalysisExecutionReceipt } from "./store-executions.js";
import { keepRejectedAnalysisOutput, type RejectedAnalysisOutput } from "./diagnostics.js";
import { loadAnalysis } from "./load.js";
import { hashAnalysisValue } from "./validation.js";
import {
  ANALYSIS_CORRECTION_SCHEMA,
  type AnalysisArtifact,
  type AnalysisConfig,
  type AnalysisCorrection,
  type AnalysisInput,
  type LoadedAnalysis,
} from "./types.js";
import { RUN_BUNDLE_FILE } from "../run/bundle.js";
import { TERMINAL_SIMULATION_STATUSES } from "../run/streams.js";

const ANALYZE_RESULT_SCHEMA = "humanish.analyze-result.v1";
const MAX_STATUS_BYTES = 64 * 1024;
export interface AnalyzeOptions {
  config: AnalysisConfig;
  dryRun?: boolean;
  rerun?: boolean;
  /** Set when the output limit was defaulted; an explicit limit is always used exactly. */
  preferLargerOutput?: boolean;
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
  /** A rejected response kept for local diagnosis, outside the run directory. */
  rejectedOutputPath?: string;
  status?: AnalysisArtifact["status"];
  usage?: AnalysisArtifact["usage"];
  admission?: AnalysisAdmission;
  warnings: string[];
  error?: { code: string; message: string };
}
export interface AnalyzeDeps {
  apiKey?: string;
  /** Test hook for the Codex provider call; evidence, source identity and publication still run. */
  codexProvider?: AnalysisProvider;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
  /** Request boundary only: evidence capture, admission, validation and writes remain real. */
  fetch?: AnalysisFetch;
  /** Set by automatic analysis: analyze this prepared run instead of resolving `run` again. */
  expectedRun?: PreparedRunArtifactPaths;
  /** Set by automatic analysis to its job attempt id; never from an Observer request. */
  analysisId?: string;
  beforeDispatch?: (context: AnalysisDispatchContext) => Promise<void>;
  /** Internal seam: the installed Codex CLI release, or null when it is unavailable or unqualified. */
  detectCodexCliVersion?: () => Promise<string | null>;
  /** Internal: the caller already recorded the detected release in config.identity. */
  codexCliVersionBound?: boolean;
}

/** A producer pin is authority for one physical project and exact run ID only. */
export async function resolveAnalysisRun(
  cwd: string,
  run: string,
  expectedRun?: PreparedRunArtifactPaths,
): Promise<PreparedRunArtifactPaths | null> {
  if (expectedRun === undefined) return resolveRunPath(cwd, run);
  const physicalCwd = physicalCwdOf(expectedRun);
  const selectedCwd = await realpath(cwd).catch(() => null);
  if (selectedCwd !== physicalCwd || run !== runIdOf(expectedRun))
    throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
  try {
    await validatePreparedRunRootIdentity(expectedRun);
  } catch {
    throw new Error("ANALYSIS_SOURCE_CHANGED");
  }
  return expectedRun;
}

const messages: Record<string, string> = {
  ANALYSIS_RUN_NOT_FOUND: "The selected run is unavailable or its storage is unsafe.",
  ANALYSIS_VERIFY_FAILED: "The run must pass verification before analysis.",
  ANALYSIS_RUN_ACTIVE: "Analysis requires a completed recording. Wait for the study to finish.",
  ANALYSIS_NO_PARTICIPANTS: "This run contains no participant evidence to analyze.",
  ANALYSIS_REQUIRES_LIVE_RUN:
    "A dry run has no participant behavior to analyze. Select a completed live run.",
  ANALYSIS_SOURCE_UNAVAILABLE:
    "The source recording is missing, unsafe, or exceeds the input limit.",
  ANALYSIS_SOURCE_CHANGED:
    "The source recording changed during analysis. The result cannot be published against different evidence.",
  ANALYSIS_BUSY:
    "Another analysis holds this run's .analysis-lock directory. If it was interrupted, confirm it has stopped before removing that empty directory.",
  ANALYSIS_HISTORY_UNAVAILABLE:
    "Analysis history is unavailable or full. No request was sent. Inspect this run's analysis and analysis-attempts storage before retrying.",
  ANALYSIS_CONFIG_INVALID:
    "OpenAI analysis needs a supported model, positive USD admission limit and 256–32768 output tokens. Codex account analysis uses its qualified model and null dollar/output-token caps. Both require timeout 1–600000 ms.",
  ANALYSIS_QUESTION_UNSAFE:
    "The reviewer question matched a sensitive-text pattern. Remove sensitive details before retrying.",
  ANALYSIS_API_KEY_MISSING:
    "Set OPENAI_API_KEY to run analysis. --dry-run checks admission without a key or provider request.",
  ANALYSIS_CANCELLED: "Analysis was cancelled before dispatch.",
  ANALYSIS_UNAVAILABLE: "Analysis could not be completed safely. Source evidence was not changed.",
};
const codexRecovery: Record<string, string> = {
  analysis_codex_busy:
    "Another restricted Codex analyst or setup check is active in this process. Wait for it to finish, then explicitly retry.",
  analysis_codex_unavailable: `The Codex CLI is unavailable. Install one (${describeCodexCliAdmission()}) and sign in with a ChatGPT account, then retry --provider codex.`,
  analysis_codex_unsupported_version: `This Codex CLI release is refused: ${describeCodexCliAdmission()}. \`humanish doctor\` names the release it found, why, and the command that replaces it.`,
  analysis_codex_incompatible_release: `This Codex CLI release changed app-server protocol fields humanish reads, so no request was sent; the warnings name each change. Install the last tested release (${defaultCodexCliVersion()}), then retry.`,
  analysis_codex_unsupported_platform:
    "This platform has not qualified the restricted Codex account launcher.",
  analysis_codex_login_required:
    "Sign in to Codex with a ChatGPT account, then retry humanish analyze --provider codex --rerun.",
  analysis_codex_unsupported_auth:
    "Codex analysis requires ChatGPT account authentication; API-key and custom provider authentication are not used as fallbacks.",
  analysis_codex_unsafe_configuration:
    "Codex analysis could not establish the required isolated configuration. Inspect your supported CLI/login setup before retrying.",
  analysis_codex_model_unavailable:
    "The qualified model could not be confirmed for this account. No alternate model or API provider was selected.",
  analysis_codex_protocol_error:
    "The Codex response did not match the qualified protocol. The attempt and known usage were retained.",
  analysis_codex_tool_call:
    "The analyst attempted an unsupported interaction; the report was refused.",
  analysis_codex_process_failed:
    "The Codex analyst process ended without a usable report. Inspect the retained attempt before retrying.",
  analysis_codex_cleanup_failed:
    "Codex analyst cleanup could not be confirmed. Inspect private codex-analysis-recovery markers in your user cache and humanish-codex-analysis-* directories in your system temp directory. Preserve any retained login state and run codex login before retrying.",
};
const fail = (run: string, dryRun: boolean, code: string): AnalyzeResult => ({
  schema: ANALYZE_RESULT_SCHEMA,
  ok: false,
  run,
  dryRun,
  reused: false,
  warnings: [],
  error: { code, message: messages[code] ?? messages.ANALYSIS_UNAVAILABLE! },
});

/**
 * A dry-run bundle cannot be analyzed under any configuration, so this refusal is checked before
 * the configuration. Every other run problem (missing, unverified, still active) is left to the
 * full completion gate, which runs after the configuration checks.
 */
export async function dryRunBundleRefusal(
  cwd: string,
  run: string,
  dryRun: boolean,
  expectedRun?: PreparedRunArtifactPaths,
): Promise<AnalyzeResult | null> {
  try {
    const prepared = await resolveAnalysisRun(cwd, run, expectedRun);
    const loaded = prepared ? await loadRunBundlePrepared(cwd, prepared) : null;
    return loaded !== null && loaded.bundle.mode !== "live"
      ? fail(run, dryRun, "ANALYSIS_REQUIRES_LIVE_RUN")
      : null;
  } catch {
    return null;
  }
}

/** Re-render the run's Observer after an analysis write. False when it could not be refreshed. */
export async function refreshObserver(
  cwd: string,
  runId: string,
  prepared: PreparedRunArtifactPaths,
): Promise<boolean> {
  try {
    return (await renderObserver(cwd, runId, { open: false, expectedRun: prepared })).ok;
  } catch {
    return false;
  }
}

/** One analysis or correction writer per run. Never steal a lock based on an untrusted PID. */
export async function withAnalysisLock<T>(
  prepared: PreparedRunArtifactPaths,
  action: () => Promise<T>,
): Promise<T> {
  await validatePreparedRunRootIdentity(prepared);
  const target = path.join(prepared.physicalRunRoot, ".analysis-lock");
  try {
    await mkdir(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("ANALYSIS_BUSY");
    throw new Error("ANALYSIS_UNAVAILABLE");
  }
  const identity = await lstat(target, { bigint: true });
  try {
    await validatePreparedRunRootIdentity(prepared);
    if (!identity.isDirectory() || identity.isSymbolicLink())
      throw new Error("ANALYSIS_UNAVAILABLE");
    return await action();
  } finally {
    // Only remove our empty, unchanged directory. No recursive deletion and no replacement authority.
    try {
      await validatePreparedRunRootIdentity(prepared);
      const current = await lstat(target, { bigint: true });
      if (
        current.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === identity.dev &&
        current.ino === identity.ino &&
        current.birthtimeNs === identity.birthtimeNs
      )
        await rmdir(target);
    } catch {
      /* Leave ambiguous storage in place for explicit operator inspection. */
    }
  }
}

/** The completion gate: the run verifies, is live and finished, and has participants. */
export async function readCompletedAnalysisSource(
  cwd: string,
  prepared: PreparedRunArtifactPaths,
): Promise<Buffer> {
  const bytes = await readBoundedFile(prepared, RUN_BUNDLE_FILE, EVIDENCE_LIMITS.sourceBytes);
  if (!bytes) throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
  const verified = await verifyRunPrepared(cwd, runIdOf(prepared), prepared);
  if (!verified.ok && verified.recordingOk !== true) throw new Error("ANALYSIS_VERIFY_FAILED");
  const loaded = await loadRunBundlePrepared(cwd, prepared);
  if (!loaded || loaded.bundle.streams.length === 0) throw new Error("ANALYSIS_NO_PARTICIPANTS");
  if (loaded.bundle.mode !== "live") throw new Error("ANALYSIS_REQUIRES_LIVE_RUN");
  const statusBytes = await readBoundedFile(prepared, RUN_STATUS_FILE, MAX_STATUS_BYTES);
  if (!statusBytes) {
    const missing = await pathMissing(path.join(prepared.physicalRunRoot, RUN_STATUS_FILE)).catch(
      (): never => {
        throw new Error("ANALYSIS_SOURCE_UNAVAILABLE");
      },
    );
    if (!missing) throw new Error("ANALYSIS_RUN_ACTIVE");
  }
  if (statusBytes) {
    const status: unknown = JSON.parse(statusBytes.toString("utf8"));
    // An old heartbeat is unknown, not proof that a process stopped writing evidence.
    if (
      !isRunStatusRecord(status) ||
      status.runId !== loaded.bundle.runId ||
      status.state !== "finished"
    ) {
      throw new Error("ANALYSIS_RUN_ACTIVE");
    }
  }
  if (
    loaded.bundle.streams.some(
      (stream) =>
        !TERMINAL_SIMULATION_STATUSES.has(stream.status) || stream.liveActor !== undefined,
    )
  ) {
    throw new Error("ANALYSIS_RUN_ACTIVE");
  }
  return bytes;
}

/** The refusal code for a configuration analyzeRun cannot run, before any run file is read. */
function analyzeConfigRefusal(config: AnalysisConfig): string | null {
  if (
    config.provider === "codex"
      ? !validCodexAnalysisConfig(config)
      : !Number.isFinite(config.maxCostUsd) || config.maxCostUsd <= 0 || config.maxCostUsd > 1000
  )
    return "ANALYSIS_CONFIG_INVALID";
  if (config.question !== null && containsSensitive(config.question))
    return "ANALYSIS_QUESTION_UNSAFE";
  return null;
}

/** The fields every result of an admitted attempt carries. */
type AnalyzeBase = Omit<AnalyzeResult, "ok"> & { admission: AnalysisAdmission };

/** The result when admission refuses the attempt, or when a dry run stops after admission. */
function admissionOnlyResult(base: AnalyzeBase, config: AnalysisConfig): AnalyzeResult {
  if (!base.admission.allowed)
    return {
      ...base,
      ok: false,
      error: {
        code: base.admission.error ?? "analysis_admission_denied",
        message:
          base.admission.error === "analysis_budget_exceeded"
            ? "The conservative admission estimate exceeds --max-cost. No provider request was sent."
            : "The analysis input or configuration did not pass admission. No provider request was sent.",
      },
    };
  return {
    ...base,
    ok: true,
    warnings:
      config.provider === "codex"
        ? [
            "Evidence and configuration admission only. Codex CLI, login, model access and account allowance were not checked; no provider request was sent.",
          ]
        : base.warnings,
  };
}

/** A saved ready analysis of the same input, config and prompt, returned without a new request. */
async function reusedAnalysisResult(
  prepared: PreparedRunArtifactPaths,
  input: AnalysisInput,
  config: AnalysisConfig,
  base: AnalyzeBase,
): Promise<AnalyzeResult | undefined> {
  const prior = (await listAnalyses(prepared)).find(
    (entry) =>
      entry.state === "ready" &&
      entry.analysis?.inputDigest === input.inputDigest &&
      entry.analysis.configDigest === hashAnalysisValue(config) &&
      entry.analysis.promptVersion === ANALYSIS_PROMPT_VERSION,
  )?.analysis;
  if (!prior) return undefined;
  await validatePreparedRunRootIdentity(prepared);
  return {
    ...base,
    ok: prior.error === null,
    reused: true,
    analysisId: prior.id,
    status: prior.status,
    usage: prior.usage,
    ...(prior.error === null
      ? {}
      : {
          error: {
            code: prior.error,
            message:
              "The saved analysis exceeded its admission estimate. Findings and usage are retained; no new request was sent.",
          },
        }),
    artifactPath: path.join(prepared.relativeRunRoot, "analysis", prior.id, "analysis.json"),
  };
}

/** The caller's view of a finished attempt, before publication. */
function attemptResult(base: AnalyzeBase, analysis: AnalysisArtifact): AnalyzeResult {
  return {
    ...base,
    ok: analysis.result !== null && analysis.error === null,
    analysisId: analysis.id,
    status: analysis.status,
    usage: analysis.usage,
    ...(analysis.error === null
      ? {}
      : {
          error: {
            code: analysis.error,
            message:
              codexRecovery[analysis.error] ??
              "The attempt retained its status and any known usage. Inspect it with humanish analyze show.",
          },
        }),
  };
}

/** Write the receipt, then the report, recording each path on the result; false if either fails. */
async function publishAttempt(
  prepared: PreparedRunArtifactPaths,
  analysis: AnalysisArtifact,
  result: AnalyzeResult,
  finalizeExecution: ((value: AnalysisArtifact) => Promise<void>) | undefined,
): Promise<boolean> {
  try {
    if (finalizeExecution) await finalizeExecution(analysis);
    else await writeAnalysisExecutionReceipt(prepared, analysis);
    result.executionReceiptPath = path.join(
      prepared.relativeRunRoot,
      "analysis-attempts",
      analysis.id,
      "receipt.json",
    );
    await writeAnalysis(prepared, analysis);
    result.artifactPath = path.join(
      prepared.relativeRunRoot,
      "analysis",
      analysis.id,
      "analysis.json",
    );
    return true;
  } catch {
    return false;
  }
}

interface AnalyzeAttempt {
  cwd: string;
  run: string;
  prepared: PreparedRunArtifactPaths;
  config: AnalysisConfig;
  options: AnalyzeOptions;
  deps: AnalyzeDeps;
  dryRun: boolean;
}

/** One attempt, under the run's analysis lock unless it is a dry run. */
async function executeAnalysis(attempt: AnalyzeAttempt): Promise<AnalyzeResult> {
  const { cwd, run, prepared, options, deps, dryRun } = attempt;
  let config = attempt.config;
  if (deps.signal?.aborted) return fail(run, dryRun, "ANALYSIS_CANCELLED");
  const bytes = await readCompletedAnalysisSource(cwd, prepared);
  const input = await captureEvidence(prepared, bytes);
  if (input.evidence.length === 0) return fail(input.runId, dryRun, "ANALYSIS_NO_PARTICIPANTS");
  if (options.preferLargerOutput) config = preferLargerAnalysisOutput(input, config);
  const admission = estimateAnalysisAdmission(input, config);
  const base: AnalyzeBase = {
    schema: ANALYZE_RESULT_SCHEMA as typeof ANALYZE_RESULT_SCHEMA,
    run: input.runId,
    dryRun,
    reused: false,
    admission,
    warnings: [] as string[],
  };
  if (!admission.allowed || dryRun) return admissionOnlyResult(base, config);
  // The report, its reuse key and the launcher all name the release that will run.
  if (
    config.provider === "codex" &&
    !deps.codexCliVersionBound &&
    (deps.detectCodexCliVersion || !deps.codexProvider)
  )
    config = await (
      await import("./restricted-codex.js")
    ).bindCodexAnalysisCliVersion(config, deps.detectCodexCliVersion);
  if (!options.rerun) {
    const reused = await reusedAnalysisResult(prepared, input, config, base);
    if (reused) return reused;
  }
  // An unreadable inventory is not evidence of an absent prior result.
  // Check readable history capacity before any new paid attempt.
  await assertAnalysisPublicationCapacity(prepared);
  const apiKey =
    config.provider === "codex" ? "" : (deps.apiKey ?? process.env.OPENAI_API_KEY ?? "");
  if (config.provider !== "codex" && !apiKey.trim())
    return { ...fail(input.runId, false, "ANALYSIS_API_KEY_MISSING"), admission };
  let finalizeExecution: ((value: AnalysisArtifact) => Promise<void>) | undefined;
  const rejection: { output?: RejectedAnalysisOutput } = {};
  const analysis = await runAnalysis(input, config, {
    apiKey,
    ...(deps.codexProvider === undefined ? {} : { codexProvider: deps.codexProvider }),
    ...(deps.analysisId === undefined ? {} : { analysisId: deps.analysisId }),
    beforeDispatch: async (context) => {
      await deps.beforeDispatch?.(context);
      finalizeExecution = await beginAnalysisExecution(prepared, context);
    },
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.onProgress === undefined ? {} : { onProgress: deps.onProgress }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    warnings: base.warnings,
    onRejectedOutput: (output) => {
      rejection.output = output;
    },
  });
  const result = attemptResult(base, analysis);
  if (rejection.output)
    try {
      result.rejectedOutputPath = await keepRejectedAnalysisOutput(
        cwd,
        {
          runId: analysis.runId,
          analysisId: analysis.id,
          model: config.model,
          promptVersion: analysis.promptVersion,
        },
        rejection.output,
      );
    } catch {
      result.warnings.push(
        "The rejected analyst output could not be kept under .humanish/analysis-diagnostics.",
      );
    }
  if (!(await publishAttempt(prepared, analysis, result, finalizeExecution)))
    return {
      ...result,
      ok: false,
      error: {
        code: "ANALYSIS_PUBLICATION_FAILED",
        message: result.executionReceiptPath
          ? "The attempt's usage was saved, but changed or unsafe evidence prevented report publication."
          : "Storage changed or became unavailable after the attempt. Usage is retained in this response; no durable receipt could be written.",
      },
    };
  if (!(await refreshObserver(cwd, input.runId, prepared)))
    result.warnings.push(
      "Analysis was saved, but Observer could not be refreshed. Run humanish observe again.",
    );
  return result;
}

export async function analyzeRun(
  cwdInput: string,
  run: string,
  options: AnalyzeOptions,
  deps: AnalyzeDeps = {},
): Promise<AnalyzeResult> {
  let cwd = await resolvePhysicalCwd(cwdInput);
  const dryRun = options.dryRun === true;
  const refusal = await dryRunBundleRefusal(cwd, run, dryRun, deps.expectedRun);
  if (refusal) return refusal;
  const config = structuredClone(options.config);
  const configRefusal = analyzeConfigRefusal(config);
  if (configRefusal) return fail(run, dryRun, configRefusal);
  try {
    const prepared = await resolveAnalysisRun(cwd, run, deps.expectedRun);
    if (!prepared) return fail(run, dryRun, "ANALYSIS_RUN_NOT_FOUND");
    if (deps.expectedRun !== undefined) cwd = physicalCwdOf(prepared);
    const execute = () => executeAnalysis({ cwd, run, prepared, config, options, deps, dryRun });
    return dryRun ? await execute() : await withAnalysisLock(prepared, execute);
  } catch (error) {
    const code =
      error instanceof Error && Object.hasOwn(messages, error.message)
        ? error.message
        : "ANALYSIS_UNAVAILABLE";
    return fail(run, dryRun, code);
  }
}

export async function showAnalysis(cwd: string, run: string, id?: string): Promise<LoadedAnalysis> {
  const prepared = await resolveRunPath(await resolvePhysicalCwd(cwd), run).catch(() => null);
  return prepared
    ? loadAnalysis(prepared, id)
    : { state: "invalid", analysis: null, corrections: [], warnings: ["ANALYSIS_RUN_NOT_FOUND"] };
}

export async function correctAnalysis(
  cwd: string,
  run: string,
  options: {
    analysisId: string;
    findingId: string;
    status: AnalysisCorrection["status"];
    reason: string;
    replacementClaim?: string;
  },
): Promise<AnalysisCorrection> {
  const prepared = await resolveRunPath(await resolvePhysicalCwd(cwd), run);
  if (!prepared) throw new Error("ANALYSIS_RUN_NOT_FOUND");
  return withAnalysisLock(prepared, async () => {
    const loaded = await loadAnalysis(prepared, options.analysisId);
    const analysis = loaded.analysis;
    const finding = analysis?.result?.findings.find((item) => item.id === options.findingId);
    if (loaded.state !== "ready" || !analysis || !finding)
      throw new Error("ANALYSIS_CORRECTION_SOURCE_UNAVAILABLE");
    if (containsSensitive(options.reason) || containsSensitive(options.replacementClaim ?? ""))
      throw new Error("ANALYSIS_CORRECTION_TEXT_UNSAFE");
    const correction: AnalysisCorrection = {
      schema: ANALYSIS_CORRECTION_SCHEMA,
      id: `correction-${randomUUID()}`,
      analysisId: analysis.id,
      analysisSha256: hashAnalysisValue(analysis),
      findingId: finding.id,
      findingSha256: hashAnalysisValue(finding),
      createdAt: new Date().toISOString(),
      status: options.status,
      reason: options.reason,
      replacementClaim: options.replacementClaim ?? null,
    };
    await appendAnalysisCorrection(prepared, correction);
    await refreshObserver(cwd, runIdOf(prepared), prepared);
    return correction;
  });
}
