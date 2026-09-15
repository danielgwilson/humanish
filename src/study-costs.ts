import { bindExistingRunArtifactPaths } from "./run-paths.js";
import type { RunIndexEntry } from "./run-index.js";
import { readBoundedStudyFile, STUDY_EVIDENCE_LIMITS } from "./study-analysis-evidence.js";
import { readAutomaticStudyAnalysisAccounting } from "./study-analysis-job.js";
import { readStudyAnalysisAccountingRecords } from "./study-analysis-store.js";

/** Additive accounting for retained attempts. Null means no estimate, never an invented zero. */
export interface StudyCosts {
  estimatedTotalUsd: number | null;
  runEstimatedUsd: number | null;
  analysisEstimatedUsd: number | null;
  /** Runs with missing or partial participant/desktop estimates. */
  incompleteRunEstimates: number;
  analysisAttempts: number;
  analysisDispatchedAttempts: number;
  analysisNotDispatchedAttempts: number;
  /** Dispatched or potentially dispatched attempts without a complete price. */
  analysisUnpricedAttempts: number;
  /** A dispatch marker/claim survives, but there is no usable final accounting. */
  analysisUnresolvedAttempts: number;
  /** No retained history, legacy report-only usage, or unreadable/conflicting accounting. */
  analysisHistoryUncertainRuns: number;
}

export interface StudyCostRow { runId: string; costs: StudyCosts; warnings: string[] }

export function emptyStudyCosts(): StudyCosts {
  return { estimatedTotalUsd: null, runEstimatedUsd: null, analysisEstimatedUsd: null,
    incompleteRunEstimates: 0, analysisAttempts: 0, analysisDispatchedAttempts: 0,
    analysisNotDispatchedAttempts: 0, analysisUnpricedAttempts: 0,
    analysisUnresolvedAttempts: 0, analysisHistoryUncertainRuns: 0 };
}

const price = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const round = (value: number): number => Math.round(value * 1e6) / 1e6;
function sumKnown(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : round((a ?? 0) + (b ?? 0));
}
export function addStudyCosts(into: StudyCosts, next: StudyCosts): void {
  for (const key of ["estimatedTotalUsd", "runEstimatedUsd", "analysisEstimatedUsd"] as const) {
    into[key] = sumKnown(into[key], next[key]);
  }
  for (const key of ["incompleteRunEstimates", "analysisAttempts", "analysisDispatchedAttempts",
    "analysisNotDispatchedAttempts", "analysisUnpricedAttempts", "analysisUnresolvedAttempts", "analysisHistoryUncertainRuns"] as const) {
    into[key] += next[key];
  }
}

/** A read-only, bounded accounting pass. Never validates findings, dispatches, repairs or writes. */
export async function readStudyCosts(cwd: string, entry: RunIndexEntry): Promise<StudyCostRow> {
  const costs = emptyStudyCosts();
  const warnings: string[] = [];
  costs.runEstimatedUsd = price(entry.estimatedCostUsd) ? entry.estimatedCostUsd : null;
  try {
    const prepared = await bindExistingRunArtifactPaths(cwd, entry.runId);
    const bytes = await readBoundedStudyFile(prepared, "run.json", STUDY_EVIDENCE_LIMITS.sourceBytes);
    let bundle = null;
    try { bundle = bytes ? JSON.parse(bytes.toString("utf8")) : null; }
    catch { warnings.push("RUN_COST_SOURCE_UNREADABLE"); }
    if (bundle?.runId !== undefined && bundle.runId !== entry.runId) {
      bundle = null;
      costs.runEstimatedUsd = null;
      warnings.push("RUN_COST_ID_MISMATCH");
    }
    if (bundle?.cost !== undefined) {
      costs.runEstimatedUsd = price(bundle.cost?.estimatedTotalUsd) ? bundle.cost.estimatedTotalUsd : null;
      if (bundle.cost?.fullyEstimated !== true || costs.runEstimatedUsd === null) {
        costs.incompleteRunEstimates = 1;
        warnings.push("RUN_COST_PARTIAL_OR_UNKNOWN");
      }
    } else if (entry.mode !== "dry-run" || costs.runEstimatedUsd !== 0) {
      costs.incompleteRunEstimates = 1;
      warnings.push("RUN_COST_COMPLETENESS_UNKNOWN");
    }

    const [history, automatic] = await Promise.all([
      readStudyAnalysisAccountingRecords(prepared), readAutomaticStudyAnalysisAccounting(prepared)
    ]);
    warnings.push(...history.warnings);
    const records = new Map(history.records.map((record) => [record.id, record]));
    if (automatic === "unknown") warnings.push("AUTOMATIC_ANALYSIS_ACCOUNTING_UNKNOWN");
    else if (automatic) {
      if (automatic.uncertain) warnings.push("AUTOMATIC_ANALYSIS_ACCOUNTING_UNKNOWN");
      const id = automatic.reused ? automatic.analysisId : automatic.attemptId;
      if (id && (automatic.started || automatic.analysisId !== null) && !records.has(id)) {
        records.set(id, { id, receipt: null, start: null, legacy: false });
      }
    }
    for (const record of records.values()) {
      costs.analysisAttempts += 1;
      if (record.legacy) warnings.push("ANALYSIS_LEGACY_REPORT_ACCOUNTING");
      const usage = record.receipt?.usage;
      if (!usage) {
        costs.analysisUnpricedAttempts += 1;
        costs.analysisUnresolvedAttempts += 1;
        continue;
      }
      if (!usage.dispatched) {
        costs.analysisNotDispatchedAttempts += 1;
        costs.analysisEstimatedUsd = sumKnown(costs.analysisEstimatedUsd, 0);
      } else {
        costs.analysisDispatchedAttempts += 1;
        if (price(usage.estimatedCostUsd)) {
          costs.analysisEstimatedUsd = sumKnown(costs.analysisEstimatedUsd, usage.estimatedCostUsd);
        }
        if (!price(usage.estimatedCostUsd) || !usage.usageComplete) costs.analysisUnpricedAttempts += 1;
      }
    }
    // A skipped/queued automatic job says nothing about historical manual requests.
    // Only final no-dispatch receipts contribute a supported zero to recorded attempts.
    if (records.size === 0) warnings.push("ANALYSIS_HISTORY_NOT_RECORDED");
    costs.analysisHistoryUncertainRuns = warnings.some((warning) => !warning.startsWith("RUN_COST_")) ? 1 : 0;
  } catch {
    costs.incompleteRunEstimates = 1;
    costs.analysisHistoryUncertainRuns = 1;
    warnings.push("STUDY_COST_ACCOUNTING_UNAVAILABLE");
  }
  costs.estimatedTotalUsd = sumKnown(costs.runEstimatedUsd, costs.analysisEstimatedUsd);
  return { runId: entry.runId, costs, warnings: [...new Set(warnings)] };
}
