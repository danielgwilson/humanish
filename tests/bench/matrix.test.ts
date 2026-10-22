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

it("reads an optional @effort suffix and keeps it in the label", () => {
  expect(parseAnalysisSpecs("gpt-6-luna,gpt-6-luna@medium,gemini:gemini-3.8-flash@low")).toEqual([
    { label: "gpt-6-luna", provider: null, model: "gpt-6-luna" },
    { label: "gpt-6-luna@medium", provider: null, model: "gpt-6-luna", reasoningEffort: "medium" },
    {
      label: "gemini:gemini-3.8-flash@low",
      provider: "gemini",
      model: "gemini-3.8-flash",
      reasoningEffort: "low",
    },
  ]);
});

it.each([
  "",
  "gpt-6-astra,,gpt-5.6-luna",
  "gemini:",
  ":gpt-6-astra",
  "gpt-6-astra,gpt-6-astra",
  "gpt-6-luna@",
  "@medium",
  "gpt-6-luna@Medium",
])("refuses the analysis model list %j", (raw) => {
  expect(() => parseAnalysisSpecs(raw)).toThrow(/--analysis-models/);
});

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
function fakeCli(
  calls: string[][],
  billedUsd: Record<string, number>,
  timing: { delayMs?: (runId: string) => number; inFlight?: Record<string, number> } = {},
): typeof runCli {
  let made = 0;
  let running = 0;
  const analyzing = new Set<string>();
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
    const model_ = model;
    // humanish analyze holds a lock on its run and refuses a second analysis of it.
    const runId = flag(args, "--run") ?? "";
    if (analyzing.has(runId))
      return { code: 2, timedOut: false, json: { ok: false, error: { code: "ANALYSIS_BUSY" } } };
    analyzing.add(runId);
    running++;
    if (timing.inFlight) timing.inFlight[model_] = Math.max(timing.inFlight[model_] ?? 0, running);
    if (timing.inFlight) timing.inFlight.all = Math.max(timing.inFlight.all ?? 0, running);
    await sleep(timing.delayMs?.(flag(args, "--run") ?? "") ?? 5);
    running--;
    analyzing.delete(runId);
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
  concurrency: 1,
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
    new Set(analyses.map((args) => `${flag(args, "--provider") ?? "-"} ${flag(args, "--model")}`)),
  ).toEqual(new Set(["- gpt-5.6-luna", "gemini gemini-3.8-flash"]));
  // The admission check runs on the model it admits.
  calls.forEach((args, i) => {
    if (!args.includes("--dry-run"))
      expect(flag(calls[i - 1]!, "--model")).toBe(flag(args, "--model"));
  });
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

it("passes a spec's effort to analyze and its admission check as --reasoning-effort", async () => {
  const calls: string[][] = [];
  const manifest = manifestOf(["run-a"]);
  await runAnalysisMatrix(
    manifest,
    options("gpt-5.6-luna,gpt-5.6-luna@medium", 1),
    fakeCli(calls, { "gpt-5.6-luna": 0.01 }),
  );
  expect(manifest.analysisMatrix?.map((analysis) => analysis.spec)).toEqual([
    "gpt-5.6-luna",
    "gpt-5.6-luna@medium",
  ]);
  const efforts = calls.map((args) => [
    args.includes("--dry-run"),
    flag(args, "--model"),
    flag(args, "--reasoning-effort"),
  ]);
  expect(efforts).toEqual([
    [true, "gpt-5.6-luna", undefined],
    [false, "gpt-5.6-luna", undefined],
    [true, "gpt-5.6-luna", "medium"],
    [false, "gpt-5.6-luna", "medium"],
  ]);
});

it("runs up to the concurrency at once, never two on one run, and records in plan order", async () => {
  const calls: string[][] = [];
  const inFlight: Record<string, number> = {};
  const manifest = manifestOf(["run-a", "run-b", "run-c", "run-d"]);
  // The first run's analyses are the slowest, so they finish last.
  const delayMs = (runId: string): number => ({ "run-a": 60, "run-b": 30 })[runId] ?? 5;
  await runAnalysisMatrix(
    manifest,
    { ...options("gpt-5.6-luna,gemini:gemini-3.8-flash", 2), concurrency: 4 },
    fakeCli(calls, {}, { delayMs, inFlight }),
  );
  expect(inFlight.all).toBe(4);
  expect(
    manifest.analysisMatrix?.map(
      (analysis) => `${analysis.runId} ${analysis.spec} ${analysis.repeat}`,
    ),
  ).toEqual([
    "run-a gpt-5.6-luna 1",
    "run-a gemini:gemini-3.8-flash 1",
    "run-b gpt-5.6-luna 1",
    "run-b gemini:gemini-3.8-flash 1",
    "run-c gpt-5.6-luna 1",
    "run-c gemini:gemini-3.8-flash 1",
    "run-d gpt-5.6-luna 1",
    "run-d gemini:gemini-3.8-flash 1",
    "run-a gpt-5.6-luna 2",
    "run-a gemini:gemini-3.8-flash 2",
    "run-b gpt-5.6-luna 2",
    "run-b gemini:gemini-3.8-flash 2",
    "run-c gpt-5.6-luna 2",
    "run-c gemini:gemini-3.8-flash 2",
    "run-d gpt-5.6-luna 2",
    "run-d gemini:gemini-3.8-flash 2",
  ]);
  expect(manifest.analysisMatrix?.every((analysis) => analysis.state === "complete")).toBe(true);
});

it("keeps a model's analyses in flight within its cap when they run at once", async () => {
  // At a $2 cap only one $1.351575 gpt-6-astra worst case fits, so its analyses never overlap and
  // the outcome matches one analysis at a time.
  const inFlight: Record<string, number> = {};
  const manifest = manifestOf(["run-a", "run-b", "run-c"]);
  await runAnalysisMatrix(
    manifest,
    { ...options("gpt-6-astra,gpt-5.6-luna", 1), concurrency: 4 },
    fakeCli([], { "gpt-6-astra": 0.87955, "gpt-5.6-luna": 0.02 }, { inFlight }),
  );
  expect(inFlight["gpt-6-astra"]).toBe(1);
  expect(manifest.analysisMatrix?.map((analysis) => `${analysis.spec} ${analysis.state}`)).toEqual([
    "gpt-6-astra complete",
    "gpt-5.6-luna complete",
    "gpt-6-astra skipped_budget",
    "gpt-5.6-luna complete",
    "gpt-6-astra skipped_budget",
    "gpt-5.6-luna complete",
  ]);
});

it("starts nothing new after an interrupt and records the analyses already running", async () => {
  let interrupted = false;
  const calls: string[][] = [];
  const cli = fakeCli(calls, {}, { delayMs: () => 30 });
  const manifest = manifestOf(["run-a", "run-b", "run-c"]);
  await runAnalysisMatrix(
    manifest,
    { ...options("gpt-5.6-luna", 1), concurrency: 2, stopped: () => interrupted },
    async (cliPath, args, runOptions) => {
      const result = cli(cliPath, args, runOptions);
      if (!args.includes("--dry-run")) interrupted = true;
      return result;
    },
  );
  const started = calls.filter((args) => !args.includes("--dry-run"));
  expect(started).toHaveLength(1);
  expect(manifest.analysisMatrix?.map((analysis) => `${analysis.runId} ${analysis.state}`)).toEqual(
    ["run-a complete"],
  );
});
