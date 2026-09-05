import { describe, expect, it } from "vitest";

import {
  ACTOR_ESTIMATED_COST_SCHEMA,
  DESKTOP_RATE,
  MODEL_RATES,
  PRICING_SCHEMA,
  estimateActorCost,
  estimateDesktopCost,
  round6,
  type DesktopRate,
  type ModelRate
} from "../src/pricing.js";

// A fake sheet so every assertion is driven by injected numbers, never the live table.
const FAKE_RATES: Record<string, ModelRate> = {
  "test-model": {
    inputUsdPerToken: 2e-6,
    outputUsdPerToken: 5e-6,
    asOf: "2024-01-01",
    source: "fake-sheet://test-model"
  },
  "placeholder-model": {
    inputUsdPerToken: 1e-6,
    outputUsdPerToken: 1e-6,
    asOf: "2024-02-02",
    source: "fake-sheet://placeholder",
    placeholder: true
  }
};
const FAKE_DESKTOP: DesktopRate = { usdPerMinute: 0.01, asOf: "2024-03-03", source: "fake-sheet://desktop" };

describe("pricing schema constants", () => {
  it("names both schema tags at v1", () => {
    expect(PRICING_SCHEMA).toBe("humanish.pricing.v1");
    expect(ACTOR_ESTIMATED_COST_SCHEMA).toBe("humanish.actor-estimated-cost.v1");
  });

  it("keeps the shipped rate table keyed lowercase with the CUA default present", () => {
    // The shipped default resolves to gpt-5.6-sol (DEFAULT_OPENAI_CU_MODEL); it must be priceable
    // so a capped run is not refused by default. The 5.6-family rates are confirmed against
    // OpenAI's live sheet (#334); the previous-generation gpt-5.5 entry stays for pinned labs;
    // the legacy desktop helper remains a labeled planning assumption, distinct from observed rates.
    expect(MODEL_RATES["gpt-5.6-sol"]?.placeholder).toBeUndefined();
    // OpenAI's own alias for sol must price identically so an alias-configured lab is never unpriced.
    expect(MODEL_RATES["gpt-5.6"]).toEqual(MODEL_RATES["gpt-5.6-sol"]);
    expect(MODEL_RATES["gpt-5.6-terra"]?.placeholder).toBeUndefined();
    expect(MODEL_RATES["gpt-5.6-luna"]?.placeholder).toBeUndefined();
    expect(MODEL_RATES["gpt-5.5"]?.placeholder).toBeUndefined();
    expect(MODEL_RATES["computer-use-preview"]?.placeholder).toBeUndefined();
    expect(DESKTOP_RATE.placeholder).toBe(true);
    for (const key of Object.keys(MODEL_RATES)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});

describe("estimateActorCost", () => {
  it("computes an EXACT rate-table multiply for a known model and carries provenance + breakdown", () => {
    const est = estimateActorCost({ input: 1000, output: 200 }, "test-model", FAKE_RATES);
    const inputUsd = round6(1000 * 2e-6);
    const outputUsd = round6(200 * 5e-6);
    expect(est.schema).toBe("humanish.actor-estimated-cost.v1");
    expect(est.estimatedCostUsd).toBe(round6(inputUsd + outputUsd));
    expect(est.ratesAsOf).toBe("2024-01-01");
    expect(est.source).toBe("fake-sheet://test-model");
    expect(est.modelId).toBe("test-model");
    expect(est.reason).toBeUndefined();
    expect(est.breakdown).toEqual({ inputUsd, outputUsd, inputTokens: 1000, outputTokens: 200 });
  });

  it("is case-insensitive and trims the model id before lookup", () => {
    const est = estimateActorCost({ input: 10, output: 0 }, "  TEST-Model ", FAKE_RATES);
    expect(est.estimatedCostUsd).toBe(round6(10 * 2e-6));
    expect(est.ratesAsOf).toBe("2024-01-01");
  });

  it("DECLARES ABSENT (null + no_rate_for_model) for an unknown model — never a guessed cost", () => {
    const est = estimateActorCost({ input: 1000, output: 200 }, "no-such-model", FAKE_RATES);
    expect(est.estimatedCostUsd).toBeNull();
    expect(est.reason).toBe("no_rate_for_model");
    expect(est.ratesAsOf).toBeNull();
    expect(est.source).toBeUndefined();
    expect(est.modelId).toBe("no-such-model");
  });

  it("DECLARES ABSENT (null + no_token_usage) for undefined or empty token usage", () => {
    for (const usage of [undefined, {}, { total: 5 } as const]) {
      const est = estimateActorCost(usage, "test-model", FAKE_RATES);
      expect(est.estimatedCostUsd).toBeNull();
      expect(est.reason).toBe("no_token_usage");
      expect(est.ratesAsOf).toBeNull();
    }
  });

  it("propagates the placeholder flag from the rate into the estimate", () => {
    const est = estimateActorCost({ input: 5, output: 5 }, "placeholder-model", FAKE_RATES);
    expect(est.placeholder).toBe(true);
    expect(est.estimatedCostUsd).toBe(round6(5 * 1e-6 + 5 * 1e-6));
    const known = estimateActorCost({ input: 5, output: 5 }, "test-model", FAKE_RATES);
    expect(known.placeholder).toBeUndefined();
  });

  it("treats a missing input or output token count as 0 (not absent) when the other is present", () => {
    const est = estimateActorCost({ input: 100 }, "test-model", FAKE_RATES);
    expect(est.estimatedCostUsd).toBe(round6(100 * 2e-6));
    expect(est.breakdown).toEqual({ inputUsd: round6(100 * 2e-6), outputUsd: 0, inputTokens: 100, outputTokens: 0 });
  });
});

describe("estimateActorCost: cached input (#391)", () => {
  // The bug this pins: every input token was billed at the full rate, and the provider's
  // cached-token count was not even parsed. The CUA loop threads state through the provider and
  // re-sends a growing warm prefix every turn, so most input on a long session is a cache hit. A
  // live two-lane run read $5.14 per lane and aborted itself against its own $5 cap — for spend it
  // very likely never incurred.
  const rate = {
    inputUsdPerToken: 5e-6,
    outputUsdPerToken: 30e-6,
    cachedInputUsdPerToken: 0.5e-6,
    asOf: "2026-08-08",
    source: "test"
  };
  const rates = { "test-model": rate };

  it("bills cached input at the cached rate and the remainder at full rate", () => {
    const cost = estimateActorCost({ input: 1_000_000, output: 0, cachedInput: 900_000 }, "test-model", rates);
    // 100k full at $5/1M = $0.50, 900k cached at $0.50/1M = $0.45
    expect(cost.estimatedCostUsd).toBeCloseTo(0.95, 6);
    expect(cost.breakdown?.cachedInputTokens).toBe(900_000);
  });

  it("prices exactly as before when the provider reports no cached count", () => {
    const withCache = estimateActorCost({ input: 1_000_000, output: 0, cachedInput: 0 }, "test-model", rates);
    const silent = estimateActorCost({ input: 1_000_000, output: 0 }, "test-model", rates);
    expect(silent.estimatedCostUsd).toBe(5);
    expect(withCache.estimatedCostUsd).toBe(5);
    // Absent means absent — never reported as an observed zero.
    expect(silent.breakdown?.cachedInputTokens).toBeUndefined();
  });

  it("prices as before when the rate sheet models no cached rate", () => {
    const { cachedInputUsdPerToken: _omitted, ...rateWithoutCachedField } = rate;
    const noCachedRate = { "test-model": rateWithoutCachedField };
    const cost = estimateActorCost({ input: 1_000_000, output: 0, cachedInput: 900_000 }, "test-model", noCachedRate);
    expect(cost.estimatedCostUsd).toBe(5);
  });

  it("never lets a bogus cached count exceed the input it came from", () => {
    const cost = estimateActorCost({ input: 1000, output: 0, cachedInput: 999_999 }, "test-model", rates);
    // Clamped to `input`, so the estimate can never go negative or below the cached floor.
    expect(cost.estimatedCostUsd).toBeCloseTo(1000 * 0.5e-6, 9);
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("reprices the live run that aborted itself against its own cap", () => {
    // Actual tokenUsage from cua-2026-08-08T07-38-10-148Z-ad382d8b, expert lane.
    const metered = estimateActorCost({ input: 1_008_579, output: 3_388 }, "gpt-5.5");
    expect(metered.estimatedCostUsd).toBeCloseTo(5.144535, 6); // what killed the run

    const withCache = estimateActorCost({ input: 1_008_579, output: 3_388, cachedInput: 907_721 }, "gpt-5.5");
    expect(withCache.estimatedCostUsd).toBeLessThan(1.5); // ~90% cache hits
  });
});

describe("estimateDesktopCost", () => {
  it("computes minutes * usdPerMinute rounded, with provenance", () => {
    const est = estimateDesktopCost(3, FAKE_DESKTOP);
    expect(est.estimatedCostUsd).toBe(round6(3 * 0.01));
    expect(est.ratesAsOf).toBe("2024-03-03");
    expect(est.source).toBe("fake-sheet://desktop");
    expect(est.minutes).toBe(3);
  });

  it("DECLARES ABSENT for undefined, NaN, or negative minutes", () => {
    for (const minutes of [undefined, Number.NaN, -1]) {
      const est = estimateDesktopCost(minutes, FAKE_DESKTOP);
      expect(est.estimatedCostUsd).toBeNull();
      expect(est.reason).toBe("no_duration");
      expect(est.ratesAsOf).toBeNull();
      expect(est.minutes).toBeNull();
    }
  });

  it("propagates the desktop placeholder flag", () => {
    const est = estimateDesktopCost(2, { ...FAKE_DESKTOP, placeholder: true });
    expect(est.placeholder).toBe(true);
  });
});

describe("round6", () => {
  it("kills float accumulation drift", () => {
    // 0.1 + 0.2 = 0.30000000000000004; the ledger must not carry that spurious tail.
    expect(round6(0.1 + 0.2)).toBe(0.3);
    expect(round6(11.535069 + 0.070428)).toBe(11.605497);
  });
});

describe("estimateActorCost: cache writes + long-context tiering (#334)", () => {
  // The two billing mechanics gpt-5.6 introduced, pinned with a fake sheet mirroring its shape:
  // writes bill at their own (1.25x) rate as the TOTAL rate for written tokens, and a request
  // whose input crosses the threshold re-tiers the WHOLE request (2x input-side, 1.5x output).
  const rate: ModelRate = {
    inputUsdPerToken: 4e-6,
    cachedInputUsdPerToken: 0.4e-6,
    cacheWriteUsdPerToken: 5e-6,
    outputUsdPerToken: 10e-6,
    longContext: { thresholdInputTokens: 1000, inputMultiplier: 2, outputMultiplier: 1.5 },
    asOf: "2026-08-18",
    source: "fake-sheet://tiered"
  };
  const rates = { "tiered-model": rate };

  it("bills cache writes at the write rate, as the total rate for those tokens", () => {
    const cost = estimateActorCost({ input: 1000, output: 0, cacheWriteInput: 400 }, "tiered-model", rates);
    // 600 full at 4e-6 + 400 written at 5e-6 = 0.0024 + 0.0020 = 0.0044.
    expect(cost.estimatedCostUsd).toBeCloseTo(0.0044, 6);
    expect(cost.breakdown?.cacheWriteInputTokens).toBe(400);
  });

  it("prices writes as plain input when the sheet has no write rate (pre-5.6 models)", () => {
    const { cacheWriteUsdPerToken: _omitted, longContext: _lc, ...plain } = rate;
    const cost = estimateActorCost({ input: 1000, output: 0, cacheWriteInput: 400 }, "tiered-model", { "tiered-model": plain });
    expect(cost.estimatedCostUsd).toBeCloseTo(0.004, 6);
  });

  it("re-tiers only the requests that crossed the threshold, from the per-request turns ledger", () => {
    const cost = estimateActorCost(
      {
        input: 1500,
        output: 30,
        cachedInput: 500,
        turns: [
          { input: 300, output: 10 }, // short: 300*4e-6 + 10*10e-6 = 0.0013
          { input: 1200, cachedInput: 500, output: 20 } // long: (700*4e-6 + 500*0.4e-6)*2 + 20*10e-6*1.5 = 0.0063
        ]
      },
      "tiered-model",
      rates
    );
    expect(cost.estimatedCostUsd).toBeCloseTo(0.0013 + 0.0063, 6);
    expect(cost.breakdown?.longContextTurns).toBe(1);
  });

  it("refuses to tier when the ledger omits the cache splits the totals declare (red-team)", () => {
    // input/output sums match but the ledger carries no cachedInput — trusting it would price
    // 400k cache hits at the full rate (3.5x overstatement, the #391 false-cap-trip direction).
    const cost = estimateActorCost(
      { input: 1500, output: 30, cachedInput: 1000, turns: [{ input: 700, output: 10 }, { input: 800, output: 20 }] },
      "tiered-model",
      rates
    );
    // Totals path, base tier, split honored: 500 full + 1000 cached.
    expect(cost.estimatedCostUsd).toBeCloseTo(500 * 4e-6 + 1000 * 0.4e-6 + 30 * 10e-6, 6);
    expect(cost.breakdown?.cachedInputTokens).toBe(1000);
    expect(cost.breakdown?.longContextTurns).toBeUndefined();
  });

  it("refuses to tier when the ledger omits the cache WRITES the totals declare (red-team)", () => {
    const cost = estimateActorCost(
      { input: 1500, output: 0, cacheWriteInput: 400, turns: [{ input: 700 }, { input: 800 }] },
      "tiered-model",
      rates
    );
    expect(cost.estimatedCostUsd).toBeCloseTo(1100 * 4e-6 + 400 * 5e-6, 6);
    expect(cost.breakdown?.cacheWriteInputTokens).toBe(400);
  });

  it("refuses to tier from a partial turns ledger — totals price on the base rate instead", () => {
    // The ledger claims less input than the totals report: tiering from it would price the
    // missing remainder at a guessed tier. The estimate falls back to the base-rate totals path.
    const cost = estimateActorCost(
      { input: 2000, output: 0, turns: [{ input: 300, output: 0 }] },
      "tiered-model",
      rates
    );
    expect(cost.estimatedCostUsd).toBeCloseTo(2000 * 4e-6, 6);
    expect(cost.breakdown?.longContextTurns).toBeUndefined();
  });

  it("never re-tiers on totals alone, even past the threshold (under-estimate direction)", () => {
    const cost = estimateActorCost({ input: 5000, output: 100 }, "tiered-model", rates);
    expect(cost.estimatedCostUsd).toBeCloseTo(5000 * 4e-6 + 100 * 10e-6, 6);
    expect(cost.breakdown?.longContextTurns).toBeUndefined();
  });
});
