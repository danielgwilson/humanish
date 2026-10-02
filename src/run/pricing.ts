// Operator-editable estimates, which are not authoritative prices. Providers change pricing without
// notice. When they do, update both the number and the `asOf` date on the affected entry.
// Every dollar figure humanish derives from this table is surfaced/persisted as an estimate,
// labeled "estimated (rates as of <asOf>)", and is never presented as an exact charge.
//
// This module is pure (node builtins only, no deps) and deterministic: the estimator functions take
// an optional injected rate table/rate so tests drive assertions with a fake sheet and never depend
// on the live numbers below. An unknown model/desktop rate yields a declared-absent estimate
// (estimatedCostUsd: null + a reason) and never a guessed or silent-zero cost (invariant 5). A bare
// `costUsd` elsewhere in the contract means a provider actually billed that amount; the
// token-derived estimate here always lives under `estimatedCostUsd` so a reader can never confuse
// an estimate for an authoritative charge (invariant 6).

// A type-only import, erased at compile time, so the pricing <-> src/actors/contract.ts cycle is
// not a runtime cycle.
import type { ActorTokenUsage } from "../actors/contract.js";

export const PRICING_SCHEMA = "humanish.pricing.v1";
export const ACTOR_ESTIMATED_COST_SCHEMA = "humanish.actor-estimated-cost.v1";

export interface ModelRate {
  /** USD per input token (the per-1M equivalent is noted in the comment beside each entry). */
  inputUsdPerToken: number;
  /** USD per output token. */
  outputUsdPerToken: number;
  /** USD per input token served from the provider's prompt cache, when the provider bills those at
   *  a reduced rate. Optional: absent means we do not model a discount and every input token is
   *  billed at `inputUsdPerToken`. */
  cachedInputUsdPerToken?: number;
  /** USD per input token newly written to the provider's prompt cache, when the provider bills
   *  writes (OpenAI: GPT-5.6+ bills `cache_write_tokens` at 1.25x the uncached input rate, as the
   *  total rate for those tokens, with no extra charge on top). Absent = writes are free (every
   *  pre-5.6 model) and any reported write tokens price at the plain input rate. */
  cacheWriteUsdPerToken?: number;
  /** Long-context tier, when the provider re-prices the whole request past an input-size
   *  threshold (OpenAI GPT-5.6: >272K input tokens => 2x input-side, 1.5x output, full request).
   *  Priced exactly only when the usage carries per-request `turns` records; totals alone cannot
   *  say which requests crossed, so without turns the estimate stays on the short-context rate,
   *  which under-estimates a request that crossed. */
  longContext?: {
    thresholdInputTokens: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
  /** The `YYYY-MM-DD` date the entry was last checked against `source`. */
  asOf: string;
  /** Public pricing page the number came from (a comment/URL, never a secret). */
  source: string;
  /** true = a stand-in that was not copied from a live sheet; the estimate carries this flag so a
   *  placeholder rate is never mistaken for a confirmed one. */
  placeholder?: boolean;
}

export interface DesktopRate {
  usdPerMinute: number;
  asOf: string;
  source: string;
  placeholder?: boolean;
}

/** Resource quantities reported by the owned E2B allocation, not its template label. */
export interface DesktopResources {
  cpuCount: number;
  /** E2B's `memoryMB` field is in MiB; normalize the unit before pricing GiB. */
  memoryMiB: number;
}

export interface DesktopResourceRate {
  usdPerCpuSecond: number;
  usdPerGiBSecond: number;
  asOf: string;
  source: string;
}

/**
 * The token-derived cost estimate for one actor trace. `estimatedCostUsd: null` = declared absent
 * (unknown rate or no token usage) and is never coerced to 0. A non-null figure always carries its
 * pricing provenance (`ratesAsOf` + `source`) so the mechanism (a rate-table multiply) matches
 * the claim (an estimate, not a charge). Defined here so the rate table and the field that
 * consumes it live together; `ActorTrace` imports it type-only.
 */
export interface ActorEstimatedCost {
  schema: typeof ACTOR_ESTIMATED_COST_SCHEMA;
  /** null = declared absent (no rate for the model / no token usage). */
  estimatedCostUsd: number | null;
  reason?: "no_rate_for_model" | "no_token_usage" | "account_billing_unknown";
  /** Pricing provenance date; null iff estimatedCostUsd is null. */
  ratesAsOf: string | null;
  /** The pricing-page URL/comment that produced the rate. */
  source?: string;
  /** The model id the estimate was keyed on. */
  modelId?: string;
  /** true when the rate is a stand-in, not a live sheet. */
  placeholder?: boolean;
  /** Set when usage arrived as runtime-turn totals that each sum several requests. No request's
   *  own size is known, so no per-request long-context tier was applied: tokens are priced at the
   *  base tier, cached input at the cached rate. */
  basis?: "aggregated_turns_base_rate";
  breakdown?: {
    inputUsd: number;
    outputUsd: number;
    inputTokens: number;
    outputTokens: number;
    /** Of `inputTokens`, how many were billed at the reduced cached rate. Present only when the
     *  provider reported cache hits and the rate sheet models a cached rate. */
    cachedInputTokens?: number;
    /** Of `inputTokens`, how many were billed at the cache-write rate (OpenAI 5.6+). */
    cacheWriteInputTokens?: number;
    /** How many requests crossed the long-context threshold and were re-tiered. Present only
     *  when per-request `turns` records made exact tiering possible. */
    longContextTurns?: number;
  };
}

/** The desktop-minute cost estimate (host-side create->teardown span * a per-minute rate). Same
 *  null-discipline as ActorEstimatedCost: `estimatedCostUsd: null` = not measured (no duration). */
export interface DesktopCostEstimate {
  estimatedCostUsd: number | null;
  reason?: "no_duration" | "no_desktop_resources" | "no_rate_for_desktop";
  ratesAsOf: string | null;
  source?: string;
  /** The billed minutes the estimate was keyed on; null when no duration was measured. */
  minutes: number | null;
  placeholder?: boolean;
  resources?: DesktopResources;
  usdPerSecond?: number;
}

// The gpt-5.6 long-context tier: >272K input tokens re-prices the full request at 2x
// input-side / 1.5x output (developers.openai.com/api/docs/models/gpt-5.6-sol, 2026-08-18).
const LONG_CONTEXT_TIER_272K = {
  thresholdInputTokens: 272_000,
  inputMultiplier: 2,
  outputMultiplier: 1.5,
} as const;

const GPT56_SOURCE = "developers.openai.com/api/docs/pricing (gpt-5.6 family, standard tier)";
const GPT6_ASTRA_SOURCE = "developers.openai.com/api/docs/pricing (gpt-6-astra, standard tier)";

// One entry for a model on the gpt-5.6 pricing mechanics (the 5.6 family and gpt-6-astra): rates
// in USD-per-1M for legibility, converted once. Cache writes bill at 1.25x the uncached input rate
// (`cache_write_tokens`, prompt-caching guide), and the 272K long-context tier applies. The
// built-in `computer` tool has no per-call fee on the live sheet.
function rateWithLongContextTier(
  inPer1M: number,
  cachedPer1M: number,
  writePer1M: number,
  outPer1M: number,
  asOf: string = "2026-08-18",
  source: string = GPT56_SOURCE,
): ModelRate {
  return {
    inputUsdPerToken: inPer1M * 1e-6,
    cachedInputUsdPerToken: cachedPer1M * 1e-6,
    cacheWriteUsdPerToken: writePer1M * 1e-6,
    outputUsdPerToken: outPer1M * 1e-6,
    longContext: { ...LONG_CONTEXT_TIER_272K },
    asOf,
    source,
  };
}

// gpt-5.6-sol promotional rates (live sheet 2026-09-03: $4 / $0.40 cached / $5 write / $20 out,
// "available at least through November 21, 2026"). Re-verify against the sheet after Nov 21.
const GPT56_SOL_PROMO_AS_OF = "2026-09-03";
const GPT6_ASTRA_AS_OF = "2026-09-03";

// Per-model rates, keyed on the model id that lands in trace.ids.model (lookup is
// case-insensitive on a trimmed id). An id missing here is declared absent, never guessed.
export const MODEL_RATES: Record<string, ModelRate> = {
  // OpenAI computer-use-preview (the classic CUA model). ~$3 / 1M input, ~$12 / 1M output.
  // source: openai.com/api/pricing (verify: providers change without notice).
  "computer-use-preview": {
    inputUsdPerToken: 3e-6,
    outputUsdPerToken: 12e-6,
    asOf: "2026-08-01",
    source: "openai.com/api/pricing (computer-use-preview)",
  },
  // gpt-5.5: the previous-generation CUA default, kept so pinned labs and old bundles still
  // price. Pre-5.6 models bill no cache-write fee (prompt-caching guide) and no long-context
  // tier was published for it.
  "gpt-5.5": {
    inputUsdPerToken: 5e-6,
    outputUsdPerToken: 30e-6,
    cachedInputUsdPerToken: 0.5e-6,
    asOf: "2026-08-05",
    source: "openrouter.ai/openai/gpt-5.5 (gpt-5.5 no longer on openai.com/api/pricing; see #334)",
  },
  // The gpt-5.6 family (live sheet 2026-08-18, standard tier, short-context base rates;
  // the longContext block prices the >272K re-tier when per-request turns are recorded).
  // sol = flagship (the shipped CUA default), terra = cost-balanced, luna = high-volume,
  // cyber = the Daybreak frontier tier.
  "gpt-5.6-sol": rateWithLongContextTier(4, 0.4, 5, 20, GPT56_SOL_PROMO_AS_OF),
  // "gpt-5.6" is OpenAI's own alias for gpt-5.6-sol (models index); priced identically so a
  // lab configured with the alias never reads as unpriced.
  "gpt-5.6": rateWithLongContextTier(4, 0.4, 5, 20, GPT56_SOL_PROMO_AS_OF),
  "gpt-5.6-terra": rateWithLongContextTier(2, 0.2, 2.5, 12),
  "gpt-5.6-luna": rateWithLongContextTier(0.2, 0.02, 0.25, 1.2),
  "gpt-5.6-cyber": rateWithLongContextTier(12.5, 1.25, 15.625, 75),
  // Daybreak program aliases (blue -> sol, red -> cyber today). OpenAI repoints these as new
  // frontier models ship, so prefer the explicit tier id in labs; the entries exist so a
  // configured alias still prices at what the alias bills today.
  "daybreak-blue-latest": rateWithLongContextTier(4, 0.4, 5, 20, GPT56_SOL_PROMO_AS_OF),
  "daybreak-red-latest": rateWithLongContextTier(12.5, 1.25, 15.625, 75),
  // gpt-6-astra (shipped 2026-09-03; API access announced as rolling out). Same two mechanics
  // as the 5.6 family on the sheet: writes at 1.25x, >272K re-tiers at 2x input-side / 1.5x
  // output ($20 / $2 / $25 / $75 long-context columns). These rates cover explicit lab
  // model choices and the study-analysis default; the computer-use default is separate.
  "gpt-6-astra": rateWithLongContextTier(10, 1, 12.5, 50, GPT6_ASTRA_AS_OF, GPT6_ASTRA_SOURCE),
};

// Current public incremental running-compute rates. Subscription fees/credits, negotiated
// enterprise prices, and unobserved allocation/startup time are outside this estimate.
const DESKTOP_RESOURCE_RATE: DesktopResourceRate = {
  usdPerCpuSecond: 0.000014,
  usdPerGiBSecond: 0.0000045,
  asOf: "2026-09-05",
  // A source label rather than an executable URL; runtime URL redaction protects E2B streams.
  source: "e2b.dev/pricing",
};

// Planning assumption behind the public estimateDesktopCost helper: stock desktops observed on
// 2026-09-05 had 8 vCPU / 8 GiB. This is the largest CPU/RAM combination on that public sheet, not
// a provider billing ceiling or a claim about custom/enterprise templates. Runtime CUA estimates
// use observed allocation resources through estimateAllocatedDesktopCost instead of this fallback.
export const DESKTOP_RATE: DesktopRate = {
  usdPerMinute: 0.00888,
  asOf: "2026-09-05",
  source: "e2b.dev/pricing (planning assumption: 8 vCPU / 8 GiB; not an observed allocation)",
  placeholder: true,
};

export function isDesktopResources(value: unknown): value is DesktopResources {
  if (value === null || typeof value !== "object") return false;
  const resources = value as DesktopResources;
  return (
    Number.isSafeInteger(resources.cpuCount) &&
    resources.cpuCount > 0 &&
    Number.isSafeInteger(resources.memoryMiB) &&
    resources.memoryMiB > 0
  );
}

/** Price one observed allocation. Missing quantities/rates stay unknown, never a stock guess. */
export function estimateAllocatedDesktopCost(
  minutes: number | undefined,
  resources: DesktopResources | undefined,
  rate: DesktopResourceRate = DESKTOP_RESOURCE_RATE,
): DesktopCostEstimate {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) {
    return { estimatedCostUsd: null, reason: "no_duration", ratesAsOf: null, minutes: null };
  }
  if (!isDesktopResources(resources)) {
    return {
      estimatedCostUsd: null,
      reason: "no_desktop_resources",
      ratesAsOf: null,
      minutes: round6(minutes),
    };
  }
  // The public Hobby/Pro sheet stops at 8 CPU / 8 GiB; larger allocations may have negotiated
  // prices. Retain the resource evidence without extrapolating a standard rate to them.
  if (
    ![1, 2, 4, 6, 8].includes(resources.cpuCount) ||
    resources.memoryMiB < 512 ||
    resources.memoryMiB > 8192 ||
    !Number.isFinite(rate.usdPerCpuSecond) ||
    rate.usdPerCpuSecond < 0 ||
    !Number.isFinite(rate.usdPerGiBSecond) ||
    rate.usdPerGiBSecond < 0
  ) {
    return {
      estimatedCostUsd: null,
      reason: "no_rate_for_desktop",
      ratesAsOf: null,
      minutes: round6(minutes),
      resources,
    };
  }
  const usdPerSecond =
    resources.cpuCount * rate.usdPerCpuSecond + (resources.memoryMiB / 1024) * rate.usdPerGiBSecond;
  return {
    estimatedCostUsd: round6(minutes * 60 * usdPerSecond),
    ratesAsOf: rate.asOf,
    source: rate.source,
    minutes: round6(minutes),
    resources,
    usdPerSecond,
  };
}

/** Round a USD figure to 6 decimals so a float-accumulated total never carries spurious
 *  precision. */
export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Estimate one actor trace's model-token cost from its trace tokenUsage + model id. Deterministic;
 * the rate table is injectable (tests pass a fake sheet). Returns a declared-absent estimate
 * (estimatedCostUsd: null + a reason) for a missing rate or missing usage, never a guessed cost.
 */
export function estimateActorCostForExecution(
  usage: ActorTokenUsage | undefined,
  modelId: string | undefined,
  profile?: { billing?: unknown },
): ActorEstimatedCost {
  return profile?.billing === "account-unknown"
    ? {
        schema: ACTOR_ESTIMATED_COST_SCHEMA,
        estimatedCostUsd: null,
        ratesAsOf: null,
        reason: "account_billing_unknown",
        ...(modelId === undefined ? {} : { modelId }),
      }
    : estimateActorCost(usage, modelId);
}

/**
 * Price usage reported as runtime-turn totals, such as Codex `turn.completed`, which sums every
 * request in the turn. Pricing a turn as one request would apply the long-context tier to the
 * whole turn, so the per-turn records are dropped and the totals price on the base tier.
 */
export function estimateAggregatedTurnCost(
  tokenUsage: ActorTokenUsage | undefined,
  modelId: string | undefined,
): ActorEstimatedCost {
  const { turns: _turns, ...totals } = tokenUsage ?? {};
  const estimate = estimateActorCost(tokenUsage === undefined ? undefined : totals, modelId);
  return estimate.estimatedCostUsd === null
    ? estimate
    : { ...estimate, basis: "aggregated_turns_base_rate" };
}

export function estimateActorCost(
  tokenUsage: ActorTokenUsage | undefined,
  modelId: string | undefined,
  rates: Record<string, ModelRate> = MODEL_RATES,
): ActorEstimatedCost {
  if (!tokenUsage || (tokenUsage.input === undefined && tokenUsage.output === undefined)) {
    return {
      schema: ACTOR_ESTIMATED_COST_SCHEMA,
      estimatedCostUsd: null,
      reason: "no_token_usage",
      ratesAsOf: null,
    };
  }
  const rate = modelId ? rates[modelId.trim().toLowerCase()] : undefined;
  if (!rate) {
    return {
      schema: ACTOR_ESTIMATED_COST_SCHEMA,
      estimatedCostUsd: null,
      reason: "no_rate_for_model",
      ratesAsOf: null,
      ...(modelId ? { modelId } : {}),
    };
  }
  const inTok = tokenUsage.input ?? 0;
  const outTok = tokenUsage.output ?? 0;
  // Long-context tiering needs to know each request's input size (the provider re-prices whole
  // requests past the threshold), so it engages only when per-turn usage records exist and their
  // input sums to the reported total, because a partial turn ledger must not silently price the missing
  // remainder at the wrong tier. Otherwise totals price on the base (short-context) rate, which is
  // the under-estimate direction and never trips a cap early.
  const turns = tokenUsage.turns ?? [];
  const sumOf = (field: "input" | "output" | "cachedInput" | "cacheWriteInput"): number =>
    turns.reduce((sum, turn) => sum + (turn[field] ?? 0), 0);
  // The ledger is trusted only when it decomposes the totals exactly, in all four sums including the
  // cache splits. A ledger that carries request sizes but not the cache splits would otherwise
  // price every token at the full rate while the session totals sit ignored, overstating spend
  // 3.5-5x and tripping caps early. Inconsistent evidence falls back to the totals path, which
  // honors the declared splits on the base tier.
  const tiered =
    rate.longContext !== undefined &&
    turns.length > 0 &&
    sumOf("input") === inTok &&
    sumOf("output") === outTok &&
    sumOf("cachedInput") === (tokenUsage.cachedInput ?? 0) &&
    sumOf("cacheWriteInput") === (tokenUsage.cacheWriteInput ?? 0);

  let inputUsd = 0;
  let outputUsd = 0;
  let cachedTotal = 0;
  let writeTotal = 0;
  let longContextTurns = 0;

  // Price one request's usage at one tier. Cached input is billed at a fraction of the full rate,
  // and on a session that threads provider state it is the majority of input, and pricing it at the
  // full rate overstates real spend by up to ~10x. Cache writes bill at their own rate (1.25x on
  // OpenAI 5.6+) as the total rate for those tokens; a sheet without a write rate prices writes as
  // plain input (pre-5.6: writes are free-of-extra-fee, i.e. plain input). Every piece is honestly
  // absent: no reported split means no discount and no surcharge assumed.
  const priceRequest = (
    usage: { input?: number; cachedInput?: number; cacheWriteInput?: number; output?: number },
    tierable: boolean,
  ): void => {
    const reqIn = usage.input ?? 0;
    const reqOut = usage.output ?? 0;
    // Tiering applies only to a real per-request record: session totals crossing the threshold
    // say nothing about any single request, so totals always price on the base tier.
    const long =
      tierable && rate.longContext !== undefined && reqIn > rate.longContext.thresholdInputTokens;
    const inMul = long ? rate.longContext!.inputMultiplier : 1;
    const outMul = long ? rate.longContext!.outputMultiplier : 1;
    if (long) longContextTurns += 1;
    const cached =
      rate.cachedInputUsdPerToken === undefined
        ? 0
        : Math.min(reqIn, Math.max(0, usage.cachedInput ?? 0));
    const writes = Math.min(reqIn - cached, Math.max(0, usage.cacheWriteInput ?? 0));
    const full = reqIn - cached - writes;
    cachedTotal += cached;
    writeTotal += writes;
    inputUsd +=
      full * rate.inputUsdPerToken * inMul +
      cached * (rate.cachedInputUsdPerToken ?? 0) * inMul +
      writes * (rate.cacheWriteUsdPerToken ?? rate.inputUsdPerToken) * inMul;
    outputUsd += reqOut * rate.outputUsdPerToken * outMul;
  };

  if (tiered) {
    for (const turn of turns) priceRequest(turn, true);
  } else {
    priceRequest(
      {
        input: inTok,
        output: outTok,
        ...(tokenUsage.cachedInput === undefined ? {} : { cachedInput: tokenUsage.cachedInput }),
        ...(tokenUsage.cacheWriteInput === undefined
          ? {}
          : { cacheWriteInput: tokenUsage.cacheWriteInput }),
      },
      false,
    );
  }

  inputUsd = round6(inputUsd);
  outputUsd = round6(outputUsd);
  return {
    schema: ACTOR_ESTIMATED_COST_SCHEMA,
    estimatedCostUsd: round6(inputUsd + outputUsd),
    ratesAsOf: rate.asOf,
    source: rate.source,
    ...(modelId ? { modelId } : {}),
    ...(rate.placeholder ? { placeholder: true } : {}),
    breakdown: {
      inputUsd,
      outputUsd,
      inputTokens: inTok,
      outputTokens: outTok,
      ...(cachedTotal > 0 ? { cachedInputTokens: cachedTotal } : {}),
      ...(writeTotal > 0 ? { cacheWriteInputTokens: writeTotal } : {}),
      ...(longContextTurns > 0 ? { longContextTurns } : {}),
    },
  };
}

/**
 * Estimate the E2B desktop-minute cost from a host-side create->teardown span (minutes). The rate
 * is injectable. Returns a declared-absent estimate (null + "no_duration") when no duration was
 * measured (no sandbox / unmeasurable span), never a guessed 0.
 */
export function estimateDesktopCost(
  minutes: number | undefined,
  rate: DesktopRate = DESKTOP_RATE,
): DesktopCostEstimate {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) {
    return { estimatedCostUsd: null, reason: "no_duration", ratesAsOf: null, minutes: null };
  }
  return {
    estimatedCostUsd: round6(minutes * rate.usdPerMinute),
    ratesAsOf: rate.asOf,
    source: rate.source,
    minutes: round6(minutes),
    ...(rate.placeholder ? { placeholder: true } : {}),
  };
}
