import { describe, expect, it } from "vitest";

import {
  ACTOR_ESTIMATED_COST_SCHEMA,
  DESKTOP_RATE,
  MODEL_RATES,
  PRICING_SCHEMA,
  estimateActorCost,
  estimateAggregatedTurnCost,
  estimateDesktopCost,
  participantRate,
  round6,
  unpricedCapMessage,
  type DesktopRate,
  type ModelRate,
} from "../../src/run/pricing.js";

// A fake sheet so every assertion is driven by injected numbers, never the live table.
const FAKE_RATES: Record<string, ModelRate> = {
  "test-model": {
    inputUsdPerToken: 2e-6,
    outputUsdPerToken: 5e-6,
    asOf: "2024-01-01",
    source: "fake-sheet://test-model",
  },
  "placeholder-model": {
    inputUsdPerToken: 1e-6,
    outputUsdPerToken: 1e-6,
    asOf: "2024-02-02",
    source: "fake-sheet://placeholder",
    placeholder: true,
  },
};
const FAKE_DESKTOP: DesktopRate = {
  usdPerMinute: 0.01,
  asOf: "2024-03-03",
  source: "fake-sheet://desktop",
};

describe("pricing schema constants", () => {
  it("names both schema tags at v1", () => {
    expect(PRICING_SCHEMA).toBe("humanish.pricing.v1");
    expect(ACTOR_ESTIMATED_COST_SCHEMA).toBe("humanish.actor-estimated-cost.v1");
  });

  it("keeps the shipped rate table keyed lowercase with the CUA default present", () => {
    // The shipped default resolves to gpt-5.6-sol (DEFAULT_OPENAI_CU_MODEL); it must be priceable
    // so a capped run is not refused by default. The 5.6-family rates are confirmed against
    // OpenAI's live sheet; the previous-generation gpt-5.5 entry stays for pinned studies;
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
  it("computes an exact rate-table multiply for a known model and carries provenance + breakdown", () => {
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

  it("declares absent (null + no_rate_for_model) for an unknown model, never a guessed cost", () => {
    const est = estimateActorCost({ input: 1000, output: 200 }, "no-such-model", FAKE_RATES);
    expect(est.estimatedCostUsd).toBeNull();
    expect(est.reason).toBe("no_rate_for_model");
    expect(est.ratesAsOf).toBeNull();
    expect(est.source).toBeUndefined();
    expect(est.modelId).toBe("no-such-model");
  });

  it("declares absent (null + no_token_usage) for undefined or empty token usage", () => {
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
    expect(est.breakdown).toEqual({
      inputUsd: round6(100 * 2e-6),
      outputUsd: 0,
      inputTokens: 100,
      outputTokens: 0,
    });
  });
});

describe("estimateActorCost: cached input", () => {
  // The bug this pins: every input token was billed at the full rate, and the provider's
  // cached-token count was not even parsed. The CUA loop threads state through the provider and
  // re-sends a growing warm prefix every turn, so most input on a long session is a cache hit. A
  // live two-participant run read $5.14 per participant and aborted itself against its own $5 cap:
  // for spend it very likely never incurred.
  const rate = {
    inputUsdPerToken: 5e-6,
    outputUsdPerToken: 30e-6,
    cachedInputUsdPerToken: 0.5e-6,
    asOf: "2026-08-08",
    source: "test",
  };
  const rates = { "test-model": rate };

  it("bills cached input at the cached rate and the remainder at full rate", () => {
    const cost = estimateActorCost(
      { input: 1_000_000, output: 0, cachedInput: 900_000 },
      "test-model",
      rates,
    );
    // 100k full at $5/1M = $0.50, 900k cached at $0.50/1M = $0.45
    expect(cost.estimatedCostUsd).toBeCloseTo(0.95, 6);
    expect(cost.breakdown?.cachedInputTokens).toBe(900_000);
  });

  it("prices exactly as before when the provider reports no cached count", () => {
    const withCache = estimateActorCost(
      { input: 1_000_000, output: 0, cachedInput: 0 },
      "test-model",
      rates,
    );
    const silent = estimateActorCost({ input: 1_000_000, output: 0 }, "test-model", rates);
    expect(silent.estimatedCostUsd).toBe(5);
    expect(withCache.estimatedCostUsd).toBe(5);
    // Absent means absent, never reported as an observed zero.
    expect(silent.breakdown?.cachedInputTokens).toBeUndefined();
  });

  it("prices as before when the rate sheet models no cached rate", () => {
    const { cachedInputUsdPerToken: _omitted, ...rateWithoutCachedField } = rate;
    const noCachedRate = { "test-model": rateWithoutCachedField };
    const cost = estimateActorCost(
      { input: 1_000_000, output: 0, cachedInput: 900_000 },
      "test-model",
      noCachedRate,
    );
    expect(cost.estimatedCostUsd).toBe(5);
  });

  it("never lets a bogus cached count exceed the input it came from", () => {
    const cost = estimateActorCost(
      { input: 1000, output: 0, cachedInput: 999_999 },
      "test-model",
      rates,
    );
    // Clamped to `input`, so the estimate can never go negative or below the cached floor.
    expect(cost.estimatedCostUsd).toBeCloseTo(1000 * 0.5e-6, 9);
    expect(cost.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("reprices the live run that aborted itself against its own cap", () => {
    // Actual tokenUsage from cua-2026-08-08T07-38-10-148Z-ad382d8b, expert participant.
    const metered = estimateActorCost({ input: 1_008_579, output: 3_388 }, "gpt-5.5");
    expect(metered.estimatedCostUsd).toBeCloseTo(5.144535, 6); // what killed the run

    const withCache = estimateActorCost(
      { input: 1_008_579, output: 3_388, cachedInput: 907_721 },
      "gpt-5.5",
    );
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

  it("declares absent for undefined, NaN, or negative minutes", () => {
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

describe("estimateActorCost: cache writes + long-context tiering", () => {
  // The two billing mechanics gpt-5.6 introduced, pinned with a fake sheet mirroring its shape:
  // writes bill at their own (1.25x) rate as the total rate for written tokens, and a request
  // whose input crosses the threshold re-tiers the whole request (2x input-side, 1.5x output).
  const rate: ModelRate = {
    inputUsdPerToken: 4e-6,
    cachedInputUsdPerToken: 0.4e-6,
    cacheWriteUsdPerToken: 5e-6,
    outputUsdPerToken: 10e-6,
    longContext: { thresholdInputTokens: 1000, inputMultiplier: 2, outputMultiplier: 1.5 },
    asOf: "2026-08-18",
    source: "fake-sheet://tiered",
  };
  const rates = { "tiered-model": rate };

  it("bills cache writes at the write rate, as the total rate for those tokens", () => {
    const cost = estimateActorCost(
      { input: 1000, output: 0, cacheWriteInput: 400 },
      "tiered-model",
      rates,
    );
    // 600 full at 4e-6 + 400 written at 5e-6 = 0.0024 + 0.0020 = 0.0044.
    expect(cost.estimatedCostUsd).toBeCloseTo(0.0044, 6);
    expect(cost.breakdown?.cacheWriteInputTokens).toBe(400);
  });

  it("prices writes as plain input when the sheet has no write rate (pre-5.6 models)", () => {
    const { cacheWriteUsdPerToken: _omitted, longContext: _lc, ...plain } = rate;
    const cost = estimateActorCost(
      { input: 1000, output: 0, cacheWriteInput: 400 },
      "tiered-model",
      { "tiered-model": plain },
    );
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
          { input: 1200, cachedInput: 500, output: 20 }, // long: (700*4e-6 + 500*0.4e-6)*2 + 20*10e-6*1.5 = 0.0063
        ],
      },
      "tiered-model",
      rates,
    );
    expect(cost.estimatedCostUsd).toBeCloseTo(0.0013 + 0.0063, 6);
    expect(cost.breakdown?.longContextTurns).toBe(1);
  });

  it("refuses to tier when the ledger omits the cache splits the totals declare", () => {
    // input/output sums match but the ledger carries no cachedInput: trusting it would price
    // 400k cache hits at the full rate (3.5x overstatement, the direction that trips a cap falsely).
    const cost = estimateActorCost(
      {
        input: 1500,
        output: 30,
        cachedInput: 1000,
        turns: [
          { input: 700, output: 10 },
          { input: 800, output: 20 },
        ],
      },
      "tiered-model",
      rates,
    );
    // Totals path, base tier, split honored: 500 full + 1000 cached.
    expect(cost.estimatedCostUsd).toBeCloseTo(500 * 4e-6 + 1000 * 0.4e-6 + 30 * 10e-6, 6);
    expect(cost.breakdown?.cachedInputTokens).toBe(1000);
    expect(cost.breakdown?.longContextTurns).toBeUndefined();
  });

  it("refuses to tier when the ledger omits the cache writes the totals declare", () => {
    const cost = estimateActorCost(
      { input: 1500, output: 0, cacheWriteInput: 400, turns: [{ input: 700 }, { input: 800 }] },
      "tiered-model",
      rates,
    );
    expect(cost.estimatedCostUsd).toBeCloseTo(1100 * 4e-6 + 400 * 5e-6, 6);
    expect(cost.breakdown?.cacheWriteInputTokens).toBe(400);
  });

  it("refuses to tier from a partial turns ledger: totals price on the base rate instead", () => {
    // The ledger claims less input than the totals report: tiering from it would price the
    // missing remainder at a guessed tier. The estimate falls back to the base-rate totals path.
    const cost = estimateActorCost(
      { input: 2000, output: 0, turns: [{ input: 300, output: 0 }] },
      "tiered-model",
      rates,
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

describe("estimateActorCost: Fast mode", () => {
  // A fake sheet with the shape of gpt-5.6-sol's Fast mode: every rate twice the standard one.
  const rate: ModelRate = {
    inputUsdPerToken: 4e-6,
    cachedInputUsdPerToken: 0.4e-6,
    cacheWriteUsdPerToken: 5e-6,
    outputUsdPerToken: 20e-6,
    fast: {
      inputUsdPerToken: 8e-6,
      cachedInputUsdPerToken: 0.8e-6,
      cacheWriteUsdPerToken: 10e-6,
      outputUsdPerToken: 40e-6,
    },
    longContext: { thresholdInputTokens: 1000, inputMultiplier: 2, outputMultiplier: 1.5 },
    asOf: "2026-10-24",
    source: "fake-sheet://fast",
  };
  const rates = { "fast-model": rate };

  it("prices each request at the tier the provider served it at", () => {
    const cost = estimateActorCost(
      {
        input: 600,
        output: 20,
        cachedInput: 200,
        turns: [
          { input: 300, cachedInput: 100, output: 10, serviceTier: "priority" },
          { input: 300, cachedInput: 100, output: 10, serviceTier: "default" },
        ],
      },
      "fast-model",
      rates,
    );
    // Fast: 200*8e-6 + 100*0.8e-6 + 10*40e-6 = 0.00208. Standard: 200*4e-6 + 100*0.4e-6 + 10*20e-6 = 0.00104.
    expect(cost.estimatedCostUsd).toBeCloseTo(0.00312, 6);
    expect(cost.breakdown?.fastTurns).toBe(1);
  });

  it("applies the long-context tier on top of the fast rate", () => {
    const cost = estimateActorCost(
      { input: 1200, output: 10, turns: [{ input: 1200, output: 10, serviceTier: "fast" }] },
      "fast-model",
      rates,
    );
    // 1200*8e-6*2 + 10*40e-6*1.5 = 0.0192 + 0.0006.
    expect(cost.estimatedCostUsd).toBeCloseTo(0.0198, 6);
  });

  it("prices totals at the fast rate when a request was served fast and the ledger does not add up", () => {
    const cost = estimateActorCost(
      { input: 1000, output: 10, turns: [{ input: 400, output: 10, serviceTier: "fast" }] },
      "fast-model",
      rates,
    );
    expect(cost.estimatedCostUsd).toBeCloseTo(1000 * 8e-6 + 10 * 40e-6, 6);
  });

  it("declares a fast request on a model with no fast rate unpriced", () => {
    const { fast: _fast, ...standard } = rate;
    const cost = estimateActorCost(
      { input: 300, output: 10, turns: [{ input: 300, output: 10, serviceTier: "fast" }] },
      "fast-model",
      { "fast-model": standard },
    );
    expect(cost.estimatedCostUsd).toBeNull();
    expect(cost.reason).toBe("no_rate_for_model");
  });

  it("prices gpt-5.6-sol Fast mode at twice its standard rate", () => {
    const usage = { input: 1000, output: 100, turns: [{ input: 1000, output: 100 }] };
    const fastUsage = { ...usage, turns: [{ ...usage.turns[0]!, serviceTier: "priority" }] };
    const standard = estimateActorCost(usage, "gpt-5.6-sol").estimatedCostUsd!;
    expect(estimateActorCost(fastUsage, "gpt-5.6-sol").estimatedCostUsd).toBeCloseTo(
      standard * 2,
      9,
    );
  });
});

describe("estimateAggregatedTurnCost", () => {
  // Codex turn.completed usage from a 0.107.0 live terminal run: one turn summing every request.
  const turn = { input: 294_603, cachedInput: 262_238, cacheWriteInput: 32_329, output: 1_526 };
  const usage = { ...turn, total: turn.input + turn.output, turns: [turn] };

  it("prices a 294k aggregated turn at base rates and labels the estimate", () => {
    const rate = MODEL_RATES["gpt-5.6-sol"]!;
    const full = turn.input - turn.cachedInput - turn.cacheWriteInput;
    const estimate = estimateAggregatedTurnCost(usage, "gpt-5.6-sol");
    expect(estimate).toMatchObject({
      modelId: "gpt-5.6-sol",
      basis: "aggregated_turns_base_rate",
      ratesAsOf: rate.asOf,
      source: rate.source,
    });
    expect(estimate.breakdown).toEqual({
      inputUsd: round6(
        full * rate.inputUsdPerToken +
          turn.cachedInput * rate.cachedInputUsdPerToken! +
          turn.cacheWriteInput * rate.cacheWriteUsdPerToken!,
      ),
      outputUsd: round6(turn.output * rate.outputUsdPerToken),
      inputTokens: turn.input,
      outputTokens: turn.output,
      cachedInputTokens: turn.cachedInput,
      cacheWriteInputTokens: turn.cacheWriteInput,
    });
    // Read as one request, the same turn crosses the long-context threshold and doubles.
    const asOneRequest = estimateActorCost(usage, "gpt-5.6-sol");
    expect(asOneRequest.breakdown?.longContextTurns).toBe(1);
    expect(estimate.estimatedCostUsd!).toBeLessThan(asOneRequest.estimatedCostUsd!);
  });

  it("labels nothing it could not price", () => {
    for (const estimate of [
      estimateAggregatedTurnCost(usage, "codex"),
      estimateAggregatedTurnCost(undefined, "gpt-5.6-sol"),
    ]) {
      expect(estimate.estimatedCostUsd).toBeNull();
      expect(estimate.basis).toBeUndefined();
    }
  });
});

describe("estimateActorCost: a dated price change", () => {
  const DATED: Record<string, ModelRate> = {
    "dated-model": {
      inputUsdPerToken: 1e-6,
      cachedInputUsdPerToken: 0.1e-6,
      outputUsdPerToken: 4e-6,
      until: "2026-12-31",
      after: { inputUsdPerToken: 2e-6, cachedInputUsdPerToken: 0.2e-6, outputUsdPerToken: 8e-6 },
      asOf: "2026-10-21",
      source: "fake-sheet://dated",
    },
  };
  const usage = { input: 1_000_000, cachedInput: 500_000, output: 100_000 };

  it("prices at the published rate through its last day", () => {
    const at = new Date("2026-12-31T23:59:59Z");
    expect(estimateActorCost(usage, "dated-model", DATED, at).estimatedCostUsd).toBe(0.95);
  });

  it("prices at the next published rate from the day after", () => {
    const at = new Date("2027-01-01T00:00:00Z");
    expect(estimateActorCost(usage, "dated-model", DATED, at).estimatedCostUsd).toBe(1.9);
  });
});

describe("participant cap pricing", () => {
  it("never offers an analysis-only model to a participant", () => {
    expect(participantRate("gpt-6-astra")).toBeDefined();
    expect(participantRate("gemini-3.8-flash")).toBeUndefined();
    expect(unpricedCapMessage("unpriced-model")).not.toMatch(/gemini/);
  });
});

describe("estimateActorCost: Claude Haiku 5.5", () => {
  // Expected dollars are worked by hand from the pricing page's per-1M rates.
  const request = (
    input: number,
    cachedInput: number,
    cacheWriteInput: number,
    output: number,
  ) => ({
    input,
    cachedInput,
    cacheWriteInput,
    output,
  });
  const priced = (...turns: ReturnType<typeof request>[]) => {
    const sum = (field: keyof ReturnType<typeof request>) =>
      turns.reduce((total, turn) => total + turn[field], 0);
    return estimateActorCost(
      {
        input: sum("input"),
        cachedInput: sum("cachedInput"),
        cacheWriteInput: sum("cacheWriteInput"),
        output: sum("output"),
        turns,
      },
      "claude-haiku-5-5",
    );
  };

  it("prices a request of 100,000 prompt tokens or fewer at the base rates", () => {
    // 1,992 uncached at $0.10, 3,456 written at $0.125, 162 out at $0.50 (a captured first turn).
    expect(priced(request(5448, 0, 3456, 162)).estimatedCostUsd).toBe(0.000712);
    // Exactly 100,000: $0.01 uncached, nothing above the threshold.
    expect(priced(request(100_000, 0, 0, 0)).estimatedCostUsd).toBe(0.01);
  });

  it("prices a request over 100,000 prompt tokens at 5x, cache reads included in its size", () => {
    // 20,000 uncached at $0.50, 100,000 read at $0.05, 1,000 out at $2.50.
    const estimate = priced(request(120_000, 100_000, 0, 1000));
    expect(estimate.estimatedCostUsd).toBe(0.0175);
    expect(estimate.breakdown?.longContextTurns).toBe(1);
  });

  it("prices a compaction as a request of its own", () => {
    // Compaction: 180,000 in at $0.50 + 3,500 out at $2.50; then 23,000 in at $0.10 + 1,000 out.
    expect(priced(request(180_000, 0, 0, 3500), request(23_000, 0, 0, 1000)).estimatedCostUsd).toBe(
      0.10155,
    );
  });
});
