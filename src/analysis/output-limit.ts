// The output limit an API analysis asks for when its study declares none. A request that runs
// away writes until it reaches the limit, so the limit is sized to what a finished report of the
// packet needs, with room to spare.

import { analysisCohortCount } from "./analysis-limits.js";
import { analysisEffort } from "./models.js";
import type { AnalysisConfig } from "./types.js";

/** The API output limit when a study omits maxOutputTokens, and the most it may ask for. Gemini 4
 * returns at most 32,768 output tokens from one generateContent request. */
export const DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS = 16_384;
export const MAX_ANALYSIS_OUTPUT_TOKENS = 32_768;

/**
 * The limit of a low- or medium-effort OpenAI request: this many tokens, and this many more for
 * each participant. On the 2026-10-22 and 2026-10-23 benchmark recordings the longest finished
 * report at those efforts used 8,354 tokens for one participant and 11,313 for three (gpt-6-luna at
 * medium; gpt-6.1-sol at medium used at most 5,659 and 9,000), so the limit is 1.7 and 1.6 times
 * those. docs/contracts/study-analysis.md has the table.
 */
const LIMIT_BASE_TOKENS = 12_288;
const LIMIT_TOKENS_PER_PARTICIPANT = 2_048;
const SIZED_EFFORTS: ReadonlySet<string> = new Set(["none", "low", "medium"]);

/**
 * The output limit an analysis of `participants` asks for when its study declares none, or
 * undefined for Codex, which takes no limit. A high-effort or Gemini analysis, and one analysed in
 * cohorts, gets the most the analysts return: at those efforts one finished report of three
 * participants used up to 26,439 tokens.
 */
export function defaultOutputTokens(
  config: AnalysisConfig,
  participants: number,
): number | undefined {
  if (config.provider === "codex") return undefined;
  if (
    config.provider === "gemini" ||
    !SIZED_EFFORTS.has(analysisEffort(config)) ||
    analysisCohortCount(participants) > 1
  )
    return MAX_ANALYSIS_OUTPUT_TOKENS;
  return Math.min(
    MAX_ANALYSIS_OUTPUT_TOKENS,
    LIMIT_BASE_TOKENS + LIMIT_TOKENS_PER_PARTICIPANT * participants,
  );
}
