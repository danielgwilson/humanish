import { runEstimateUsd, sumEstimatedUsd } from "./run-cost.js";
import { bindExistingRunArtifactPaths, type PreparedRunArtifactPaths } from "./paths.js";
import type { RunIndexEntry } from "./run-index.js";
import { contradictsAccountBilling } from "../verify/costs.js";
import { EVIDENCE_LIMITS } from "../analysis/evidence.js";
import { readBoundedFile } from "./evidence-files.js";
import { readAutomaticAnalysisAccounting } from "../analysis/job.js";
import { readAnalysisAccountingRecords } from "../analysis/store-executions.js";
import { RUN_BUNDLE_FILE } from "./bundle.js";

/** Additive accounting for retained attempts. Null means no estimate, never an invented zero. */
export interface CostTotals {
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

export interface CostRow {
  runId: string;
  costs: CostTotals;
  warnings: string[];
}

export function emptyCostTotals(): CostTotals {
  return {
    estimatedTotalUsd: null,
    runEstimatedUsd: null,
    analysisEstimatedUsd: null,
    incompleteRunEstimates: 0,
    analysisAttempts: 0,
    analysisDispatchedAttempts: 0,
    analysisNotDispatchedAttempts: 0,
    analysisUnpricedAttempts: 0,
    analysisUnresolvedAttempts: 0,
    analysisHistoryUncertainRuns: 0,
  };
}

export function addCostTotals(into: CostTotals, next: CostTotals): void {
  for (const key of ["estimatedTotalUsd", "runEstimatedUsd", "analysisEstimatedUsd"] as const) {
    into[key] = sumEstimatedUsd(into[key], next[key]);
  }
  for (const key of [
    "incompleteRunEstimates",
    "analysisAttempts",
    "analysisDispatchedAttempts",
    "analysisNotDispatchedAttempts",
    "analysisUnpricedAttempts",
    "analysisUnresolvedAttempts",
    "analysisHistoryUncertainRuns",
  ] as const) {
    into[key] += next[key];
  }
}

/** A read-only, bounded accounting pass. Never validates findings, dispatches, repairs or writes. */
export async function readCostTotals(cwd: string, entry: RunIndexEntry): Promise<CostRow> {
  const costs = emptyCostTotals();
  // Run-cost and analysis-history warnings stay apart: only the second kind makes the history
  // uncertain, whatever a run-cost warning is named.
  const runWarnings: string[] = [];
  const analysisWarnings: string[] = [];
  // A dry run makes no model request and creates no desktop, so with no figure it costs $0. A
  // recorded unknown (null) figure stays unknown.
  costs.runEstimatedUsd = runEstimateUsd(entry);
  try {
    const prepared = await bindExistingRunArtifactPaths(cwd, entry.runId);
    const bytes = await readBoundedFile(prepared, RUN_BUNDLE_FILE, EVIDENCE_LIMITS.sourceBytes);
    let bundle = null;
    try {
      bundle = bytes ? JSON.parse(bytes.toString("utf8")) : null;
    } catch {
      runWarnings.push("RUN_COST_SOURCE_UNREADABLE");
    }
    if (bundle?.runId !== undefined && bundle.runId !== entry.runId) {
      bundle = null;
      costs.runEstimatedUsd = null;
      runWarnings.push("RUN_COST_ID_MISMATCH");
    }
    if (bundle?.cost !== undefined) {
      costs.runEstimatedUsd = runEstimateUsd({ estimatedCostUsd: bundle.cost?.estimatedTotalUsd });
      if (bundle.cost?.fullyEstimated !== true || costs.runEstimatedUsd === null) {
        costs.incompleteRunEstimates = 1;
        runWarnings.push("RUN_COST_PARTIAL_OR_UNKNOWN");
      }
      if (Array.isArray(bundle.streams) && contradictsAccountBilling(bundle.streams, bundle.cost)) {
        costs.runEstimatedUsd = null;
        costs.incompleteRunEstimates = 1;
        runWarnings.push("RUN_ACCOUNT_COST_CONTRADICTION");
      }
    } else if (entry.mode !== "dry-run" || costs.runEstimatedUsd !== 0) {
      costs.incompleteRunEstimates = 1;
      runWarnings.push("RUN_COST_COMPLETENESS_UNKNOWN");
    }

    const analysis = await readAnalysisAccounting(prepared);
    analysisWarnings.push(...analysis.warnings);
    costs.analysisAttempts = analysis.attempts;
    costs.analysisDispatchedAttempts = analysis.dispatched;
    costs.analysisNotDispatchedAttempts = analysis.notDispatched;
    costs.analysisUnpricedAttempts = analysis.unpriced;
    costs.analysisUnresolvedAttempts = analysis.unresolved;
    costs.analysisEstimatedUsd = analysis.estimatedUsd;
    costs.analysisHistoryUncertainRuns = analysisWarnings.length > 0 ? 1 : 0;
  } catch {
    costs.incompleteRunEstimates = 1;
    costs.analysisHistoryUncertainRuns = 1;
    analysisWarnings.push("STUDY_COST_ACCOUNTING_UNAVAILABLE");
  }
  costs.estimatedTotalUsd = sumEstimatedUsd(costs.runEstimatedUsd, costs.analysisEstimatedUsd);
  return {
    runId: entry.runId,
    costs,
    warnings: [...new Set([...runWarnings, ...analysisWarnings])],
  };
}

/** One run's analysis history, every distinct attempt counted once. */
export interface AnalysisAccounting {
  attempts: number;
  /** Attempts that sent a request and recorded its usage. */
  dispatched: number;
  notDispatched: number;
  /** Dispatched or possibly dispatched attempts without a complete price. */
  unpriced: number;
  /** A dispatch marker survives with no usable final accounting. */
  unresolved: number;
  /** The known estimates of the dispatched attempts; 0 when every attempt sent nothing. */
  estimatedUsd: number | null;
  /** Who billed the dispatched attempts. */
  providers: Array<"openai" | "codex">;
  /** History that could not be read whole; ANALYSIS_HISTORY_NOT_RECORDED when there is none. */
  warnings: string[];
}

/**
 * The single reader of a run's analysis spend. Stats totals and every surface that shows one
 * run's cost read it, so they cannot disagree. Receipts are read without opening evidence.
 */
export async function readAnalysisAccounting(
  prepared: PreparedRunArtifactPaths,
): Promise<AnalysisAccounting> {
  const accounting: AnalysisAccounting = {
    attempts: 0,
    dispatched: 0,
    notDispatched: 0,
    unpriced: 0,
    unresolved: 0,
    estimatedUsd: null,
    providers: [],
    warnings: [],
  };
  const [history, automatic] = await Promise.all([
    readAnalysisAccountingRecords(prepared),
    readAutomaticAnalysisAccounting(prepared),
  ]);
  accounting.warnings.push(...history.warnings);
  const records = new Map(history.records.map((record) => [record.id, record]));
  if (automatic === "unknown") accounting.warnings.push("AUTOMATIC_ANALYSIS_ACCOUNTING_UNKNOWN");
  else if (automatic) {
    if (automatic.uncertain) accounting.warnings.push("AUTOMATIC_ANALYSIS_ACCOUNTING_UNKNOWN");
    const id = automatic.reused ? automatic.analysisId : automatic.attemptId;
    if (id && (automatic.started || automatic.analysisId !== null) && !records.has(id)) {
      records.set(id, { id, receipt: null, start: null, legacy: false });
    }
  }
  const providers = new Set<"openai" | "codex">();
  for (const record of records.values()) {
    accounting.attempts += 1;
    if (record.legacy) accounting.warnings.push("ANALYSIS_LEGACY_REPORT_ACCOUNTING");
    const usage = record.receipt?.usage;
    if (!usage) {
      accounting.unpriced += 1;
      accounting.unresolved += 1;
      continue;
    }
    if (!usage.dispatched) {
      accounting.notDispatched += 1;
      accounting.estimatedUsd = sumEstimatedUsd(accounting.estimatedUsd, 0);
      continue;
    }
    accounting.dispatched += 1;
    if (record.receipt) providers.add(record.receipt.provider);
    const estimatedUsd = runEstimateUsd({ estimatedCostUsd: usage.estimatedCostUsd });
    accounting.estimatedUsd = sumEstimatedUsd(accounting.estimatedUsd, estimatedUsd);
    if (estimatedUsd === null || !usage.usageComplete) accounting.unpriced += 1;
  }
  // A skipped or queued automatic job says nothing about earlier manual requests. Only final
  // no-dispatch receipts contribute a supported zero.
  if (records.size === 0) accounting.warnings.push("ANALYSIS_HISTORY_NOT_RECORDED");
  accounting.providers = [...providers].sort();
  accounting.warnings = [...new Set(accounting.warnings)];
  return accounting;
}
