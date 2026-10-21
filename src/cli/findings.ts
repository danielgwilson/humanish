// A run's analysis findings for `review`, `analyze show` and the end of a live `run`
// (run-findings.ts): the `humanish.analysis-findings.v1` projection, read from the run.
// findings-text.ts prints it. The
// analysis artifact stays the record; this reads the version `analyze show` selects and never
// starts an analysis.

import path from "node:path";
import { costRefusal } from "../analysis/admission.js";
import {
  DEFAULT_ANALYSIS_MAX_COST_USD,
  resolveAutomaticAnalysis,
} from "../analysis/automatic-config.js";
import { ANALYSIS_USUALLY_TAKES } from "../analysis/analysis-limits.js";
import { bySeverity } from "../analysis/finding-lead.js";
import { loadAnalysis } from "../analysis/load.js";
import { projectShareCheckedAnalysis } from "../analysis/sharing.js";
import type { AnalysisArtifact, LoadedAnalysis } from "../analysis/types.js";
import {
  loadRunBundlePrepared,
  readRunJsonIfExists,
  resolveRunPath,
  runJsonValue,
} from "../run/locate.js";
import {
  classifyRunStatus,
  isRunStatusRecord,
  RUN_STATUS_FILE,
  runAnalysisPhase,
  type RunAnalysisPhase,
  type RunStatusRecord,
} from "../run/status.js";
import type { RunBundle } from "../run/bundle.js";
import { TERMINAL_SIMULATION_STATUSES } from "../run/streams.js";
import { formatDuration } from "../run/projection.js";
import { resolvePhysicalCwd, runIdOf } from "../run/paths.js";
import { studyProvenanceOf, type RunStudyProvenance } from "../run/study-provenance.js";
import { resolveStudyManifest } from "../study/discover.js";
import { routeOf } from "../study/routing.js";
import { plural } from "../run/text.js";
import { shellQuote } from "../substrates/shell.js";
import { analysisOutcomeText } from "./io.js";
import { cli } from "./invocation.js";

export const ANALYSIS_FINDINGS_SCHEMA = "humanish.analysis-findings.v1";

type Finding = NonNullable<AnalysisArtifact["result"]>["findings"][number];
type DesignFinding = NonNullable<NonNullable<AnalysisArtifact["result"]>["designFindings"]>[number];

/** `ready` and `stale` carry findings; every other state carries none and says why in `message`. */
type FindingsState =
  | "ready"
  | "stale"
  | "running"
  | "none"
  | "skipped"
  | "failed"
  | "dry_run"
  | "unavailable";

interface CitedEvidence {
  id: string;
  streamId: string;
  kind: string;
  /** Index of the latest retained capture at this item, from 0; null before any capture. */
  frame: number | null;
  /** Time since the first retained capture, not a video offset. */
  elapsedMs: number | null;
  at: string | null;
  /** The capture file relative to the project directory, or null for nonvisual evidence. */
  capture: string | null;
}

interface FindingEvidence extends CitedEvidence {
  /** How the finding's observations used this item: visual, action, participant_statement, inference. */
  bases: string[];
}

interface FindingView {
  id: string;
  /**
   * One plain sentence about what happened, and one to three about what the person tried and what
   * got in the way. Null in analyses written before them. An amended finding keeps the original
   * text here; `correction.replacementClaim` replaces both.
   */
  headline: string | null;
  experience: string | null;
  title: string;
  summary: string;
  impact: Finding["impact"];
  confidence: Finding["confidence"];
  recovery: Finding["recovery"];
  affected: { streamId: string; label: string }[];
  exposedCount: number;
  evidence: FindingEvidence[];
  nextStep: string;
  /** The latest human review note on this finding version (`analyze correct`), or null. */
  correction: {
    status: "confirmed" | "dismissed" | "amended";
    reason: string;
    replacementClaim: string | null;
  } | null;
}

interface DesignFindingView {
  id: string;
  headline: string;
  screen: string;
  notice: string;
  whyItMatters: string;
  suggestion: string;
  severity: DesignFinding["severity"];
  confidence: DesignFinding["confidence"];
  seenBy: { streamId: string; label: string }[];
  /** Each cited item once; at least one has a capture. */
  evidence: CitedEvidence[];
}

export interface AnalysisFindings {
  schema: typeof ANALYSIS_FINDINGS_SCHEMA;
  runId: string;
  state: FindingsState;
  /** The stable code behind a state other than ready, when one is recorded. */
  reason: string | null;
  message: string;
  /**
   * The command that gets findings for this run, or for a dry run the command that starts a live
   * one. Null when none can.
   */
  next: string | null;
  analysisId: string | null;
  status: AnalysisArtifact["status"] | null;
  provider: AnalysisArtifact["provider"] | null;
  model: string | null;
  completedAt: string | null;
  estimatedCostUsd: number | null;
  /** The run directory relative to the project directory; null when the run was not found. */
  runPath: string | null;
  /** analysis.json relative to the project directory. */
  path: string | null;
  summary: string | null;
  /** Highest priority first, as the analysis ranked them. */
  findings: FindingView[];
  /**
   * Problems a designer would see in the captures, most severe first. Null when the view carries
   * no analysis result, or the analysis was written before design findings.
   */
  designFindings: DesignFindingView[] | null;
  limitations: string[];
  warnings: string[];
}

interface FindingsSource {
  runId: string;
  /** The bundle's mode; undefined when run.json could not be read. */
  mode: string | undefined;
  /** The run directory relative to the project directory. */
  runRoot: string;
  loaded: LoadedAnalysis;
  /** ` --cwd <dir>` when the commands this view names need it, or "". */
  cwdFlag: string;
  /**
   * The project-relative path of the run's study file when that file sets `review.analysis:
   * false`, read when the view is built. Undefined when it does not, or cannot be read.
   */
  analysisOffIn?: string;
  /** For a dry run, the study a live run can start from, read when the view is built. */
  liveStudy?: LiveStudy;
  /** The run's study, from its bundle. */
  study?: Pick<RunStudyProvenance, "id" | "path">;
  /** The analyst the run's study gets, read only for an analysis skipped for a missing key. */
  analyst?: Analyst;
  /**
   * Whether Codex is signed in with a ChatGPT account on this machine, read only for an analysis
   * skipped for a missing OpenAI key, whose next step it picks.
   */
  codexSignedIn?: boolean;
  /**
   * Where the run is before its findings, from status.json: its participants still running, or
   * the automatic analysis its own process started. Undefined once neither applies.
   */
  progress?:
    | { stage: "participants" }
    /** The run ended while a participant stream was still running: nothing complete to analyze. */
    | { stage: "cut-off"; running: number; streams: number }
    | {
        stage: "analysis";
        phase: RunAnalysisPhase;
        /** status.json's last heartbeat. */
        updatedAt: string;
        /** The analyst the run's study gets, read only for an analysis whose process stopped. */
        analyst?: Analyst;
      };
  /** When the view was built, for how long an analysis has run. */
  nowMs?: number;
}

/** A study `run` can start live after a dry run. */
interface LiveStudy {
  /** The study argument for `run`: its id, or its path when the run named it by path. */
  run: string;
  /** Its id, for the message. */
  id: string;
  /** The study file to set `mode: live` in first, when the file still starts as a dry run. */
  setLiveIn?: string;
}

/** ` --cwd <dir>`, or "" when `cwd` is the current directory. */
export function cwdFlag(cwd: string): string {
  if (path.resolve(cwd) === process.cwd()) return "";
  return ` --cwd ${/^[\w@%+=:,./-]+$/.test(cwd) ? cwd : shellQuote(cwd)}`;
}

/** An analysis provider and model, as a study or an analysis record names them. */
interface Analyst {
  provider?: string | undefined;
  model?: string;
}

/** The `analyze` command that runs `analyst` on the run; undefined is the OpenAI default. */
function analyzeCommand(source: FindingsSource, analyst: Analyst | undefined): string {
  const run = cli(`analyze --run ${source.runId}${source.cwdFlag}`);
  if (analyst?.provider === "codex") return `${run} --provider codex`;
  const gemini =
    analyst?.provider === "gemini"
      ? ` --provider gemini${analyst.model === undefined ? "" : ` --model ${analyst.model}`}`
      : "";
  return `${run}${gemini} --max-cost ${DEFAULT_ANALYSIS_MAX_COST_USD}`;
}

/** The cited items the analysis evidence resolves, each once, in citation order. */
function citedEvidence(
  ids: Iterable<string>,
  analysis: AnalysisArtifact,
  runRoot: string,
): CitedEvidence[] {
  const byId = new Map(analysis.evidence.map((entry) => [entry.id, entry]));
  return [...new Set(ids)].flatMap((id) => {
    const entry = byId.get(id);
    if (!entry) return [];
    return [
      {
        id,
        streamId: entry.streamId,
        kind: entry.kind,
        frame: entry.frame,
        elapsedMs: entry.elapsedMs,
        at: entry.at,
        capture: entry.capture ? path.join(runRoot, entry.capture.path) : null,
      },
    ];
  });
}

function evidenceOf(finding: Finding, analysis: AnalysisArtifact, runRoot: string) {
  const bases = new Map<string, Set<string>>();
  for (const observation of finding.observations)
    for (const id of observation.evidenceIds) {
      const set = bases.get(id) ?? new Set<string>();
      set.add(observation.basis);
      bases.set(id, set);
    }
  return citedEvidence(bases.keys(), analysis, runRoot).map(
    ({ id, streamId, kind, ...entry }): FindingEvidence => ({
      id,
      streamId,
      kind,
      bases: [...bases.get(id)!],
      ...entry,
    }),
  );
}

/** Most severe first; equal severity keeps the analysis order. */
function designFindingViews(
  analysis: AnalysisArtifact,
  runRoot: string,
): DesignFindingView[] | null {
  const designFindings = analysis.result?.designFindings;
  if (designFindings === undefined) return null;
  const labels = new Map(analysis.participants.map((p) => [p.streamId, p.label]));
  return bySeverity(designFindings).map((finding) => ({
    id: finding.id,
    headline: finding.headline,
    screen: finding.screen,
    notice: finding.notice,
    whyItMatters: finding.whyItMatters,
    suggestion: finding.suggestion,
    severity: finding.severity,
    confidence: finding.confidence,
    seenBy: finding.seenByStreamIds.map((streamId) => ({
      streamId,
      label: labels.get(streamId) ?? streamId,
    })),
    evidence: citedEvidence(finding.evidenceIds, analysis, runRoot),
  }));
}

function findingView(
  finding: Finding,
  loaded: LoadedAnalysis & { analysis: AnalysisArtifact },
  runRoot: string,
): FindingView {
  const labels = new Map(loaded.analysis.participants.map((p) => [p.streamId, p.label]));
  const correction = loaded.corrections.filter((entry) => entry.findingId === finding.id).at(-1);
  return {
    id: finding.id,
    headline: finding.headline ?? null,
    experience: finding.experience ?? null,
    title: finding.title,
    summary: finding.summary,
    impact: finding.impact,
    confidence: finding.confidence,
    recovery: finding.recovery,
    affected: finding.affectedStreamIds.map((streamId) => ({
      streamId,
      label: labels.get(streamId) ?? streamId,
    })),
    exposedCount: finding.exposedStreamIds.length,
    evidence: evidenceOf(finding, loaded.analysis, runRoot),
    nextStep: finding.nextStep,
    correction: correction
      ? {
          status: correction.status,
          reason: correction.reason,
          replacementClaim: correction.replacementClaim,
        }
      : null,
  };
}

/** A view with no findings: what happened and the command that gets them. */
function withoutFindings(
  source: FindingsSource,
  state: FindingsState,
  reason: string | null,
  message: string,
  next: string | null,
): AnalysisFindings {
  return {
    schema: ANALYSIS_FINDINGS_SCHEMA,
    runId: source.runId,
    state,
    reason,
    message,
    next,
    analysisId: null,
    status: null,
    provider: null,
    model: null,
    completedAt: null,
    estimatedCostUsd: null,
    runPath: source.runRoot || null,
    path: null,
    summary: null,
    findings: [],
    designFindings: null,
    limitations: [],
    warnings: source.loaded.warnings,
  };
}

/** A dry run's view: nothing to analyze, and the command that starts a live run. */
function dryRunFindings(source: FindingsSource): AnalysisFindings {
  const opening =
    "This is a dry run: no participant used the product, so there is nothing to analyze.";
  const live = source.liveStudy;
  if (live === undefined)
    return withoutFindings(
      source,
      "dry_run",
      null,
      `${opening} Findings come from live runs. The next command lists this project's studies; a study with mode: live runs participants.`,
      cli(`study list${source.cwdFlag}`),
    );
  const howLive =
    live.setLiveIn === undefined
      ? `the next command runs ${live.id} live.`
      : `set mode: live in ${live.setLiveIn}, then run the next command.`;
  return withoutFindings(
    source,
    "dry_run",
    null,
    `${opening} Findings come from live runs: ${howLive}`,
    cli(`run ${live.run}${source.cwdFlag}`),
  );
}

/**
 * An analysis skipped because OPENAI_API_KEY is not set. With Codex signed in, the next step is the
 * Codex account analyst, named as an opt-in: the study chose the OpenAI analyst, and switching
 * the account that pays for it is the operator's choice.
 */
function missingKeyFindings(source: FindingsSource, reason: string): AnalysisFindings {
  if (source.analyst?.provider === "gemini")
    return withoutFindings(
      source,
      "skipped",
      reason,
      `The automatic analysis was skipped because GEMINI_API_KEY is not set. Set it with ${cli("keys set gemini")}, then run the next command.`,
      analyzeCommand(source, source.analyst),
    );
  const opening = "The automatic analysis was skipped because OPENAI_API_KEY is not set.";
  if (source.codexSignedIn !== true)
    return withoutFindings(
      source,
      "skipped",
      reason,
      `${opening} Set it with ${cli("keys set openai")}, then run the next command.`,
      analyzeCommand(source, undefined),
    );
  const file = source.study?.path === undefined ? "the study file" : source.study.path;
  return withoutFindings(
    source,
    "skipped",
    reason,
    `${opening} Codex is signed in on this machine, so its ChatGPT account can analyze the run instead, sending the evidence to OpenAI under that account. The next command does it once; review.analysis.provider: codex in ${file} makes it this study's analyst.`,
    analyzeCommand(source, { provider: "codex" }),
  );
}

/**
 * The view of a run whose findings are not written yet: participants still running, an analysis
 * running, or an analysis whose process stopped before it finished. Undefined otherwise.
 */
function pendingFindings(
  source: FindingsSource,
  job: LoadedAnalysis["automatic"],
): AnalysisFindings | undefined {
  const again = cli(`review --run ${source.runId}${source.cwdFlag}`);
  const progress = source.progress;
  if (progress?.stage === "participants" && job === undefined)
    return withoutFindings(
      source,
      "running",
      null,
      source.analysisOffIn === undefined
        ? "Participants are still running in this run, so no analysis has started. Automatic analysis starts when they finish, and the findings follow it."
        : "Participants are still running in this run. Analysis is turned off in its study, so none starts when they finish.",
      again,
    );
  if (progress?.stage === "cut-off" && job === undefined)
    return withoutFindings(
      source,
      "skipped",
      "ANALYSIS_RUN_INCOMPLETE",
      `This run ended while ${progress.running} of ${progress.streams} participant streams were still running, so its recording is incomplete and no analysis ran. Run the study again with the next command.`,
      cli(`run ${source.study?.id ?? "<study>"}${source.cwdFlag}`),
    );
  const phase = progress?.stage === "analysis" ? progress.phase : undefined;
  const jobPending = job?.state === "queued" || job?.state === "running";
  if (jobPending || (job === undefined && phase?.state === "running")) {
    const since =
      phase === undefined
        ? ""
        : ` It started at ${phase.startedAt}, ${formatDuration(Math.max(0, (source.nowMs ?? Date.now()) - Date.parse(phase.startedAt)))} ago.`;
    return withoutFindings(
      source,
      "running",
      null,
      `The automatic analysis is running.${since} Findings usually take ${ANALYSIS_USUALLY_TAKES}; check again then.`,
      again,
    );
  }
  const stopped =
    (job?.state === "unknown" && job.reason === "AUTOMATIC_ANALYSIS_STOPPED") ||
    (job === undefined && phase?.state === "stopped");
  if (!stopped) return undefined;
  const at = job?.updatedAt ?? (progress?.stage === "analysis" ? progress.updatedAt : undefined);
  return withoutFindings(
    source,
    "failed",
    "AUTOMATIC_ANALYSIS_STOPPED",
    `The automatic analysis stopped before it wrote findings: the process running it stopped updating its record${at === undefined ? "" : ` at ${at}`}, most likely because it ended. Analyze the run again with the next command.`,
    analyzeCommand(source, progress?.stage === "analysis" ? progress.analyst : undefined),
  );
}

/**
 * A run that ended, by a signal, a process that left without publishing, or a heartbeat that
 * stopped, while some participant stream was still running. Undefined for any other run.
 */
function cutOff(
  bundle: Pick<RunBundle, "outcome" | "streams"> | undefined,
  record: RunStatusRecord | null,
  nowMs: number,
): { stage: "cut-off"; running: number; streams: number } | undefined {
  if (bundle === undefined || bundle.outcome?.state === "finished") return undefined;
  if (
    bundle.outcome === undefined &&
    (record === null || classifyRunStatus(record, nowMs) !== "interrupted")
  )
    return undefined;
  const running = bundle.streams.filter(
    (stream) => !TERMINAL_SIMULATION_STATUSES.has(stream.status) || stream.liveActor !== undefined,
  ).length;
  return running === 0 ? undefined : { stage: "cut-off", running, streams: bundle.streams.length };
}

/** The analyst the run's study gets, when its file still names the same study. */
async function studyAnalyst(
  cwd: string,
  study: RunStudyProvenance | undefined,
): Promise<Analyst | undefined> {
  if (study?.path === undefined) return undefined;
  const resolved = await resolveStudyManifest(cwd, study.path).catch(() => null);
  if (!resolved?.ok || resolved.config.id !== study.id) return undefined;
  const analysis = resolveAutomaticAnalysis(
    resolved.config.review?.analysis,
    resolved.config.actor,
  );
  return analysis.ok && analysis.config !== undefined
    ? { provider: analysis.config.provider, model: analysis.config.model }
    : undefined;
}

/** The findings view of a run's selected analysis, or why it has none. */
export function analysisFindings(source: FindingsSource): AnalysisFindings {
  if (source.mode !== undefined && source.mode !== "live") return dryRunFindings(source);
  const loaded = projectShareCheckedAnalysis(source.loaded);
  const analysis = loaded.analysis;
  if (analysis?.result && (loaded.state === "ready" || loaded.state === "stale")) {
    const result = analysis.result;
    const stale = loaded.state === "stale";
    return {
      schema: ANALYSIS_FINDINGS_SCHEMA,
      runId: source.runId,
      state: loaded.state,
      reason: stale ? (loaded.warnings[0] ?? null) : null,
      message: stale
        ? `The run's evidence changed after analysis ${analysis.id}, so its findings may not match the run.`
        : `Analysis ${analysis.id} is ${analysis.status}, with ${plural(result.findings.length, "finding")}.`,
      next: stale
        ? analyzeCommand(source, { provider: analysis.provider, model: analysis.config.model })
        : null,
      analysisId: analysis.id,
      status: analysis.status,
      provider: analysis.provider,
      model: analysis.config.model,
      completedAt: analysis.completedAt,
      estimatedCostUsd: analysis.usage.estimatedCostUsd,
      runPath: source.runRoot,
      path: path.join(source.runRoot, "analysis", analysis.id, "analysis.json"),
      summary: result.summary,
      findings: result.findings.map((finding) =>
        findingView(finding, { ...loaded, analysis }, source.runRoot),
      ),
      designFindings: designFindingViews(analysis, source.runRoot),
      limitations: result.limitations,
      warnings: loaded.warnings,
    };
  }
  if (loaded.warnings.includes("ANALYSIS_SENSITIVE_TEXT_QUARANTINED"))
    return withoutFindings(
      source,
      "unavailable",
      "ANALYSIS_SENSITIVE_TEXT_QUARANTINED",
      `The analysis text matched a sensitive-text pattern, so it is not printed. ${cli(`analyze show --run ${source.runId}${source.cwdFlag} --json`)} prints the raw record.`,
      null,
    );
  const job = loaded.automatic;
  const pending = pendingFindings(source, job);
  if (pending !== undefined) return pending;
  if (analysis && analysis.result === null)
    return withoutFindings(
      source,
      "failed",
      analysis.error,
      `Analysis attempt ${analysis.id} ${analysis.status === "cancelled" ? "was cancelled" : "failed"}${analysis.error ? ` (${analysis.error})` : ""} and left no findings.`,
      analyzeCommand(source, { provider: analysis.provider, model: analysis.config.model }),
    );
  if (job?.state === "failed" || job?.state === "cancelled") {
    const outcome = analysisOutcomeText(job);
    return withoutFindings(
      source,
      "failed",
      job.reason,
      `The automatic analysis ${outcome.startsWith("failed") ? "" : "was "}${outcome}.`,
      analyzeCommand(
        source,
        job.reason === "AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE" ? { provider: "codex" } : undefined,
      ),
    );
  }
  if (job?.state === "skipped" && job.admission) {
    const refusal = costRefusal(job.admission, `--run ${source.runId}${source.cwdFlag}`, cli);
    return withoutFindings(
      source,
      "skipped",
      job.reason,
      `The automatic analysis was refused before it started. ${refusal.text}`,
      refusal.command,
    );
  }
  if (job?.state === "skipped" && job.reason === "AUTOMATIC_ANALYSIS_KEY_MISSING")
    return missingKeyFindings(source, job.reason);
  if (job?.state === "skipped") {
    const refused = job.reason === "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED";
    return withoutFindings(
      source,
      "skipped",
      job.reason,
      `The automatic analysis was ${analysisOutcomeText(job)}.${refused ? " The dry run says why, and for a cost refusal names the --max-cost that admits it." : ""}`,
      job.reason === "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE"
        ? null
        : `${analyzeCommand(source, undefined)}${refused ? " --dry-run" : ""}`,
    );
  }
  if (job !== undefined || loaded.state === "invalid")
    return withoutFindings(
      source,
      "unavailable",
      job?.reason ?? loaded.warnings[0] ?? null,
      "This run's analysis records could not be read or checked, so no findings are shown.",
      cli(`analyze list --run ${source.runId}${source.cwdFlag}`),
    );
  if (source.analysisOffIn !== undefined)
    return withoutFindings(
      source,
      "skipped",
      "AUTOMATIC_ANALYSIS_DISABLED",
      `Analysis is turned off in this run's study (review.analysis: false in ${source.analysisOffIn}), so none ran after the run. To analyze this run anyway, run the next command.`,
      analyzeCommand(source, undefined),
    );
  return withoutFindings(
    source,
    "none",
    null,
    "No analysis has run for this run.",
    analyzeCommand(source, undefined),
  );
}

/**
 * The run's study file, project-relative, when it still names the same study and sets
 * `review.analysis: false`. A study that turns analysis off leaves no analysis record, so the file
 * is the only place that says why a live run has none.
 */
async function studyAnalysisOff(
  cwd: string,
  study: RunStudyProvenance | undefined,
): Promise<string | undefined> {
  if (study?.path === undefined) return undefined;
  const resolved = await resolveStudyManifest(cwd, study.path).catch(() => null);
  if (!resolved?.ok || resolved.config.id !== study.id) return undefined;
  return resolved.config.review?.analysis === false ? study.path : undefined;
}

/**
 * The study a live run can start from after a dry run: the run's own study when its file runs
 * live, else the starter study try-live when this project has one that runs live, else the run's
 * own study once its file is set live. A preview study only dry-runs. Undefined when none applies.
 */
async function liveStudyAfterDryRun(
  cwd: string,
  study: RunStudyProvenance | undefined,
): Promise<LiveStudy | undefined> {
  const resolve = async (ref: string) => {
    const resolved = await resolveStudyManifest(cwd, ref).catch(() => null);
    return resolved?.ok ? resolved.config : undefined;
  };
  const ownConfig =
    study === undefined
      ? undefined
      : await resolve(study.path ?? study.id).then((config) =>
          config?.id === study.id ? config : undefined,
        );
  const own =
    study === undefined
      ? undefined
      : { run: study.origin === "explicit" ? (study.path ?? study.id) : study.id, id: study.id };
  if (own !== undefined && ownConfig?.mode === "live") return own;
  if ((await resolve("try-live"))?.mode === "live") return { run: "try-live", id: "try-live" };
  if (own !== undefined && ownConfig !== undefined && study?.path !== undefined)
    return routeOf(ownConfig) === "preview" ? undefined : { ...own, setLiveIn: study.path };
  return undefined;
}

/**
 * The run's bundle mode and its selected analysis: `analysisId`, or the version `analyze show`
 * defaults to. Null when the run is missing or its storage is unsafe.
 */
export async function readRunAnalysis(
  cwd: string,
  run: string,
  analysisId?: string,
  deps: FindingsDeps = {},
): Promise<FindingsSource | null> {
  const physical = await resolvePhysicalCwd(cwd);
  const prepared = await resolveRunPath(physical, run).catch(() => null);
  if (!prepared) return null;
  const bundle = await loadRunBundlePrepared(physical, prepared).catch(() => null);
  const mode = bundle?.bundle.mode;
  const study = bundle === null ? undefined : studyProvenanceOf(bundle.bundle);
  const analysisOffIn = mode === "live" ? await studyAnalysisOff(physical, study) : undefined;
  const liveStudy =
    mode !== undefined && mode !== "live" ? await liveStudyAfterDryRun(physical, study) : undefined;
  const loaded = await loadAnalysis(prepared, analysisId);
  const nowMs = Date.now();
  const status = runJsonValue(await readRunJsonIfExists(prepared, RUN_STATUS_FILE));
  const record = isRunStatusRecord(status) && status.runId === runIdOf(prepared) ? status : null;
  const phase = record === null ? undefined : runAnalysisPhase(record, nowMs);
  const stopped =
    phase?.state === "stopped" || loaded.automatic?.reason === "AUTOMATIC_ANALYSIS_STOPPED";
  const keyMissing = loaded.automatic?.reason === "AUTOMATIC_ANALYSIS_KEY_MISSING";
  const analyst = stopped || keyMissing ? await studyAnalyst(physical, study) : undefined;
  const progress =
    phase !== undefined && record !== null
      ? {
          stage: "analysis" as const,
          phase,
          updatedAt: record.updatedAt,
          ...(analyst === undefined ? {} : { analyst }),
        }
      : bundle?.bundle.outcome === undefined &&
          record !== null &&
          classifyRunStatus(record, nowMs) === "running"
        ? { stage: "participants" as const }
        : cutOff(bundle?.bundle, record, nowMs);
  const codexSignedIn =
    keyMissing && analyst?.provider !== "gemini"
      ? await (deps.codexSignedIn ?? codexSignedInHere)().catch(() => false)
      : undefined;
  return {
    runId: runIdOf(prepared),
    mode,
    runRoot: prepared.relativeRunRoot,
    loaded,
    cwdFlag: cwdFlag(cwd),
    ...(analysisOffIn === undefined ? {} : { analysisOffIn }),
    ...(liveStudy === undefined ? {} : { liveStudy }),
    ...(study === undefined
      ? {}
      : { study: { id: study.id, ...(study.path === undefined ? {} : { path: study.path }) } }),
    ...(codexSignedIn === undefined ? {} : { codexSignedIn }),
    ...(keyMissing && analyst !== undefined ? { analyst } : {}),
    ...(progress === undefined ? {} : { progress }),
    nowMs,
  };
}

/** What reading a run's findings needs from this machine; tests replace it. */
export interface FindingsDeps {
  /** Whether Codex is signed in with a ChatGPT account. */
  codexSignedIn?: () => Promise<boolean>;
}

async function codexSignedInHere(): Promise<boolean> {
  const { detectLocalAgents } = await import("../actors/local-agent/cli.js");
  const agents = await detectLocalAgents({ only: "codex" });
  // The Codex analyst refuses an API-key login, so only a ChatGPT login counts.
  return agents.some(
    (agent) => agent.authStatus === "authenticated" && agent.billing === "account-unknown",
  );
}

/** The view of a run that could not be found. */
export function missingRunFindings(cwd: string, run: string): AnalysisFindings {
  const loaded: LoadedAnalysis = {
    state: "invalid",
    analysis: null,
    corrections: [],
    warnings: ["ANALYSIS_RUN_NOT_FOUND"],
  };
  const flag = cwdFlag(cwd);
  return withoutFindings(
    { runId: run, mode: undefined, runRoot: "", loaded, cwdFlag: flag },
    "unavailable",
    "ANALYSIS_RUN_NOT_FOUND",
    `Run ${run} was not found or its storage is unsafe.`,
    cli(`runs${flag}`),
  );
}

/** The findings of a run's selected analysis, or why it has none. */
export async function readRunFindings(
  cwd: string,
  run: string,
  analysisId?: string,
  deps: FindingsDeps = {},
): Promise<AnalysisFindings> {
  const source = await readRunAnalysis(cwd, run, analysisId, deps);
  return source ? analysisFindings(source) : missingRunFindings(cwd, run);
}
