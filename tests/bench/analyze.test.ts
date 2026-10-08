import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { analyzeWithinBudget } from "../../bench/lib/analyze.js";
import type { CliResult, runCli } from "../../bench/lib/humanish-cli.js";

// Captured `humanish analyze --dry-run --json` outputs for one 0.114.0 benchmark run
// (tests/fixtures/bench/analyze-dry-run/README.md): expected cost $1.182375, admitted cost
// $1.300613, worst case $1.351575 with the benchmark's 16,384-token output allowance.
const captured = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`../fixtures/bench/analyze-dry-run/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
const autoCap = captured("auto-cap");
const refused = captured("refused");
const fixedCap = captured("fixed-cap");

const options = {
  runId: "cua-2026-10-08T00-21-52-120Z-c53f9610",
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

const billed = {
  ok: true,
  analysisId: "analysis-planted",
  usage: { estimatedCostUsd: 0.87955, dispatched: true },
};

/** The CLI for that run: the dry run answers with `dryRun`, and the analysis is billed $0.87955. */
function cli(dryRun: Record<string, unknown>, calls: string[][] = []): typeof runCli {
  return async (_cli, args) => {
    calls.push([...args]);
    return response(args.includes("--dry-run") ? dryRun : billed);
  };
}

const capOf = (args: string[] | undefined): string | undefined =>
  args?.[args.indexOf("--max-cost") + 1];

it("runs the analysis at the admitted cost the dry run reports, with the same output allowance", async () => {
  const calls: string[][] = [];
  const result = await analyzeWithinBudget(options, cli(autoCap, calls));
  expect(result).toEqual({
    analysis: {
      analysisId: "analysis-planted",
      state: "complete",
      admissionUsd: 1.182375,
      maxCostUsd: 1.300613,
      estimatedUsd: 0.87955,
      error: null,
    },
    chargeUsd: 0.87955,
  });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual(
    expect.arrayContaining(["--max-cost", "1.300613", "--max-output-tokens", "16384"]),
  );
});

it.each([
  [5.64, "complete"],
  [5.66, "skipped_budget"],
])(
  "starts the analysis after spending %s only when its worst case of 1.351575 fits the budget of 7",
  async (spentUsd, state) => {
    const calls: string[][] = [];
    const result = await analyzeWithinBudget({ ...options, spentUsd }, cli(autoCap, calls));
    expect(result.analysis.state).toBe(state);
    expect(calls).toHaveLength(state === "complete" ? 2 : 1);
  },
);

it("counts a fixed-cap analysis at its worst case, which the cap does not bound", async () => {
  // At --max-cost 1.31 the CLI chose a 32,768-token allowance: admitted at $1.300613, worst case $2.170775.
  const budget = { ...options.budget, analysisMaxUsd: 1.31, analysisAutoCap: false };
  const calls: string[][] = [];
  const skipped = await analyzeWithinBudget(
    { ...options, spentUsd: 4.9, budget },
    cli(fixedCap, calls),
  );
  expect(skipped).toEqual({
    analysis: {
      analysisId: null,
      state: "skipped_budget",
      admissionUsd: 1.182375,
      maxCostUsd: 1.31,
      estimatedUsd: null,
      error: null,
    },
    chargeUsd: 0,
  });
  const started = await analyzeWithinBudget(
    { ...options, spentUsd: 4.8, budget },
    cli(fixedCap, calls),
  );
  expect(started.analysis).toMatchObject({ state: "complete", maxCostUsd: 1.31 });
  expect(calls.map(capOf)).toEqual(["1.31", "1.31", "1.31"]);
  expect(calls.at(-1)).not.toContain("--max-output-tokens");
});

it("records the cap the dry run checked when admission refuses it", async () => {
  const budget = { ...options.budget, analysisMaxUsd: 1.25 };
  const calls: string[][] = [];
  const result = await analyzeWithinBudget({ ...options, budget }, cli(refused, calls));
  expect(result).toEqual({
    analysis: {
      analysisId: null,
      state: "refused",
      admissionUsd: 1.182375,
      maxCostUsd: 1.25,
      estimatedUsd: null,
      error: "analysis_budget_exceeded",
    },
    chargeUsd: 0,
  });
  expect(calls.map(capOf)).toEqual(["1.25"]);
});

it("records the analysis call's own estimate when that call refuses", async () => {
  const grown = {
    ...refused,
    admission: { ...(refused.admission as object), estimatedCostUsd: 1.25 },
  };
  const result = await analyzeWithinBudget(options, async (_cli, args) =>
    response(args.includes("--dry-run") ? autoCap : grown),
  );
  expect(result).toMatchObject({
    analysis: {
      state: "refused",
      admissionUsd: 1.25,
      maxCostUsd: 1.300613,
      error: "analysis_budget_exceeded",
    },
    chargeUsd: 0,
  });
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

it("charges a dispatched analysis with no reported usage its worst case", async () => {
  const result = await analyzeWithinBudget(options, async (_cli, args) =>
    response(
      args.includes("--dry-run")
        ? autoCap
        : { ok: false, usage: { dispatched: true }, error: { code: "analysis_timeout" } },
    ),
  );
  expect(result).toMatchObject({
    analysis: { state: "failed", maxCostUsd: 1.300613, estimatedUsd: null },
    chargeUsd: 1.351575,
  });
});
