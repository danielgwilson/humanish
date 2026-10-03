import type { RunCostSummary } from "./bundle.js";
import type { AnalysisAccounting } from "./costs.js";
import type { RunIndexEntry } from "./run-index.js";

// What a run cost a person: participants and desktops from run.json's `cost`, plus every
// analysis request the run sent, which bill separately after the run and are not in that
// summary. readAnalysisAccounting is the one reader of the analysis spend, for stats and for
// every surface that shows one run's cost, so they agree. This module has only type imports,
// so the Observer bundles it without pulling in CLI code.

/** The fields of run.json's `cost` that the run cost reads. Completeness is unknown when absent. */
export type RunCostSubtotal = Pick<RunCostSummary, "estimatedTotalUsd"> &
  Partial<Pick<RunCostSummary, "fullyEstimated" | "ratesAsOf" | "placeholder">>;

/** A run's analysis spend, every attempt counted once, as `readAnalysisAccounting` reads it. */
export interface RunAnalysisCost {
  /** Requests the run's analyses sent, or may have sent. */
  requests: number;
  /** Their known estimated dollars; null when none has a price. */
  estimatedUsd: number | null;
  /** True when every request has a complete price and the history was read whole. */
  complete: boolean;
  /** Who billed the requests that recorded usage. */
  providers: Array<"openai" | "codex">;
}

/** Complete, a lower bound, or unknown (`null`) when only the subtotal's dollars are at hand. */
type Completeness = boolean | null;

export interface RunCost {
  /** Participants and desktops; null when the run has no cost summary, as in a dry run. */
  run: {
    usd: number | null;
    complete: Completeness;
    ratesAsOf: string | null;
    placeholder: boolean;
  } | null;
  /** The run's analysis requests; null when it sent none. */
  analysis: RunAnalysisCost | null;
  /** The known dollars of both; null when neither has a figure. */
  total: { usd: number; complete: Completeness } | null;
}

/** The accounting's analysis spend, or null when the run sent no analysis request. */
export function analysisCostOf(
  accounting: Pick<
    AnalysisAccounting,
    "dispatched" | "unresolved" | "unpriced" | "estimatedUsd" | "providers" | "warnings"
  >,
): RunAnalysisCost | null {
  const requests = accounting.dispatched + accounting.unresolved;
  if (requests === 0) return null;
  const historyWhole = accounting.warnings.every(
    (warning) => warning === "ANALYSIS_HISTORY_NOT_RECORDED",
  );
  return {
    requests,
    estimatedUsd: accounting.estimatedUsd,
    complete: accounting.unpriced === 0 && historyWhole,
    providers: [...accounting.providers],
  };
}

export function runCost(
  subtotal: RunCostSubtotal | null | undefined,
  analysis?: RunAnalysisCost | null,
): RunCost {
  if (subtotal === null || subtotal === undefined)
    return { run: null, analysis: null, total: null };
  const run = {
    usd: typeof subtotal.estimatedTotalUsd === "number" ? subtotal.estimatedTotalUsd : null,
    complete: subtotal.fullyEstimated === undefined ? null : subtotal.fullyEstimated,
    ratesAsOf: subtotal.ratesAsOf ?? null,
    placeholder: subtotal.placeholder === true,
  };
  const spent = analysis ?? null;
  const known = [run.usd, spent?.estimatedUsd].filter(
    (usd): usd is number => typeof usd === "number",
  );
  if (known.length === 0) return { run, analysis: spent, total: null };
  const lowerBound = run.usd === null || run.complete === false || spent?.complete === false;
  return {
    run,
    analysis: spent,
    total: {
      usd: round6(known.reduce((sum, usd) => sum + usd, 0)),
      complete: lowerBound ? false : run.complete,
    },
  };
}

/**
 * A run index entry's cost: its participants-and-desktops figure, complete or a lower bound when
 * the status record says which, plus its analyses.
 */
export function indexedRunCost(
  entry: Pick<RunIndexEntry, "estimatedCostUsd" | "estimatedCostComplete" | "analysisCost">,
): RunCost {
  return runCost(
    {
      estimatedTotalUsd: entry.estimatedCostUsd ?? null,
      ...(entry.estimatedCostComplete === undefined
        ? {}
        : { fullyEstimated: entry.estimatedCostComplete }),
    },
    entry.analysisCost,
  );
}

/** Six decimals, as the run cost summary rounds, so sums of small estimates do not drift. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** An estimate, saying so when some of the spend has no price and is not in it. */
function estimateText(usd: number, complete: Completeness): string {
  return `est. ~$${usd.toFixed(2)}${complete === false ? " plus unpriced usage" : ""}`;
}

function analysesNoun(requests: number): string {
  return requests === 1 ? "analysis" : `${requests} analyses`;
}

function billedBy(providers: RunAnalysisCost["providers"]): string {
  const names = providers.map((provider) =>
    provider === "openai" ? "OpenAI API key" : "Codex account",
  );
  return names.length === 0 ? "" : ` (${names.join(" and ")})`;
}

/**
 * The cost as separate parts: participants and desktops, then the analysis and the total when the
 * run sent an analysis request. Empty when the run has no cost summary.
 */
export function runCostParts(cost: RunCost): string[] {
  if (cost.run === null) return [];
  const rates = `rates as of ${cost.run.ratesAsOf}${cost.run.placeholder ? ", placeholder" : ""}`;
  const parts = [
    cost.run.usd === null
      ? "Participants + desktops: cost not estimated"
      : `Participants + desktops: ${estimateText(cost.run.usd, cost.run.complete)} (${rates})`,
  ];
  const analysis = cost.analysis;
  if (analysis === null) return parts;
  const noun = analysesNoun(analysis.requests);
  const label = noun.charAt(0).toUpperCase() + noun.slice(1);
  if (analysis.estimatedUsd === null)
    parts.push(
      analysis.providers.length === 1 && analysis.providers[0] === "codex"
        ? `${label}: Codex account, dollar cost unknown`
        : `${label}: cost not estimated${billedBy(analysis.providers)}`,
    );
  else
    parts.push(
      `${label}: ${estimateText(analysis.estimatedUsd, analysis.complete)}${billedBy(analysis.providers)}`,
    );
  if (cost.total !== null)
    parts.push(`Total: ${estimateText(cost.total.usd, cost.total.complete)}`);
  return parts;
}

/**
 * The cost in one short label for a list row: the total, and how many analyses it includes.
 * Undefined when the run has no cost summary.
 */
export function runCostLabel(cost: RunCost): string | undefined {
  if (cost.run === null) return undefined;
  const amount =
    cost.total === null
      ? "cost not estimated"
      : `~$${cost.total.usd.toFixed(2)} est.${cost.total.complete === false ? " plus unpriced usage" : ""}`;
  return cost.analysis === null
    ? amount
    : `${amount}, with ${analysesNoun(cost.analysis.requests)}`;
}
