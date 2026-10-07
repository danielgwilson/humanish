// A run's analysis findings for `review`, `analyze show` and the end of a live `run`: the
// `humanish.analysis-findings.v1` projection and its text. The analysis artifact stays the record;
// this reads the version `analyze show` selects and never starts an analysis.

import path from "node:path";
import type { Command } from "commander";
import { DEFAULT_ANALYSIS_MAX_COST_USD } from "../analysis/automatic-config.js";
import type { AutomaticAnalysisOutcome } from "../analysis/job.js";
import { loadAnalysis } from "../analysis/load.js";
import { projectShareCheckedAnalysis } from "../analysis/sharing.js";
import type { AnalysisArtifact, LoadedAnalysis } from "../analysis/types.js";
import { loadRunBundlePrepared, resolveRunPath } from "../run/locate.js";
import { resolvePhysicalCwd, runIdOf } from "../run/paths.js";
import { studyProvenanceOf, type RunStudyProvenance } from "../run/study-provenance.js";
import { resolveStudyManifest } from "../study/discover.js";
import { routeOf } from "../study/routing.js";
import { plural } from "../run/text.js";
import { shellQuote } from "../substrates/shell.js";
import { analysisOutcomeText, type CliIo, wantsJson } from "./io.js";
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
function cwdFlag(cwd: string): string {
  if (path.resolve(cwd) === process.cwd()) return "";
  return ` --cwd ${/^[\w@%+=:,./-]+$/.test(cwd) ? cwd : shellQuote(cwd)}`;
}

function analyzeCommand(source: FindingsSource, provider: string | undefined): string {
  const run = cli(`analyze --run ${source.runId}${source.cwdFlag}`);
  return provider === "codex"
    ? `${run} --provider codex`
    : `${run} --max-cost ${DEFAULT_ANALYSIS_MAX_COST_USD}`;
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

const SEVERITY_RANK: Record<DesignFinding["severity"], number> = {
  major: 0,
  moderate: 1,
  minor: 2,
};

/** Most severe first; equal severity keeps the analysis order. */
function designFindingViews(
  analysis: AnalysisArtifact,
  runRoot: string,
): DesignFindingView[] | null {
  const designFindings = analysis.result?.designFindings;
  if (designFindings === undefined) return null;
  const labels = new Map(analysis.participants.map((p) => [p.streamId, p.label]));
  return [...designFindings]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map((finding) => ({
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
      next: stale ? analyzeCommand(source, analysis.provider) : null,
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
  if (job?.state === "queued" || job?.state === "running")
    return withoutFindings(
      source,
      "running",
      null,
      "The automatic analysis is still running. Check again when it finishes.",
      cli(`review --run ${source.runId}${source.cwdFlag}`),
    );
  if (analysis && analysis.result === null)
    return withoutFindings(
      source,
      "failed",
      analysis.error,
      `Analysis attempt ${analysis.id} ${analysis.status === "cancelled" ? "was cancelled" : "failed"}${analysis.error ? ` (${analysis.error})` : ""} and left no findings.`,
      analyzeCommand(source, analysis.provider),
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
        job.reason === "AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE" ? "codex" : undefined,
      ),
    );
  }
  if (job?.state === "skipped") {
    const refused = job.reason === "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED";
    return withoutFindings(
      source,
      "skipped",
      job.reason,
      `The automatic analysis was ${analysisOutcomeText(job)}.${refused ? " The dry run prints its cost estimate; run it again with a --max-cost above the estimate." : ""}`,
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
  return {
    runId: runIdOf(prepared),
    mode,
    runRoot: prepared.relativeRunRoot,
    loaded: await loadAnalysis(prepared, analysisId),
    cwdFlag: cwdFlag(cwd),
    ...(analysisOffIn === undefined ? {} : { analysisOffIn }),
    ...(liveStudy === undefined ? {} : { liveStudy }),
  };
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
): Promise<AnalysisFindings> {
  const source = await readRunAnalysis(cwd, run, analysisId);
  return source ? analysisFindings(source) : missingRunFindings(cwd, run);
}

const IMPACT_TEXT: Record<Finding["impact"], string> = {
  blocked_task: "blocked task",
  friction: "friction",
  recovery: "recovery",
  uncertain: "uncertain",
};

const RECOVERY_TEXT: Record<Finding["recovery"], string> = {
  recovered: "recovered",
  not_observed: "no recovery observed",
  unknown: "recovery unknown",
};

/** `+1:05` from milliseconds since the first retained capture. */
function elapsedText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  return hours > 0
    ? `+${hours}:${String(minutes % 60).padStart(2, "0")}:${ss}`
    : `+${minutes}:${ss}`;
}

/** One participant's cited moments: each frame once, at its earliest cited time. */
function momentsText(evidence: FindingEvidence[]): string {
  const frames = new Map<number, number | null>();
  let unframed = 0;
  for (const entry of evidence) {
    if (entry.frame === null) {
      unframed++;
      continue;
    }
    const earlier = frames.get(entry.frame);
    if (
      earlier === undefined ||
      (entry.elapsedMs !== null && (earlier ?? Infinity) > entry.elapsedMs)
    )
      frames.set(entry.frame, entry.elapsedMs);
  }
  const parts = [...frames]
    .sort(([a], [b]) => a - b)
    .map(([frame, ms]) => `frame ${frame}${ms === null ? "" : ` at ${elapsedText(ms)}`}`);
  if (unframed > 0) parts.push(`${plural(unframed, "item")} with no frame`);
  return parts.join(", ");
}

/** The capture files, relative to the run directory, in frame order. */
function captureFiles(evidence: CitedEvidence[], runRoot: string): string[] {
  return [
    ...new Set(
      evidence
        .filter((entry) => entry.capture !== null)
        .sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0))
        .map((entry) => (runRoot ? path.relative(runRoot, entry.capture!) : entry.capture!)),
    ),
  ];
}

/**
 * What a reader sees first: the headline, or the reviewer's claim when a review amended the finding,
 * since the headline and experience describe the claim it replaced. Null before headlines existed.
 */
function leadOf(finding: FindingView): { headline: string; corrected: boolean } | null {
  const amended = finding.correction?.status === "amended" ? finding.correction : null;
  if (finding.headline === null) return null;
  return amended?.replacementClaim
    ? { headline: amended.replacementClaim, corrected: true }
    : { headline: finding.headline, corrected: false };
}

function findingLines(finding: FindingView, runRoot: string): string[] {
  const cited = [...new Set(finding.evidence.map((entry) => entry.streamId))];
  const labels = new Map(finding.affected.map((p) => [p.streamId, p.label]));
  const affectedIds = finding.affected.map((p) => p.streamId);
  const streams = [...affectedIds, ...cited.filter((id) => !labels.has(id))];
  const captures = captureFiles(finding.evidence, runRoot);
  const correction = finding.correction;
  const lead = leadOf(finding);
  return [
    ...(lead === null
      ? [`${finding.id} ${finding.title}`]
      : [
          `${finding.id} ${lead.headline}`,
          lead.corrected
            ? "   Corrected in human review: the reviewer's claim replaces the original headline and account."
            : `   ${finding.experience}`,
          `   evidence: ${finding.title}`,
        ]),
    `   impact: ${IMPACT_TEXT[finding.impact]} · confidence: ${finding.confidence} · recovery: ${RECOVERY_TEXT[finding.recovery]}`,
    `   ${finding.summary}`,
    `   affected: ${finding.affected.length} of ${plural(finding.exposedCount, "exposed participant")}`,
    ...streams.map((streamId) => {
      const moments = momentsText(finding.evidence.filter((entry) => entry.streamId === streamId));
      const label = `${labels.get(streamId) ?? streamId}${labels.has(streamId) ? "" : " (cited, not affected)"}`;
      return `   - ${label}${moments ? `: ${moments}` : ""}`;
    }),
    ...(captures.length === 0 ? [] : [`   captures: ${captures.join(", ")}`]),
    `   next step: ${finding.nextStep}`,
    ...(correction === null
      ? []
      : [
          `   human review: ${correction.status}, ${correction.reason}${correction.replacementClaim ? ` Amended claim: ${correction.replacementClaim}` : ""}`,
        ]),
  ];
}

function designFindingLines(finding: DesignFindingView, runRoot: string): string[] {
  const captures = captureFiles(finding.evidence, runRoot);
  return [
    `${finding.id} ${finding.severity}: ${finding.headline}`,
    `   screen: ${finding.screen}`,
    `   notice: ${finding.notice}`,
    `   why it matters: ${finding.whyItMatters}`,
    `   suggestion: ${finding.suggestion}`,
    `   seen by: ${finding.seenBy.map((p) => p.label).join(", ")} · confidence: ${finding.confidence}`,
    ...(captures.length === 0 ? [] : [`   captures: ${captures.join(", ")}`]),
  ];
}

/** Nothing for an analysis written before design findings. */
function designSection(view: AnalysisFindings): string[] {
  const design = view.designFindings;
  if (design === null) return [];
  if (design.length === 0) return ["", "design findings: none in the reviewed captures"];
  return [
    "",
    `design findings: ${design.length}, most severe first`,
    ...design.flatMap((finding, index) => [
      ...(index === 0 ? [] : [""]),
      ...designFindingLines(finding, view.runPath ?? ""),
    ]),
  ];
}

/** The full findings block: the analysis, every finding with its evidence, and its limitations. */
export function formatFindings(view: AnalysisFindings): string[] {
  if (view.state !== "ready" && view.state !== "stale")
    return [`findings: none. ${view.message}`, ...(view.next ? [`next: ${view.next}`] : [])];
  const model = [view.provider, view.model].filter(Boolean).join(" ");
  const cost =
    view.estimatedCostUsd === null ? "" : `, estimated $${view.estimatedCostUsd.toFixed(2)}`;
  return [
    `findings: ${view.findings.length} from analysis ${view.analysisId} (${view.status}, ${model}${cost})`,
    ...(view.state === "stale" ? [`warning: ${view.message}`, `next: ${view.next}`] : []),
    ...(view.summary ? [view.summary] : []),
    ...view.findings.flatMap((finding) => ["", ...findingLines(finding, view.runPath ?? "")]),
    ...designSection(view),
    ...(view.limitations.length === 0
      ? []
      : ["", "limitations:", ...view.limitations.map((limitation) => `- ${limitation}`)]),
    ...view.warnings.map((warning) => `warning: ${warning}`),
    "",
    `analysis: ${view.path}`,
  ];
}

/** At most `limit` findings, one line each, and the command that prints all of them. */
export function formatFindingsSummary(
  view: AnalysisFindings,
  fullCommand: string,
  limit = 3,
): string[] {
  if (view.state !== "ready" && view.state !== "stale")
    return [`findings: ${view.message}`, ...(view.next ? [`next: ${view.next}`] : [])];
  const shown = view.findings.slice(0, limit);
  const design = view.designFindings;
  return [
    `findings: ${view.findings.length === 0 ? "none" : view.findings.length}${view.state === "stale" ? " (stale)" : ""}`,
    ...shown.map((finding) => {
      const qualities = `${IMPACT_TEXT[finding.impact]}, ${finding.confidence} confidence, ${RECOVERY_TEXT[finding.recovery]}`;
      const lead = leadOf(finding);
      if (lead === null) return `- ${finding.id} ${qualities}: ${finding.title}`;
      return `- ${finding.id} ${lead.headline} (${lead.corrected ? "corrected in human review" : qualities})`;
    }),
    ...(view.findings.length > limit
      ? [`- and ${plural(view.findings.length - limit, "more finding")}`]
      : []),
    ...(design === null
      ? []
      : [
          `design findings: ${design.length === 0 ? "none" : design.length}`,
          ...design
            .slice(0, limit)
            .map((finding) => `- ${finding.id} ${finding.severity}: ${finding.headline}`),
          ...(design.length > limit
            ? [`- and ${plural(design.length - limit, "more design finding")}`]
            : []),
        ]),
    `all findings: ${fullCommand}`,
  ];
}

/**
 * The end of a live run's human output, after its `analysis:` line: the findings of the analysis
 * the run just completed. Prints nothing for --json, or when the run's analysis did not complete,
 * since that line already says why.
 */
export async function writeRunFindings(
  command: Command,
  io: CliIo,
  cwd: string,
  result: { runId?: string; automaticAnalysis?: AutomaticAnalysisOutcome },
): Promise<void> {
  const outcome = result.automaticAnalysis;
  const analysisId = outcome?.result?.analysisId;
  if (
    wantsJson(command) ||
    result.runId === undefined ||
    analysisId === undefined ||
    (outcome?.state !== "complete" && outcome?.state !== "partial")
  )
    return;
  try {
    const view = await readRunFindings(cwd, result.runId, analysisId);
    const full = cli(`review --run ${view.runId}${cwdFlag(cwd)}`);
    io.writeOut(`${formatFindingsSummary(view, full).join("\n")}\n`);
  } catch {
    // The run's own result is already printed; review reads the same record later.
  }
}
