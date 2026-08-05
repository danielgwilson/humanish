// OPERATOR-EDITABLE ESTIMATES — NOT authoritative prices. Providers change pricing without
// notice. When they do, update BOTH the number AND the `asOf` date on the affected entry.
// Every dollar figure humanish derives from this table is surfaced/persisted as an ESTIMATE,
// labeled "estimated (rates as of <asOf>)", and is NEVER presented as an exact charge.
//
// This module is PURE (node builtins only, no deps) and deterministic: the two estimator
// functions take an OPTIONAL injected rate table/rate so tests drive assertions with a fake
// sheet and never depend on the live numbers below. An UNKNOWN model/desktop rate yields a
// DECLARED-ABSENT estimate (estimatedCostUsd: null + a reason), NEVER a guessed or silent-zero
// cost (invariant 5). A bare `costUsd` elsewhere in the contract means a provider actually
// billed that amount; the token-derived estimate here always lives under `estimatedCostUsd`
// so a reader can never confuse an estimate for an authoritative charge (invariant 6).

// A type-only import — erased at compile time, so the pricing <-> actor-contract cycle is not a
// runtime cycle.
import type { ActorTokenUsage } from "./actor-contract.js";

export const PRICING_SCHEMA = "humanish.pricing.v1";
export const ACTOR_ESTIMATED_COST_SCHEMA = "humanish.actor-estimated-cost.v1";

export interface ModelRate {
  /** USD per input token (the per-1M equivalent is noted in the comment beside each entry). */
  inputUsdPerToken: number;
  /** USD per output token. */
  outputUsdPerToken: number;
  /** "YYYY-MM-DD" the entry was last checked against `source`. */
  asOf: string;
  /** Public pricing page the number came from (a comment/URL, never a secret). */
  source: string;
  /** true = a stand-in NOT copied from a live sheet; the estimate carries this flag so a
   *  placeholder rate is never mistaken for a confirmed one. */
  placeholder?: boolean;
}

export interface DesktopRate {
  usdPerMinute: number;
  asOf: string;
  source: string;
  placeholder?: boolean;
}

/**
 * The token-derived cost ESTIMATE for one actor lane. `estimatedCostUsd: null` = DECLARED ABSENT
 * (unknown rate or no token usage) — never coerced to 0. A non-null figure ALWAYS carries its
 * pricing provenance (`ratesAsOf` + `source`) so the mechanism (a rate-table multiply) matches
 * the claim (an estimate, not a charge). Defined here so the rate table and the field that
 * consumes it live together; `ActorTrace` imports it type-only.
 */
export interface ActorEstimatedCost {
  schema: typeof ACTOR_ESTIMATED_COST_SCHEMA;
  /** null = declared absent (no rate for the model / no token usage). */
  estimatedCostUsd: number | null;
  reason?: "no_rate_for_model" | "no_token_usage";
  /** Pricing provenance date; null iff estimatedCostUsd is null. */
  ratesAsOf: string | null;
  /** The pricing-page URL/comment that produced the rate. */
  source?: string;
  /** The model id the estimate was keyed on. */
  modelId?: string;
  /** true when the rate is a stand-in, not a live sheet. */
  placeholder?: boolean;
  breakdown?: { inputUsd: number; outputUsd: number; inputTokens: number; outputTokens: number };
}

/** The desktop-minute cost ESTIMATE (host-side create->teardown span * a per-minute rate). Same
 *  null-discipline as ActorEstimatedCost: `estimatedCostUsd: null` = not measured (no duration). */
export interface DesktopCostEstimate {
  estimatedCostUsd: number | null;
  reason?: "no_duration";
  ratesAsOf: string | null;
  source?: string;
  /** The billed minutes the estimate was keyed on; null when no duration was measured. */
  minutes: number | null;
  placeholder?: boolean;
}

// Per-model rates, keyed on the model id that lands in trace.ids.model (lookup is
// case-insensitive on a trimmed id). An id NOT present here is DECLARED ABSENT, never guessed.
export const MODEL_RATES: Record<string, ModelRate> = {
  // OpenAI computer-use-preview (the classic CUA model). ~$3 / 1M input, ~$12 / 1M output.
  // source: openai.com/api/pricing (verify — providers change without notice).
  "computer-use-preview": {
    inputUsdPerToken: 3e-6,
    outputUsdPerToken: 12e-6,
    asOf: "2026-08-01",
    source: "openai.com/api/pricing (computer-use-preview)"
  },
  // gpt-5.5 = the shipped CUA default (DEFAULT_OPENAI_CU_MODEL). $5 / 1M input, $30 / 1M output
  // ($0.50 / 1M cached input, not modeled here). NOTE: OpenAI's live pricing page no longer lists
  // gpt-5.5 (superseded by the gpt-5.6 family) — rate confirmed against public third-party sheets
  // instead; refreshing the default model is tracked in issue #334.
  "gpt-5.5": {
    inputUsdPerToken: 5e-6,
    outputUsdPerToken: 30e-6,
    asOf: "2026-08-05",
    source: "openrouter.ai/openai/gpt-5.5 (gpt-5.5 no longer on openai.com/api/pricing; see #334)"
  }
};

// E2B desktop sandbox compute, billed per-second by vCPU+RAM. Live sheet: 2 vCPU (default)
// $0.000028/s + RAM $0.0000045/GiB/s => at an ASSUMED 4 GiB desktop, $0.000046/s ~= $0.00276/min
// (~$0.17/hr). The per-second rates are confirmed; the desktop template's RAM spec is not
// published, so the assumption keeps this entry `placeholder` until a live run's sandbox spec
// confirms it. 4 GiB is the conservative (higher) choice: over-estimating is the safe direction
// for maxUsd caps.
export const DESKTOP_RATE: DesktopRate = {
  usdPerMinute: 0.00276,
  asOf: "2026-08-05",
  source: "e2b.dev/pricing (2 vCPU default + assumed 4 GiB RAM; confirm spec from a live run)",
  placeholder: true
};

/** Round a USD figure to 6 decimals so a float-accumulated total never carries spurious
 *  precision. This mirrors the SPIRIT of the terminal ledger's private roundUsd (6dp) without
 *  importing it — pricing stays a standalone pure module. */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Estimate one actor lane's model-token cost from its trace tokenUsage + model id. Deterministic;
 * the rate table is injectable (tests pass a fake sheet). Returns a DECLARED-ABSENT estimate
 * (estimatedCostUsd: null + a reason) for a missing rate or missing usage — never a guessed cost.
 */
export function estimateActorCost(
  tokenUsage: ActorTokenUsage | undefined,
  modelId: string | undefined,
  rates: Record<string, ModelRate> = MODEL_RATES
): ActorEstimatedCost {
  if (!tokenUsage || (tokenUsage.input === undefined && tokenUsage.output === undefined)) {
    return { schema: ACTOR_ESTIMATED_COST_SCHEMA, estimatedCostUsd: null, reason: "no_token_usage", ratesAsOf: null };
  }
  const rate = modelId ? rates[modelId.trim().toLowerCase()] : undefined;
  if (!rate) {
    return {
      schema: ACTOR_ESTIMATED_COST_SCHEMA,
      estimatedCostUsd: null,
      reason: "no_rate_for_model",
      ratesAsOf: null,
      ...(modelId ? { modelId } : {})
    };
  }
  const inTok = tokenUsage.input ?? 0;
  const outTok = tokenUsage.output ?? 0;
  const inputUsd = round6(inTok * rate.inputUsdPerToken);
  const outputUsd = round6(outTok * rate.outputUsdPerToken);
  return {
    schema: ACTOR_ESTIMATED_COST_SCHEMA,
    estimatedCostUsd: round6(inputUsd + outputUsd),
    ratesAsOf: rate.asOf,
    source: rate.source,
    ...(modelId ? { modelId } : {}),
    ...(rate.placeholder ? { placeholder: true } : {}),
    breakdown: { inputUsd, outputUsd, inputTokens: inTok, outputTokens: outTok }
  };
}

/**
 * Estimate the E2B desktop-minute cost from a host-side create->teardown span (minutes). The rate
 * is injectable. Returns a DECLARED-ABSENT estimate (null + "no_duration") when no duration was
 * measured (no sandbox / unmeasurable span) — never a guessed 0.
 */
export function estimateDesktopCost(
  minutes: number | undefined,
  rate: DesktopRate = DESKTOP_RATE
): DesktopCostEstimate {
  if (minutes === undefined || !(minutes >= 0)) {
    return { estimatedCostUsd: null, reason: "no_duration", ratesAsOf: null, minutes: null };
  }
  return {
    estimatedCostUsd: round6(minutes * rate.usdPerMinute),
    ratesAsOf: rate.asOf,
    source: rate.source,
    minutes: round6(minutes),
    ...(rate.placeholder ? { placeholder: true } : {})
  };
}
