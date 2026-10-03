import { describe, expect, it } from "vitest";
import {
  analysisCostOf,
  runCost,
  runCostLabel,
  runCostParts,
  type RunAnalysisCost,
} from "../../src/run/run-cost.js";

// The 0.108.0 try-live smoke run: a Codex-account participant whose tokens have no dollar price,
// $0.016123 of desktop time, and a $0.529005 analysis on the OpenAI API key.
const subtotal = {
  estimatedTotalUsd: 0.016123,
  fullyEstimated: false,
  ratesAsOf: "2026-09-05",
  placeholder: false,
};
const oneAnalysis: RunAnalysisCost = {
  requests: 1,
  estimatedUsd: 0.529005,
  complete: true,
  providers: ["openai"],
};

describe("a run's cost", () => {
  it("adds the analysis to participants and desktops, and stays a lower bound while any part is unpriced", () => {
    const cost = runCost(subtotal, oneAnalysis);
    expect(cost.total).toEqual({ usd: 0.545128, complete: false });
    expect(runCostParts(cost)).toEqual([
      "Participants + desktops: est. ~$0.02 plus unpriced usage (rates as of 2026-09-05)",
      "Analysis: est. ~$0.53 (OpenAI API key)",
      "Total: est. ~$0.55 plus unpriced usage",
    ]);
    expect(runCostLabel(cost)).toBe("~$0.55 est. plus unpriced usage, with analysis");
    const priced = runCost({ ...subtotal, fullyEstimated: true }, oneAnalysis);
    expect(priced.total).toEqual({ usd: 0.545128, complete: true });
    expect(runCostLabel(priced)).toBe("~$0.55 est., with analysis");
  });

  it("names a Codex-account analysis without a dollar figure, and keeps an unpriced one unknown", () => {
    const codex = runCost(subtotal, {
      requests: 1,
      estimatedUsd: null,
      complete: false,
      providers: ["codex"],
    });
    expect(codex.total).toEqual({ usd: 0.016123, complete: false });
    expect(runCostParts(codex)).toContain("Analysis: Codex account, dollar cost unknown");
    const unpriced = runCost(
      { ...subtotal, fullyEstimated: true },
      { requests: 1, estimatedUsd: null, complete: false, providers: ["openai"] },
    );
    expect(runCostParts(unpriced)).toContain("Analysis: cost not estimated (OpenAI API key)");
    expect(unpriced.total?.complete).toBe(false);
  });

  it("does not claim a complete total when only the subtotal's dollars are known", () => {
    const fromIndex = runCost({ estimatedTotalUsd: 1.2 }, null);
    expect(fromIndex.total).toEqual({ usd: 1.2, complete: null });
    expect(runCostLabel(fromIndex)).toBe("~$1.20 est.");
  });

  it("says nothing for a run with no cost summary, and 'not estimated' for a null one", () => {
    expect(runCost(undefined, oneAnalysis)).toEqual({ run: null, analysis: null, total: null });
    expect(runCostParts(runCost(undefined, oneAnalysis))).toEqual([]);
    expect(runCostLabel(runCost(undefined, oneAnalysis))).toBeUndefined();
    const unknown = runCost({ ...subtotal, estimatedTotalUsd: null }, null);
    expect(unknown.total).toBeNull();
    expect(runCostParts(unknown)).toEqual(["Participants + desktops: cost not estimated"]);
    expect(runCostLabel(unknown)).toBe("cost not estimated");
  });
});

describe("the analysis spend from its accounting", () => {
  const accounting = {
    dispatched: 2,
    unresolved: 0,
    unpriced: 0,
    estimatedUsd: 1.043096,
    providers: ["openai" as const],
    warnings: [],
  };

  it("counts every request and reports no spend when none was sent", () => {
    expect(analysisCostOf(accounting)).toEqual({
      requests: 2,
      estimatedUsd: 1.043096,
      complete: true,
      providers: ["openai"],
    });
    expect(
      analysisCostOf({ ...accounting, dispatched: 0, estimatedUsd: 0, providers: [] }),
    ).toBeNull();
  });

  it("is incomplete when a request is unpriced, unresolved, or the history could not be read whole", () => {
    expect(analysisCostOf({ ...accounting, unpriced: 1 })?.complete).toBe(false);
    expect(analysisCostOf({ ...accounting, unresolved: 1, unpriced: 1 })).toMatchObject({
      requests: 3,
      complete: false,
    });
    expect(
      analysisCostOf({ ...accounting, warnings: ["ANALYSIS_ACCOUNTING_INVALID"] })?.complete,
    ).toBe(false);
  });
});
