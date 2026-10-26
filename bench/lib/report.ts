// Turns a benchmark manifest and the run bundles it names into the results file and its Markdown
// summary.

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFECT_IDS,
  PLANTED,
  RUBRIC_ID,
  RUBRIC_VERSION,
  type Arm,
  type EvidenceFacts,
  type Storage,
} from "../taskly/answer-key.js";
import { MISSIONS, type MissionId } from "../taskly/missions.js";
import {
  analysisInputOf,
  participantsOf,
  readAnalysis,
  readRunBundle,
  runCosts,
  type AnalysisArtifact,
  type RunBundle,
} from "./bundle.js";
import type { BrainId, BudgetSettings, ParticipantSettings } from "./plan.js";
import { round } from "./plan.js";
import { REPO_ROOT, sha256, type FixtureDigests } from "./project.js";
import {
  combineFacts,
  scoreAnalysis,
  scoreReport,
  type AnalysisScore,
  type ReportScore,
} from "./score.js";
import { summarizeAnalyses, summarizeReports, type Count, type StageSummary } from "./summary.js";

export const MANIFEST_SCHEMA = "humanish.bench-manifest.v1";
export const RESULT_SCHEMA = "humanish.bench-result.v1";

export type AnalysisState =
  | "complete"
  | "failed"
  | "refused"
  | "skipped_budget"
  | "skipped_disabled"
  | "skipped_no_run"
  | "not_run";

/**
 * One analysis model of the matrix: `model`, or `provider:model` passed as `--provider`, with an
 * optional `@effort` passed as `--reasoning-effort`.
 */
export interface AnalysisSpec {
  label: string;
  provider: string | null;
  model: string;
  reasoningEffort?: string;
}

export interface RunRecord {
  brain: BrainId;
  arm: Arm;
  index: number;
  studyId: string;
  runId: string | null;
  ok: boolean | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  analysis: AnalysisRecord;
  cleanup: CleanupRecord | null;
}

export interface AnalysisRecord {
  state: AnalysisState;
  analysisId: string | null;
  estimatedUsd: number | null;
  /** The CLI's `admission.estimatedCostUsd`: the expected cost since 0.114.0, the worst case before. */
  admissionUsd: number | null;
  /** The applied per-analysis cap; older manifests use budget.analysisMaxUsd. */
  maxCostUsd?: number;
  /** Wall time of the `humanish analyze` call, null when none was made; absent in older manifests. */
  wallMs?: number | null;
  error: string | null;
}

/** One analysis of the matrix: a recorded run analyzed by one analysis model. */
export interface MatrixAnalysis extends AnalysisRecord {
  runId: string;
  /** The analysis model's `--analysis-models` label. */
  spec: string;
  /** 1 for the run's first analysis with this model, counting earlier invocations. */
  repeat: number;
  /** The version of the humanish CLI that analyzed it. */
  humanish: string;
}

/**
 * `reclaim --check`'s state after the run, and the killing reclaim's state when the check was not
 * clean. Manifests written before `reclaim --check` existed hold the `cleanup` command's counts.
 */
export type CleanupRecord =
  | { checkState: string; reclaimState: string | null }
  | { alreadyClean: number; failed: number; reclaimed: boolean | null };

function cleanupText(cleanup: CleanupRecord | null): string {
  if (cleanup === null) return "not checked";
  if ("checkState" in cleanup) {
    return `check ${cleanup.checkState}${cleanup.reclaimState ? `, reclaim ${cleanup.reclaimState}` : ""}`;
  }
  return `${cleanup.alreadyClean} clean, ${cleanup.failed} unconfirmed${cleanup.reclaimed ? ", reclaimed" : ""}`;
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  createdAt: string;
  humanish: { version: string; source: string };
  mission: MissionId;
  brains: BrainId[];
  runsPerArm: number;
  budget: BudgetSettings;
  fixture: FixtureDigests;
  stopped: Partial<Record<BrainId, string>>;
  runs: RunRecord[];
  /** Present when `--analysis-models`, `--analysis-repeats` or `--reanalyze` ran the matrix. */
  analysisMatrix?: MatrixAnalysis[];
  /** The `--participant` and `--service-tier` settings; absent means the CLI's defaults. */
  participant?: ParticipantSettings;
  /** The persona id the studies named; absent means synthetic-new-user. */
  persona?: string;
  /** Where the served builds kept tasks; absent means memory, as before `--storage` existed. */
  storage?: Storage;
}

export interface ScoredRun {
  arm: Arm;
  index: number;
  runId: string | null;
  ok: boolean | null;
  error: string | null;
  costs: {
    participantUsd: number | null;
    desktopUsd: number | null;
    analysisUsd: number | null;
    totalUsd: number | null;
  };
  analysisState: AnalysisState;
  analysisRefusal: {
    reason: string;
    admissionUsd: number | null;
    maxCostUsd: number;
    excludedFromRecall: true;
  } | null;
  cleanup: RunRecord["cleanup"];
  participants: (ReportScore & { model: string | null; status: string | null; stopCause: string | null })[];
  analysis: AnalysisScore | null;
}

export interface BrainResult {
  brain: BrainId;
  participantModels: string[];
  analysis: {
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
    maxCostUsd: number | null;
    maxOutputTokens: number | null;
  };
  stopped: string | null;
  spentUsd: { participant: number; desktop: number; analysis: number; total: number; unpricedRuns: number };
  runs: ScoredRun[];
  summary: { report: StageSummary; analysis: StageSummary };
  /** One entry per analysis model of the matrix, in `--analysis-models` order. */
  analysisModels?: ModelResult[];
}

/** One analysis model's analyses of a brain's recorded runs, scored like the run analyses. */
export interface ModelResult {
  spec: string;
  /** The analyst the saved analyses record, null when none completed. */
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  states: Partial<Record<AnalysisState, number>>;
  /** Complete analyses only. */
  summary: StageSummary;
  /** Estimated spend of every analysis call; `unpriced` counts dispatched calls with no estimate. */
  spentUsd: { total: number; perAnalysis: number | null; unpriced: number };
  /** Wall time of every `humanish analyze` call that ran. */
  wallMs: { total: number; perAnalysis: number | null };
  analyses: ScoredMatrixAnalysis[];
}

export interface ScoredMatrixAnalysis {
  arm: Arm;
  index: number;
  runId: string;
  repeat: number;
  state: AnalysisState;
  analysisId: string | null;
  estimatedUsd: number | null;
  wallMs: number | null;
  error: string | null;
  analysis: AnalysisScore | null;
}

export interface BenchResult {
  schema: typeof RESULT_SCHEMA;
  createdAt: string;
  humanish: Manifest["humanish"];
  rubric: { id: string; version: number; sha256: string };
  fixture: { id: "taskly" | "taskly-local"; digests: FixtureDigests; persona: string };
  participant?: ParticipantSettings;
  mission: { id: MissionId; sha256: string; text: string };
  runsPerArm: number;
  budget: BudgetSettings;
  brains: BrainResult[];
}

function scoreRun(
  projectDir: string,
  record: RunRecord,
  missionText: string,
  budget: BudgetSettings,
  storage: Storage,
): ScoredRun {
  const base: ScoredRun = {
    arm: record.arm,
    index: record.index,
    runId: record.runId,
    ok: record.ok,
    error: record.error,
    costs: { participantUsd: null, desktopUsd: null, analysisUsd: record.analysis.estimatedUsd, totalUsd: null },
    analysisState: record.analysis.state,
    analysisRefusal: record.analysis.state === "refused" ? {
      reason: record.analysis.error === "analysis_budget_exceeded"
        ? "refused by cost cap" : `refused (${record.analysis.error ?? "unknown error"})`,
      admissionUsd: record.analysis.admissionUsd,
      maxCostUsd: record.analysis.maxCostUsd ?? budget.analysisMaxUsd,
      excludedFromRecall: true,
    } : null,
    cleanup: record.cleanup,
    participants: [],
    analysis: null,
  };
  if (record.runId === null) return base;
  let bundle: RunBundle;
  try {
    bundle = readRunBundle(projectDir, record.runId);
  } catch {
    return base;
  }
  const costs = runCosts(bundle);
  const parts = [costs.participantUsd, costs.desktopUsd, record.analysis.estimatedUsd];
  base.costs = {
    participantUsd: costs.participantUsd,
    desktopUsd: costs.desktopUsd,
    analysisUsd: record.analysis.estimatedUsd,
    totalUsd: round(parts.reduce<number>((total, part) => total + (part ?? 0), 0)),
  };
  const participants = participantsOf(bundle, missionText, storage);
  base.participants = participants.map((participant) => {
    const stream = bundle.streams.find((candidate) => candidate.id === participant.streamId);
    return {
      ...scoreReport(participant, record.arm),
      model: stream?.actor?.ids?.model ?? null,
      status: stream?.actor?.status ?? null,
      stopCause: stream?.actor?.stopCause ?? null,
    };
  });
  const artifact: AnalysisArtifact | null =
    record.analysis.state === "complete"
      ? readAnalysis(projectDir, record.runId, record.analysis.analysisId ?? undefined)
      : null;
  const input = artifact ? analysisInputOf(artifact) : null;
  if (input) {
    base.analysis = scoreAnalysis(
      input,
      record.arm,
      combineFacts(
        participants.map((participant) => participant.facts),
        missionText,
      ),
    );
  }
  return base;
}

/** Score the matrix's analyses of one brain's runs, grouped by analysis model. */
function scoreAnalysisModels(projectDir: string, manifest: Manifest, brain: BrainId, missionText: string): ModelResult[] {
  const runs = new Map(
    manifest.runs.flatMap((run) => (run.brain === brain && run.runId !== null ? [[run.runId, run] as const] : [])),
  );
  const facts = new Map<string, EvidenceFacts | null>();
  const factsOf = (runId: string): EvidenceFacts | null => {
    if (!facts.has(runId)) {
      try {
        const participants = participantsOf(readRunBundle(projectDir, runId), missionText, manifest.storage ?? "memory");
        facts.set(runId, combineFacts(participants.map((participant) => participant.facts), missionText));
      } catch {
        facts.set(runId, null);
      }
    }
    return facts.get(runId) ?? null;
  };
  const analyses = (manifest.analysisMatrix ?? []).filter((analysis) => runs.has(analysis.runId));
  const specs = [...new Set(analyses.map((analysis) => analysis.spec))];
  return specs.map((spec): ModelResult => {
    const artifacts: AnalysisArtifact[] = [];
    const scored = analyses.filter((analysis) => analysis.spec === spec).map((analysis): ScoredMatrixAnalysis => {
      const run = runs.get(analysis.runId) as RunRecord;
      const artifact = analysis.state === "complete" && analysis.analysisId !== null
        ? readAnalysis(projectDir, analysis.runId, analysis.analysisId)
        : null;
      const input = artifact ? analysisInputOf(artifact) : null;
      const runFacts = input ? factsOf(analysis.runId) : null;
      if (artifact) artifacts.push(artifact);
      return {
        arm: run.arm,
        index: run.index,
        runId: analysis.runId,
        repeat: analysis.repeat,
        state: analysis.state,
        analysisId: analysis.analysisId,
        estimatedUsd: analysis.estimatedUsd,
        wallMs: analysis.wallMs ?? null,
        error: analysis.error,
        analysis: input && runFacts ? scoreAnalysis(input, run.arm, runFacts) : null,
      };
    });
    const states: Partial<Record<AnalysisState, number>> = {};
    for (const analysis of scored) states[analysis.state] = (states[analysis.state] ?? 0) + 1;
    const priced = scored.flatMap((analysis) => (analysis.estimatedUsd === null ? [] : [analysis.estimatedUsd]));
    const timed = scored.flatMap((analysis) => (analysis.wallMs === null ? [] : [analysis.wallMs]));
    const total = (values: number[]): number => values.reduce((sum, value) => sum + value, 0);
    const first = artifacts[0];
    return {
      spec,
      provider: first?.provider ?? null,
      model: first?.config?.model ?? null,
      promptVersion: first?.promptVersion ?? null,
      states,
      summary: summarizeAnalyses(
        scored.flatMap((analysis) => (analysis.analysis ? [{ arm: analysis.arm, score: analysis.analysis }] : [])),
      ),
      spentUsd: {
        total: round(total(priced)),
        perAnalysis: priced.length === 0 ? null : round(total(priced) / priced.length),
        unpriced: scored.filter((analysis) => analysis.estimatedUsd === null && analysis.wallMs !== null).length,
      },
      wallMs: { total: total(timed), perAnalysis: timed.length === 0 ? null : Math.round(total(timed) / timed.length) },
      analyses: scored,
    };
  });
}

/** Score every run the manifest records. */
export function buildResult(projectDir: string, manifest: Manifest): BenchResult {
  const mission = MISSIONS[manifest.mission];
  const answerKey = readFileSync(path.join(REPO_ROOT, "bench", "taskly", "answer-key.ts"));
  const brains = manifest.brains.map((brain): BrainResult => {
    const runs = manifest.runs
      .filter((record) => record.brain === brain)
      .map((record) => scoreRun(projectDir, record, mission.text, manifest.budget, manifest.storage ?? "memory"));
    const analyses = manifest.runs
      .filter((record) => record.brain === brain && record.analysis.state === "complete" && record.runId)
      .map((record) => readAnalysis(projectDir, record.runId ?? "", record.analysis.analysisId ?? undefined))
      .filter((artifact): artifact is AnalysisArtifact => artifact !== null);
    const first = analyses[0];
    const spent = { participant: 0, desktop: 0, analysis: 0, total: 0, unpricedRuns: 0 };
    for (const run of runs) {
      if (run.runId !== null && run.costs.participantUsd === null) spent.unpricedRuns++;
      spent.participant += run.costs.participantUsd ?? 0;
      spent.desktop += run.costs.desktopUsd ?? 0;
      spent.analysis += run.costs.analysisUsd ?? 0;
    }
    spent.total = spent.participant + spent.desktop + spent.analysis;
    return {
      brain,
      participantModels: [
        ...new Set(runs.flatMap((run) => run.participants.map((participant) => participant.model ?? "unknown"))),
      ],
      analysis: {
        provider: first?.provider ?? null,
        model: first?.config?.model ?? null,
        promptVersion: first?.promptVersion ?? null,
        maxCostUsd: first?.config?.maxCostUsd ?? null,
        maxOutputTokens: first?.config?.maxOutputTokens ?? null,
      },
      stopped: manifest.stopped[brain] ?? null,
      spentUsd: {
        participant: round(spent.participant),
        desktop: round(spent.desktop),
        analysis: round(spent.analysis),
        total: round(spent.total),
        unpricedRuns: spent.unpricedRuns,
      },
      runs,
      summary: {
        report: summarizeReports(
          runs.flatMap((run) => run.participants.map((score) => ({ arm: run.arm, score }))),
        ),
        analysis: summarizeAnalyses(
          runs.flatMap((run) => (run.analysis ? [{ arm: run.arm, score: run.analysis }] : [])),
        ),
      },
      ...(manifest.analysisMatrix ? { analysisModels: scoreAnalysisModels(projectDir, manifest, brain, mission.text) } : {}),
    };
  });
  return {
    schema: RESULT_SCHEMA,
    createdAt: new Date().toISOString(),
    humanish: manifest.humanish,
    rubric: { id: RUBRIC_ID, version: RUBRIC_VERSION, sha256: sha256(answerKey) },
    fixture: {
      id: manifest.storage === "local" ? "taskly-local" : "taskly",
      digests: manifest.fixture, persona: manifest.persona ?? "synthetic-new-user" },
    ...(manifest.participant === undefined ? {} : { participant: manifest.participant }),
    mission: { id: mission.id, sha256: sha256(mission.text), text: mission.text },
    runsPerArm: manifest.runsPerArm,
    budget: manifest.budget,
    brains,
  };
}

const usd = (value: number | null): string => (value === null ? "unknown" : `$${value.toFixed(2)}`);
const ratio = (count: Count): string => `${count.hits}/${count.of}`;
/** Model text goes in a code span, so the docs prose checks read none of it. */
const code = (text: string): string => `\`${text.replace(/`/g, "'").replace(/\s+/g, " ")}\``;

/** Refusals stay visible beside recall in both terminal and Markdown results. */
export function analysisRefusalLines(brain: BrainResult): string[] {
  return brain.runs.flatMap((run) => {
    const refusal = run.analysisRefusal;
    return refusal ? [
      `${run.arm} ${run.index} (${run.runId ?? "no run"}): ${refusal.reason} ` +
      `(estimate ${usd(refusal.admissionUsd)}, cap ${usd(refusal.maxCostUsd)}); excluded from analysis recall`,
    ] : [];
  });
}

const interval = (summary: StageSummary): string => {
  const bounds = summary.recall.total.wilson95;
  return bounds ? ` (95% interval ${bounds[0].toFixed(2)} to ${bounds[1].toFixed(2)})` : "";
};
const mechanism = (summary: StageSummary): string =>
  `${summary.d2Mechanism.data_loss} data loss, ${summary.d2Mechanism.display} display, ` +
  `${summary.d2Mechanism.ambiguous} ambiguous, ${summary.d2Mechanism.unspecified} unspecified`;
const duration = (ms: number | null): string =>
  ms === null ? "unknown" : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1)} min`;

/** The analysis models table: one column per model, the same rows as the run analyses. */
function modelLines(models: readonly ModelResult[]): string[] {
  const row = (label: string, cell: (model: ModelResult) => string): string =>
    `| ${label} | ${models.map(cell).join(" | ")} |`;
  const lines = [
    "### Analysis models",
    "",
    "Each model analyzed the same recorded runs. Spend is the CLI's estimate and wall time is the " +
      "`humanish analyze` call, per model and per analysis.",
    "",
    `| | ${models.map((model) => code(model.spec)).join(" | ")} |`,
    `|---|${models.map(() => "---").join("|")}|`,
    row("Recorded model, prompt", (model) =>
      model.model ? `${code(model.model)}, ${model.promptVersion ? code(model.promptVersion) : "unknown"}` : "none completed"),
    row("Scored analyses", (model) => `${model.summary.plantedUnits} planted, ${model.summary.cleanUnits} clean`),
    row("Not scored", (model) =>
      Object.entries(model.states).filter(([state]) => state !== "complete").map(([state, count]) => `${count} ${state}`).join(", ") || "none"),
    ...PLANTED.map((defect) => row(`${defect.id} ${defect.label}`, (model) => ratio(model.summary.recall[defect.id]))),
    row("Recall, all defects", (model) => `${ratio(model.summary.recall.total)}${interval(model.summary)}`),
    row("False assurance", (model) => String(model.summary.falseAssurance.claims)),
    row("Invented, planted arm", (model) => String(model.summary.invented.planted)),
    row("Invented, clean arm", (model) => String(model.summary.invented.clean)),
    row("Harness-caused", (model) => String(model.summary.harness)),
    row("Other true claims", (model) => String(model.summary.supported)),
    row("Unresolved, for a person", (model) => String(model.summary.unresolved)),
    row("D2 mechanism", (model) => mechanism(model.summary)),
    row("Estimated spend", (model) =>
      `${usd(model.spentUsd.total)}, ${usd(model.spentUsd.perAnalysis)} an analysis` +
      `${model.spentUsd.unpriced > 0 ? `, ${model.spentUsd.unpriced} unpriced` : ""}`),
    row("Wall time", (model) => `${duration(model.wallMs.total)}, ${duration(model.wallMs.perAnalysis)} an analysis`),
    "",
    "| model | arm | run | repeat | state | spend | wall time |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const model of models) {
    for (const analysis of model.analyses) {
      lines.push(
        `| ${code(model.spec)} | ${analysis.arm} ${analysis.index} | \`${analysis.runId}\` | ${analysis.repeat} | ` +
          `${analysis.state}${analysis.error ? ` (${analysis.error})` : ""} | ${usd(analysis.estimatedUsd)} | ${duration(analysis.wallMs)} |`,
      );
    }
  }
  const claims = models.flatMap((model) =>
    model.analyses.flatMap((analysis) =>
      (analysis.analysis?.findings ?? [])
        .filter((finding) => finding.verdict === "unresolved" || finding.verdict === "invented")
        .map((finding) =>
          `${model.spec} ${analysis.arm} ${analysis.index} repeat ${analysis.repeat} ${finding.verdict}: ${code(finding.title)}`),
    ),
  );
  if (claims.length > 0) lines.push("", "Analysis model claims to check by hand:", "", ...claims.map((line) => `- ${line}`));
  return lines;
}

/** The short Markdown summary committed next to the results file. */
export function summaryMarkdown(result: BenchResult, jsonName: string): string {
  const date = result.createdAt.slice(0, 10);
  const lines: string[] = [
    `# Taskly benchmark, ${date}, humanish ${result.humanish.version}`,
    "",
    `Mission \`${result.mission.id}\`, ${result.runsPerArm} planned runs per arm, rubric ` +
      `\`${result.rubric.id}\` version ${result.rubric.version}. Built from ${result.humanish.source}. ` +
      `Full results: [${jsonName}](${jsonName}). Definitions: [README](README.md).`,
    "",
  ];
  for (const brain of result.brains) {
    const report = brain.summary.report;
    const analysis = brain.summary.analysis;
    lines.push(
      `## ${brain.brain}`,
      "",
      `Participants ran on ${brain.participantModels.map((model) => `\`${model}\``).join(", ") || "no model"}; ` +
        `analysis ran on ${brain.analysis.model ? `\`${brain.analysis.model}\`` : "no model"}` +
        `${brain.analysis.promptVersion ? ` with prompt \`${brain.analysis.promptVersion}\`` : ""}. ` +
        `Estimated spend ${usd(brain.spentUsd.total)}: participants ${usd(brain.spentUsd.participant)}, ` +
        `desktops ${usd(brain.spentUsd.desktop)}, analysis ${usd(brain.spentUsd.analysis)}` +
        `${brain.spentUsd.unpricedRuns > 0 ? `, ${brain.spentUsd.unpricedRuns} participant run${brain.spentUsd.unpricedRuns === 1 ? "" : "s"} unpriced` : ""}.` +
        `${brain.stopped ? ` Stopped early: ${brain.stopped}.` : ""}`,
      "",
      `| | participant reports (${report.plantedUnits} planted, ${report.cleanUnits} clean) | analyses (${analysis.plantedUnits} planted, ${analysis.cleanUnits} clean) |`,
      "|---|---|---|",
    );
    for (const defect of PLANTED) {
      lines.push(
        `| ${defect.id} ${defect.label} | ${ratio(report.recall[defect.id])} | ${ratio(analysis.recall[defect.id])} |`,
      );
    }
    lines.push(
      `| Recall, all defects | ${ratio(report.recall.total)}${interval(report)} | ${ratio(analysis.recall.total)}${interval(analysis)} |`,
      `| False assurance | ${report.falseAssurance.claims} | ${analysis.falseAssurance.claims} |`,
      `| Invented, planted arm | ${report.invented.planted} | ${analysis.invented.planted} |`,
      `| Invented, clean arm | ${report.invented.clean} | ${analysis.invented.clean} |`,
      `| Harness-caused | ${report.harness} | ${analysis.harness} |`,
      `| Other true claims | ${report.supported} | ${analysis.supported} |`,
      `| Unresolved, for a person | ${report.unresolved} | ${analysis.unresolved} |`,
      `| D2 mechanism | ${mechanism(report)} | ${mechanism(analysis)} |`,
    );
    if (report.engaged) {
      lines.push(
        `| Used the defect's control | ${DEFECT_IDS.map((defect) => `${defect} ${ratio(report.engaged?.[defect] ?? { hits: 0, of: 0 })}`).join(", ")} | |`,
      );
    }
    lines.push("", ...analysisRefusalLines(brain).map((line) => `- ${line}`));
    lines.push("", "| arm | run | participant | desktop | analysis | analysis state | cleanup |", "|---|---|---|---|---|---|---|");
    for (const run of brain.runs) {
      const cleanup = cleanupText(run.cleanup);
      lines.push(
        `| ${run.arm} ${run.index} | ${run.runId ? `\`${run.runId}\`` : `no run recorded (${run.error ?? "in progress or interrupted"})`} | ` +
          `${usd(run.costs.participantUsd)} | ${usd(run.costs.desktopUsd)} | ${usd(run.costs.analysisUsd)} | ` +
          `${run.analysisState} | ${cleanup} |`,
      );
    }
    const unresolved = brain.runs.flatMap((run) => [
      ...run.participants.flatMap((participant) =>
        participant.unresolved.map((text) => `${run.arm} ${run.index} report: ${code(text)}`),
      ),
      ...(run.analysis?.findings ?? [])
        .filter((finding) => finding.verdict === "unresolved" || finding.verdict === "invented")
        .map((finding) => `${run.arm} ${run.index} analysis ${finding.verdict}: ${code(finding.title)}`),
      ...run.participants.flatMap((participant) =>
        participant.invented.map((match) => `${run.arm} ${run.index} report invented ${match.classId}: ${code(match.quote)}`),
      ),
      ...run.participants.flatMap((participant) =>
        participant.harness.map((match) => `${run.arm} ${run.index} report harness ${match.classId}: ${code(match.quote)}`),
      ),
      ...run.participants.flatMap((participant) =>
        participant.falseAssurance.map(
          (match) => `${run.arm} ${run.index} report false assurance ${match.classId}: ${code(match.quote)}`,
        ),
      ),
    ]);
    if (unresolved.length > 0) {
      lines.push("", "Claims to check by hand:", "", ...unresolved.map((line) => `- ${line}`));
    }
    if (brain.analysisModels) lines.push("", ...modelLines(brain.analysisModels));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
