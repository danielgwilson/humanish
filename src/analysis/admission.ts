// The admission cost model for one study analysis request: the expected cost, the worst case, and
// the figure admission compares with the cap.

import type { ModelRate } from "../run/pricing.js";

/**
 * UTF-8 bytes per input token for the instructions, evidence packet and schema. On 148 billed
 * gpt-6-astra analyses the evidence packet ran 3.1 to 3.3 bytes per token and the instructions
 * more, so 3 stays above every billed input. CJK text is 3 bytes per character in UTF-8, so it
 * also counts at least a token per character.
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

export interface AnalysisRequestSize {
  /** UTF-8 bytes of the instructions, the evidence packet and the result schema. */
  textBytes: number;
  imageTokens: number;
  participants: number;
  /** The request's output limit. The worst case spends all of it. */
  outputAllowance: number;
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

export function estimateAnalysisCost(
  rate: ModelRate,
  size: AnalysisRequestSize,
): AnalysisCostEstimate {
  const inputTokens =
    Math.ceil(size.textBytes / BYTES_PER_INPUT_TOKEN) + FRAMING_TOKENS + size.imageTokens;
  const expectedOutputTokens = Math.min(
    size.outputAllowance,
    EXPECTED_OUTPUT_TOKENS + EXPECTED_OUTPUT_TOKENS_PER_PARTICIPANT * size.participants,
  );
  const expectedCostUsd = requestCost(rate, inputTokens, expectedOutputTokens);
  const worstCaseCostUsd = requestCost(rate, inputTokens, size.outputAllowance);
  return {
    inputTokens,
    expectedOutputTokens,
    expectedCostUsd,
    worstCaseCostUsd,
    admittedCostUsd: Math.min(worstCaseCostUsd, roundUp(expectedCostUsd * ADMISSION_MARGIN)),
  };
}
