import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";

import type { runCli } from "../../bench/lib/humanish-cli.js";
import { parseAnalysisSpecs, refusedSpecs, runAnalysisMatrix } from "../../bench/lib/matrix.js";
import type { Manifest, MatrixAnalysis } from "../../bench/lib/report.js";

it("reads each analysis model as a bare model or provider:model", () => {
  expect(parseAnalysisSpecs("gpt-6-astra, gemini:gemini-3.8-flash,openai:gpt-5.6-luna")).toEqual([
    { label: "gpt-6-astra", provider: null, model: "gpt-6-astra" },
    { label: "gemini:gemini-3.8-flash", provider: "gemini", model: "gemini-3.8-flash" },
    { label: "openai:gpt-5.6-luna", provider: "openai", model: "gpt-5.6-luna" },
  ]);
});

it.each(["", "gpt-6-astra,,gpt-5.6-luna", "gemini:", ":gpt-6-astra", "gpt-6-astra,gpt-6-astra"])(
  "refuses the analysis model list %j",
  (raw) => {
    expect(() => parseAnalysisSpecs(raw)).toThrow(/--analysis-models/);
  },
);

const budget = {
  maxUsdPerBrain: 2,
  participantCapUsd: 0.6,
  analysisMaxUsd: 2,
  analysisAutoCap: true,
  worstCaseDesktopMinutes: 0,
  analysis: true,
};

function manifestOf(runIds: (string | null)[], analysisMatrix?: MatrixAnalysis[]): Manifest {
  return {
    schema: "humanish.bench-manifest.v1",
    createdAt: "2026-10-21T00:00:00Z",
    humanish: { version: "0.0.0", source: "a test" },
    mission: "neutral",
    brains: ["openai-computer-use"],
    runsPerArm: 1,
    budget,
    fixture: { plantedAppJs: "x", cleanAppJs: "x", indexHtml: "x", persona: "x" },
    stopped: {},
    runs: runIds.map((runId, index) => ({
      brain: "openai-computer-use",
      arm: index % 2 === 0 ? "planted" : "clean",
      index: Math.floor(index / 2) + 1,
      studyId: "bench-study",
      runId,
      ok: runId !== null,
      error: null,
      startedAt: "2026-10-21T00:00:00Z",
      finishedAt: "2026-10-21T00:01:00Z",
      analysis: {
        state: "skipped_disabled",
        analysisId: null,
        estimatedUsd: null,
        admissionUsd: null,
        error: null,
      },
      cleanup: null,
    })),
    ...(analysisMatrix ? { analysisMatrix } : {}),
  };
}

const flag = (args: readonly string[], name: string): string | undefined =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

/**
 * A humanish CLI whose analyst bills `billedUsd` per model. Its dry run reports the captured
 * gpt-6-astra admission (worst case $1.351575) for gpt-6-astra and a $0.03 worst case otherwise.
 */
function fakeCli(calls: string[][], billedUsd: Record<string, number>): typeof runCli {
  let made = 0;
  return async (_cli, args) => {
    calls.push([...args]);
    const model = flag(args, "--model") ?? "unset";
    if (args.includes("--dry-run")) {
      const worstCaseCostUsd = model === "gpt-6-astra" ? 1.351575 : 0.03;
      return {
        code: 0,
        timedOut: false,
        json: {
          ok: true,
          admission: {
            estimatedCostUsd: worstCaseCostUsd / 2,
            admittedCostUsd: worstCaseCostUsd * 0.6,
            worstCaseCostUsd,
          },
        },
      };
    }
    await sleep(5);
    made++;
    return {
      code: 0,
      timedOut: false,
      json: {
        ok: true,
        analysisId: `analysis-${made}`,
        usage: { estimatedCostUsd: billedUsd[model] ?? 0, dispatched: true },
      },
    };
  };
}

const options = (
  specs: string,
  repeats: number,
  onRecord: (analysis: MatrixAnalysis, spentUsd: number) => void = () => {},
) => ({
  specs: parseAnalysisSpecs(specs),
  repeats,
  budget,
  cliPath: "unused-cli",
  cliVersion: "0.0.0",
  projectDir: "unused-project",
  logFile: "unused-log",
  analyzeNodeArgs: [],
  onRecord,
  stopped: () => false,
});

it("analyzes every recorded run once per model and repeat, each as a new analysis version", async () => {
  const calls: string[][] = [];
  const manifest = manifestOf(["run-a", null, "run-b"]);
  await runAnalysisMatrix(
    manifest,
    options("gpt-5.6-luna,gemini:gemini-3.8-flash", 2),
    fakeCli(calls, { "gpt-5.6-luna": 0.01, "gemini-3.8-flash": 0.02 }),
  );
  expect(
    manifest.analysisMatrix?.map((analysis) => [
      analysis.runId,
      analysis.spec,
      analysis.repeat,
      analysis.state,
    ]),
  ).toEqual([
    ["run-a", "gpt-5.6-luna", 1, "complete"],
    ["run-a", "gemini:gemini-3.8-flash", 1, "complete"],
    ["run-b", "gpt-5.6-luna", 1, "complete"],
    ["run-b", "gemini:gemini-3.8-flash", 1, "complete"],
    ["run-a", "gpt-5.6-luna", 2, "complete"],
    ["run-a", "gemini:gemini-3.8-flash", 2, "complete"],
    ["run-b", "gpt-5.6-luna", 2, "complete"],
    ["run-b", "gemini:gemini-3.8-flash", 2, "complete"],
  ]);
  expect(new Set(manifest.analysisMatrix?.map((analysis) => analysis.analysisId)).size).toBe(8);
  const analyses = calls.filter((args) => !args.includes("--dry-run"));
  expect(analyses).toHaveLength(8);
  for (const args of analyses) expect(args).toContain("--rerun");
  expect(
    analyses.map((args) => [flag(args, "--provider") ?? null, flag(args, "--model")]).slice(0, 2),
  ).toEqual([
    [null, "gpt-5.6-luna"],
    ["gemini", "gemini-3.8-flash"],
  ]);
  // The admission check runs on the model it admits.
  expect(
    calls
      .filter((args) => args.includes("--dry-run"))
      .map((args) => flag(args, "--model"))
      .slice(0, 2),
  ).toEqual(["gpt-5.6-luna", "gemini-3.8-flash"]);
  for (const analysis of manifest.analysisMatrix ?? [])
    expect(analysis.wallMs).toBeGreaterThanOrEqual(4);
});

it("numbers a later invocation's analyses after the ones the manifest already holds", async () => {
  const manifest = manifestOf(["run-a"]);
  await runAnalysisMatrix(manifest, options("gpt-5.6-luna", 1), fakeCli([], {}));
  await runAnalysisMatrix(manifest, options("gpt-5.6-luna,gpt-6-astra", 1), fakeCli([], {}));
  expect(manifest.analysisMatrix?.map((analysis) => `${analysis.spec} ${analysis.repeat}`)).toEqual(
    ["gpt-5.6-luna 1", "gpt-5.6-luna 2", "gpt-6-astra 1"],
  );
});

it("holds each analysis model to its own budget", async () => {
  // At a $2 cap the first gpt-6-astra analysis starts on its $1.351575 worst case and bills
  // $0.87955; the second would need $2.231125.
  const spent: Record<string, number> = {};
  const manifest = manifestOf(["run-a", "run-b", "run-c"]);
  await runAnalysisMatrix(
    manifest,
    options("gpt-6-astra,gpt-5.6-luna", 1, (analysis, spentUsd) => {
      spent[analysis.spec] = spentUsd;
    }),
    fakeCli([], { "gpt-6-astra": 0.87955, "gpt-5.6-luna": 0.02 }),
  );
  expect(manifest.analysisMatrix?.map((analysis) => `${analysis.spec} ${analysis.state}`)).toEqual([
    "gpt-6-astra complete",
    "gpt-5.6-luna complete",
    "gpt-6-astra skipped_budget",
    "gpt-5.6-luna complete",
    "gpt-6-astra skipped_budget",
    "gpt-5.6-luna complete",
  ]);
  expect(spent["gpt-6-astra"]).toBeCloseTo(0.87955, 3);
  expect(spent["gpt-5.6-luna"]).toBeCloseTo(0.06, 6);
  expect(manifest.analysisMatrix?.[2]?.wallMs).toBeNull();
});

it("names the analysis models the CLI refuses before anything is spent", async () => {
  // The two answers humanish 0.141.0 gave `analyze --run <missing> --dry-run` on 2026-10-21.
  const accepted = {
    ok: false,
    error: {
      code: "ANALYSIS_RUN_NOT_FOUND",
      message: "The selected run is unavailable or its storage is unsafe.",
    },
  };
  const refused = {
    ok: false,
    error: {
      code: "ANALYSIS_CONFIG_INVALID",
      message: "review.analysis.provider must be openai or codex.",
    },
  };
  const calls: string[][] = [];
  const refusals = await refusedSpecs(
    parseAnalysisSpecs("gpt-5.6-luna,gemini:gemini-3.8-flash"),
    { cliPath: "unused-cli", projectDir: "unused-project", logFile: "unused-log" },
    async (_cli, args) => {
      calls.push([...args]);
      return {
        code: 2,
        timedOut: false,
        json: flag(args, "--provider") === "gemini" ? refused : accepted,
      };
    },
  );
  expect(refusals).toEqual([
    {
      spec: "gemini:gemini-3.8-flash",
      message: "review.analysis.provider must be openai or codex.",
    },
  ]);
  for (const args of calls) expect(args).toContain("--dry-run");
});
