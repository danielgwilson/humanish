import { round6 } from "./pricing.js";
import { bindExistingRunArtifactPaths } from "./paths.js";
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

const isKnownUsd = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
function sumKnown(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : round6((a ?? 0) + (b ?? 0));
}
export function addCostTotals(into: CostTotals, next: CostTotals): void {
  for (const key of ["estimatedTotalUsd", "runEstimatedUsd", "analysisEstimatedUsd"] as const) {
    into[key] = sumKnown(into[key], next[key]);
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
  costs.runEstimatedUsd = isKnownUsd(entry.estimatedCostUsd)
    ? entry.estimatedCostUsd
    : entry.estimatedCostUsd === undefined && entry.mode === "dry-run"
      ? 0
      : null;
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
      costs.runEstimatedUsd = isKnownUsd(bundle.cost?.estimatedTotalUsd)
        ? bundle.cost.estimatedTotalUsd
        : null;
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

    const [history, automatic] = await Promise.all([
      readAnalysisAccountingRecords(prepared),
      readAutomaticAnalysisAccounting(prepared),
    ]);
    analysisWarnings.push(...history.warnings);
    const records = new Map(history.records.map((record) => [record.id, record]));
    if (automatic === "unknown") analysisWarnings.push("AUTOMATIC_ANALYSIS_ACCOUNTING_UNKNOWN");
    else if (automatic) {
      if (automatic.uncertain) analysisWarnings.push("AUTOMATIC_ANALYSIS_ACCOUNTING_UNKNOWN");
      const id = automatic.reused ? automatic.analysisId : automatic.attemptId;
      if (id && (automatic.started || automatic.analysisId !== null) && !records.has(id)) {
        records.set(id, { id, receipt: null, start: null, legacy: false });
      }
    }
    for (const record of records.values()) {
      costs.analysisAttempts += 1;
      if (record.legacy) analysisWarnings.push("ANALYSIS_LEGACY_REPORT_ACCOUNTING");
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
        if (isKnownUsd(usage.estimatedCostUsd)) {
          costs.analysisEstimatedUsd = sumKnown(costs.analysisEstimatedUsd, usage.estimatedCostUsd);
        }
        if (!isKnownUsd(usage.estimatedCostUsd) || !usage.usageComplete)
          costs.analysisUnpricedAttempts += 1;
      }
    }
    // A skipped/queued automatic job says nothing about historical manual requests.
    // Only final no-dispatch receipts contribute a supported zero to recorded attempts.
    if (records.size === 0) analysisWarnings.push("ANALYSIS_HISTORY_NOT_RECORDED");
    costs.analysisHistoryUncertainRuns = analysisWarnings.length > 0 ? 1 : 0;
  } catch {
    costs.incompleteRunEstimates = 1;
    costs.analysisHistoryUncertainRuns = 1;
    analysisWarnings.push("STUDY_COST_ACCOUNTING_UNAVAILABLE");
  }
  costs.estimatedTotalUsd = sumKnown(costs.runEstimatedUsd, costs.analysisEstimatedUsd);
  return {
    runId: entry.runId,
    costs,
    warnings: [...new Set([...runWarnings, ...analysisWarnings])],
  };
}
