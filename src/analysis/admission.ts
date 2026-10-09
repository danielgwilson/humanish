// The admission cost model for one study analysis: the expected cost, the worst case, the figure
// admission compares with the cap, and the words and command a cost refusal gives.

import type { ModelRate } from "../run/pricing.js";

/**
 * UTF-8 bytes per input token for the instructions, evidence packet and schema. On 148 billed
 * gpt-6-astra analyses the evidence packet ran 3.1 to 3.3 bytes per token and the instructions
 * more, so 3 stays above every billed input. Chinese, Japanese and Korean text is 3 bytes per
 * character in UTF-8, so it also counts at least a token per character.
 */
const BYTES_PER_INPUT_TOKEN = 3;
/** Request framing on top of the text and the images. */
const FRAMING_TOKENS = 2048;
/**
 * The output an analysis is expected to write, reasoning included. The most any billed analysis
 * used was 12,511 tokens for one participant and 16,722 for eight.
 */
const EXPECTED_OUTPUT_TOKENS = 12_000;
const EXPECTED_OUTPUT_TOKENS_PER_PARTICIPANT = 1_000;
/** Admission compares the expected cost times this margin with the cap. */
export const ADMISSION_MARGIN = 1.1;

interface AnalysisRequestSize {
  /** UTF-8 bytes of the instructions, the evidence packet and the result schema. */
  textBytes: number;
  imageTokens: number;
  participants: number;
  /** The request's output limit. The worst case spends all of it. */
  outputAllowance: number;
}

/**
 * The requests of one analysis: one per cohort and, for more than one cohort, a merge request.
 * `mergeTextBytes` are the merge request's instructions, schema and packet without the reports.
 */
export interface AnalysisRequests {
  cohorts: readonly AnalysisRequestSize[];
  mergeTextBytes: number;
}

export interface AnalysisCostEstimate {
  inputTokens: number;
  expectedOutputTokens: number;
  expectedCostUsd: number;
  worstCaseCostUsd: number;
  /** The expected cost with the margin, never above the worst case: what admission compares. */
  admittedCostUsd: number;
}

/** Rounded up to the micro-dollar, so a small positive boundary never rounds into admission. */
const roundUp = (usd: number): number => Math.ceil(usd * 1e6) / 1e6;

/** One request's cost. Input is priced at the highest input rate the model bills, cache writes
 * included, and the long-context tier re-prices the whole request past its threshold. */
function requestCost(rate: ModelRate, inputTokens: number, outputTokens: number): number {
  const long =
    rate.longContext !== undefined && inputTokens > rate.longContext.thresholdInputTokens;
  const inputRate = Math.max(
    rate.inputUsdPerToken,
    rate.cacheWriteUsdPerToken ?? 0,
    rate.cachedInputUsdPerToken ?? 0,
  );
  return roundUp(
    inputTokens * inputRate * (long ? rate.longContext!.inputMultiplier : 1) +
      outputTokens * rate.outputUsdPerToken * (long ? rate.longContext!.outputMultiplier : 1),
  );
}

/** One request's input and costs. `reportTokens` are earlier requests' reports it reads. */
function estimateRequest(rate: ModelRate, size: AnalysisRequestSize, reportTokens = 0) {
  const inputTokens =
    Math.ceil(size.textBytes / BYTES_PER_INPUT_TOKEN) +
    FRAMING_TOKENS +
    size.imageTokens +
    reportTokens;
  const expectedOutputTokens = Math.min(
    size.outputAllowance,
    EXPECTED_OUTPUT_TOKENS + EXPECTED_OUTPUT_TOKENS_PER_PARTICIPANT * size.participants,
  );
  return {
    inputTokens,
    expectedOutputTokens,
    expectedCostUsd: requestCost(rate, inputTokens, expectedOutputTokens),
    worstCaseCostUsd: requestCost(rate, inputTokens, size.outputAllowance),
  };
}

/**
 * Every request of one analysis, summed. A merge request reads each cohort's report, priced at
 * that request's whole output allowance since the report and its reasoning share it, and is
 * expected to write what one request covering every participant would.
 */
export function estimateAnalysisCost(
  rate: ModelRate,
  requests: AnalysisRequests,
): AnalysisCostEstimate {
  const { cohorts } = requests;
  const estimates = cohorts.map((size) => estimateRequest(rate, size));
  if (cohorts.length > 1)
    estimates.push(
      estimateRequest(
        rate,
        {
          textBytes: requests.mergeTextBytes,
          imageTokens: 0,
          participants: cohorts.reduce((total, size) => total + size.participants, 0),
          outputAllowance: Math.max(...cohorts.map((size) => size.outputAllowance)),
        },
        cohorts.reduce((total, size) => total + size.outputAllowance, 0),
      ),
    );
  const sum = (key: keyof (typeof estimates)[number]): number =>
    estimates.reduce((total, estimate) => total + estimate[key], 0);
  // Each request's cost is a whole number of micro-dollars, so rounding the sum to the nearest one
  // only removes the addition's float noise.
  const expectedCostUsd = Math.round(sum("expectedCostUsd") * 1e6) / 1e6;
  const worstCaseCostUsd = Math.round(sum("worstCaseCostUsd") * 1e6) / 1e6;
  return {
    inputTokens: sum("inputTokens"),
    expectedOutputTokens: sum("expectedOutputTokens"),
    expectedCostUsd,
    worstCaseCostUsd,
    admittedCostUsd: Math.min(worstCaseCostUsd, roundUp(expectedCostUsd * ADMISSION_MARGIN)),
  };
}

/** The numbers a cost refusal reports. */
export interface RefusedAnalysisCost {
  expectedCostUsd: number;
  worstCaseCostUsd: number;
  maxCostUsd: number;
}

/** A cost refusal in plain words, and the command that runs the analysis under a cap that admits it. */
export interface CostRefusal {
  /** The costs, the cap and that no request was sent, ending in the lead-in to `command`. */
  text: string;
  /** `analyze` with `--max-cost` at the worst case rounded up to a whole dollar, at least 1. */
  command: string;
}

/**
 * Words a cost refusal. `runFlags` are the `analyze` flags that select the run, such as
 * `--run <id>`. `cli` prefixes a humanish command: the CLI passes `cli` from
 * src/cli/invocation.ts, and the Observer, which cannot read the install, a bare `humanish`.
 * This module keeps only type imports, so the Observer can bundle it.
 */
export function costRefusal(
  cost: RefusedAnalysisCost,
  runFlags: string,
  cli: (rest: string) => string,
): CostRefusal {
  const margin = Math.round((ADMISSION_MARGIN - 1) * 100);
  return {
    text: `The expected cost is $${cost.expectedCostUsd.toFixed(2)} and the worst case is $${cost.worstCaseCostUsd.toFixed(2)}. With a ${margin}% margin the expected cost is over the $${cost.maxCostUsd} cap, so no request was sent. To run it, raise the cap:`,
    command: cli(`analyze ${runFlags} --max-cost ${Math.max(1, Math.ceil(cost.worstCaseCostUsd))}`),
  };
}

/** The admission's refused cost, when it refused the analysis for its cost. */
export function refusedCost(admission: {
  error: string | null;
  estimatedCostUsd: number | null;
  worstCaseCostUsd: number | null;
  maxCostUsd: number | null;
}): RefusedAnalysisCost | undefined {
  const { error, estimatedCostUsd, worstCaseCostUsd, maxCostUsd } = admission;
  return error === "analysis_budget_exceeded" &&
    estimatedCostUsd !== null &&
    worstCaseCostUsd !== null &&
    maxCostUsd !== null
    ? { expectedCostUsd: estimatedCostUsd, worstCaseCostUsd, maxCostUsd }
    : undefined;
}
