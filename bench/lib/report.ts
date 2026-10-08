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
  type DefectId,
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
import type { BrainId, BudgetSettings } from "./plan.js";
import { round } from "./plan.js";
import { REPO_ROOT, sha256, type FixtureDigests } from "./project.js";
import {
  combineFacts,
  scoreAnalysis,
  scoreReport,
  type AnalysisScore,
  type Mechanism,
  type ReportScore,
} from "./score.js";

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
  analysis: {
    state: AnalysisState;
    analysisId: string | null;
    estimatedUsd: number | null;
    /** The CLI's `admission.estimatedCostUsd`: the expected cost since 0.114.0, the worst case before. */
    admissionUsd: number | null;
    /** The applied per-analysis cap; older manifests use budget.analysisMaxUsd. */
    maxCostUsd?: number;
    error: string | null;
  };
  cleanup: CleanupRecord | null;
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
}

interface Count {
  hits: number;
  of: number;
}

export interface StageSummary {
  plantedUnits: number;
  cleanUnits: number;
  recall: Record<DefectId, Count> & { total: Count & { wilson95: [number, number] | null } };
  d2Mechanism: Record<Mechanism, number>;
  falseAssurance: { claims: number; unitsWith: number };
  invented: { planted: number; clean: number; unitsWith: number };
  harness: number;
  unresolved: number;
  supported: number;
  engaged?: Record<DefectId, Count>;
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
}

export interface BenchResult {
  schema: typeof RESULT_SCHEMA;
  createdAt: string;
  humanish: Manifest["humanish"];
  rubric: { id: string; version: number; sha256: string };
  fixture: { id: "taskly"; digests: FixtureDigests; persona: string };
  mission: { id: MissionId; sha256: string; text: string };
  runsPerArm: number;
  budget: BudgetSettings;
  brains: BrainResult[];
}

/** Wilson score interval at 95 %. */
export function wilson95(hits: number, of: number): [number, number] | null {
  if (of === 0) return null;
  const z = 1.96;
  const p = hits / of;
  const denominator = 1 + (z * z) / of;
  const center = (p + (z * z) / (2 * of)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / of + (z * z) / (4 * of * of))) / denominator;
  return [round(Math.max(0, center - half)), round(Math.min(1, center + half))];
}

const zeroCounts = (): Record<DefectId, Count> => ({
  D1: { hits: 0, of: 0 },
  D2: { hits: 0, of: 0 },
  D3: { hits: 0, of: 0 },
  D4: { hits: 0, of: 0 },
  D5: { hits: 0, of: 0 },
});

const zeroMechanisms = (): Record<Mechanism, number> => ({
  data_loss: 0,
  display: 0,
  ambiguous: 0,
  unspecified: 0,
});

/** Aggregate participant reports, one unit per participant. */
export function summarizeReports(units: readonly { arm: Arm; score: ReportScore }[]): StageSummary {
  const recall = zeroCounts();
  const engaged = zeroCounts();
  const mechanisms = zeroMechanisms();
  const summary = emptySummary(recall, mechanisms);
  for (const { arm, score } of units) {
    countArm(summary, arm);
    if (arm === "planted") {
      for (const defect of DEFECT_IDS) {
        recall[defect].of++;
        engaged[defect].of++;
        if (score.detected[defect]) recall[defect].hits++;
        if (score.engaged[defect]) engaged[defect].hits++;
      }
      if (score.d2Mechanism) mechanisms[score.d2Mechanism]++;
      summary.falseAssurance.claims += score.falseAssurance.length;
      if (score.falseAssurance.length > 0) summary.falseAssurance.unitsWith++;
    }
    summary.invented[arm] += score.invented.length;
    if (score.invented.length > 0) summary.invented.unitsWith++;
    summary.harness += score.harness.length;
    summary.unresolved += score.unresolved.length;
    summary.supported += score.supported.length;
  }
  return finish(summary, recall, engaged);
}

/** Aggregate analyses, one unit per analysis. */
export function summarizeAnalyses(units: readonly { arm: Arm; score: AnalysisScore }[]): StageSummary {
  const recall = zeroCounts();
  const mechanisms = zeroMechanisms();
  const summary = emptySummary(recall, mechanisms);
  for (const { arm, score } of units) {
    countArm(summary, arm);
    if (arm === "planted") {
      for (const defect of DEFECT_IDS) {
        recall[defect].of++;
        if (score.listed[defect]) recall[defect].hits++;
      }
      if (score.d2Mechanism) mechanisms[score.d2Mechanism]++;
      summary.falseAssurance.claims += score.falseAssurance.length;
      if (score.falseAssurance.length > 0) summary.falseAssurance.unitsWith++;
    }
    const invented = score.findings.filter((finding) => finding.verdict === "invented").length;
    summary.invented[arm] += invented;
    if (invented > 0) summary.invented.unitsWith++;
    summary.harness += score.findings.filter((finding) => finding.verdict === "harness").length;
    summary.unresolved += score.findings.filter((finding) => finding.verdict === "unresolved").length;
    summary.supported += score.findings.filter((finding) => finding.verdict === "supported").length;
  }
  return finish(summary, recall, undefined);
}

function emptySummary(recall: Record<DefectId, Count>, mechanisms: Record<Mechanism, number>): StageSummary {
  return {
    plantedUnits: 0,
    cleanUnits: 0,
    recall: { ...recall, total: { hits: 0, of: 0, wilson95: null } },
    d2Mechanism: mechanisms,
    falseAssurance: { claims: 0, unitsWith: 0 },
    invented: { planted: 0, clean: 0, unitsWith: 0 },
    harness: 0,
    unresolved: 0,
    supported: 0,
  };
}

function countArm(summary: StageSummary, arm: Arm): void {
  if (arm === "planted") summary.plantedUnits++;
  else summary.cleanUnits++;
}

function finish(
  summary: StageSummary,
  recall: Record<DefectId, Count>,
  engaged: Record<DefectId, Count> | undefined,
): StageSummary {
  const hits = DEFECT_IDS.reduce((total, defect) => total + recall[defect].hits, 0);
  const of = DEFECT_IDS.reduce((total, defect) => total + recall[defect].of, 0);
  return {
    ...summary,
    recall: { ...recall, total: { hits, of, wilson95: wilson95(hits, of) } },
    ...(engaged ? { engaged } : {}),
  };
}

function scoreRun(projectDir: string, record: RunRecord, missionText: string, budget: BudgetSettings): ScoredRun {
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
  const participants = participantsOf(bundle, missionText);
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

/** Score every run the manifest records. */
export function buildResult(projectDir: string, manifest: Manifest): BenchResult {
  const mission = MISSIONS[manifest.mission];
  const answerKey = readFileSync(path.join(REPO_ROOT, "bench", "taskly", "answer-key.ts"));
  const brains = manifest.brains.map((brain): BrainResult => {
    const runs = manifest.runs
      .filter((record) => record.brain === brain)
      .map((record) => scoreRun(projectDir, record, mission.text, manifest.budget));
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
    };
  });
  return {
    schema: RESULT_SCHEMA,
    createdAt: new Date().toISOString(),
    humanish: manifest.humanish,
    rubric: { id: RUBRIC_ID, version: RUBRIC_VERSION, sha256: sha256(answerKey) },
    fixture: { id: "taskly", digests: manifest.fixture, persona: "synthetic-new-user" },
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
    const interval = (summary: StageSummary): string => {
      const bounds = summary.recall.total.wilson95;
      return bounds ? ` (95% interval ${bounds[0].toFixed(2)} to ${bounds[1].toFixed(2)})` : "";
    };
    const mechanism = (summary: StageSummary): string =>
      `${summary.d2Mechanism.data_loss} data loss, ${summary.d2Mechanism.display} display, ` +
      `${summary.d2Mechanism.ambiguous} ambiguous, ${summary.d2Mechanism.unspecified} unspecified`;
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
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
