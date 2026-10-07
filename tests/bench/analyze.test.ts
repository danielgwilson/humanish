import { expect, it } from "vitest";

import { analyzeWithinBudget } from "../../bench/lib/analyze.js";
import type { CliResult, runCli } from "../../bench/lib/humanish-cli.js";

const options = {
  runId: "run-planted",
  spentUsd: 0.3,
  budget: {
    maxUsdPerBrain: 7,
    participantCapUsd: 0.6,
    analysisMaxUsd: 7,
    analysisAutoCap: true,
    worstCaseDesktopMinutes: 50,
    analysis: true,
  },
  cliPath: "unused-cli",
  projectDir: "unused-project",
  logFile: "unused-log",
  analyzeNodeArgs: [],
};

function response(json: Record<string, unknown>): CliResult {
  return { code: json.ok ? 0 : 1, timedOut: false, json };
}

it("admits the grown prompt with headroom and the same output allowance", async () => {
  const calls: string[][] = [];
  const analyze: typeof runCli = async (_cli, args) => {
    calls.push([...args]);
    return response(
      args.includes("--dry-run")
        ? { ok: true, admission: { estimatedCostUsd: 1.81, outputTokenAllowance: 16384 } }
        : {
            ok: true,
            analysisId: "analysis-planted",
            usage: { estimatedCostUsd: 0.87, dispatched: true },
          },
    );
  };
  const result = await analyzeWithinBudget(options, analyze);
  expect(result).toMatchObject({
    analysis: { state: "complete", admissionUsd: 1.81, maxCostUsd: 1.991, estimatedUsd: 0.87 },
    chargeUsd: 0.87,
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(
    expect.arrayContaining(["--max-cost", "1.991", "--max-output-tokens", "16384"]),
  );
});

it("refuses automatic sizing when admission has no usable estimate", async () => {
  let dispatched = false;
  const result = await analyzeWithinBudget(options, async (_cli, args) => {
    if (!args.includes("--dry-run")) dispatched = true;
    return response({ ok: true });
  });
  expect(dispatched).toBe(false);
  expect(result).toMatchObject({
    analysis: { state: "refused", error: "analysis_estimate_unavailable" },
    chargeUsd: 0,
  });
});

it("records the live admission estimate when evidence growth causes a cost refusal", async () => {
  const result = await analyzeWithinBudget(options, async (_cli, args) =>
    response(
      args.includes("--dry-run")
        ? { ok: true, admission: { estimatedCostUsd: 1.81 } }
        : {
            ok: false,
            admission: { estimatedCostUsd: 2.2 },
            error: { code: "analysis_budget_exceeded" },
          },
    ),
  );
  expect(result).toMatchObject({
    analysis: {
      state: "refused",
      admissionUsd: 2.2,
      maxCostUsd: 1.991,
      error: "analysis_budget_exceeded",
    },
    chargeUsd: 0,
  });
});

it("records the cap actually checked when automatic admission is refused", async () => {
  const result = await analyzeWithinBudget(options, async () =>
    response({
      ok: false,
      admission: { estimatedCostUsd: 8 },
      error: { code: "analysis_budget_exceeded" },
    }),
  );
  expect(result).toMatchObject({
    analysis: { state: "refused", admissionUsd: 8, maxCostUsd: 7 },
    chargeUsd: 0,
  });
});

it("clips headroom to the remaining budget without refusing an estimate that fits exactly", async () => {
  let cap: number | undefined;
  const result = await analyzeWithinBudget({ ...options, spentUsd: 5.19 }, async (_cli, args) => {
    if (args.includes("--dry-run"))
      return response({ ok: true, admission: { estimatedCostUsd: 1.81 } });
    cap = Number(args[args.indexOf("--max-cost") + 1]);
    return cap < 1.81
      ? response({
          ok: false,
          admission: { estimatedCostUsd: 1.81 },
          error: { code: "analysis_budget_exceeded" },
        })
      : response({ ok: true, usage: { dispatched: true } });
  });
  expect(result).toMatchObject({
    analysis: { state: "complete", maxCostUsd: 1.81 },
    chargeUsd: 1.81,
  });
  expect(cap).toBe(1.81);
});
