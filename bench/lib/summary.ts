// Aggregates scored participant reports and analyses into the counts the results report: recall
// per defect with a Wilson interval, false assurance, invented, harness-caused and unresolved claims.

import { DEFECT_IDS, type Arm, type DefectId } from "../taskly/answer-key.js";
import { round } from "./plan.js";
import type { AnalysisScore, Mechanism, ReportScore } from "./score.js";

export interface Count {
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
