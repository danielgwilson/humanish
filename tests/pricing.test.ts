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
    // The shipped default resolves to gpt-5.5 (DEFAULT_OPENAI_CU_MODEL); it must be priceable so a
    // capped run is not refused by default. The classic computer-use-preview is a confirmed rate.
    expect(MODEL_RATES["gpt-5.5"]?.placeholder).toBe(true);
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
