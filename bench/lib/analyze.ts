import { numberField, objectField, runCli, stringField } from "./humanish-cli.js";
import type { BudgetSettings, SpendLedger } from "./plan.js";
import type { AnalysisRecord, AnalysisSpec } from "./report.js";

const SHORT_TIMEOUT_MS = 5 * 60_000;
const ANALYSIS_TIMEOUT_MS = 12 * 60_000;

/** The `humanish analyze` flags that select the spec's analyst. */
export function analysisSpecArgs(spec: AnalysisSpec | undefined): string[] {
  if (spec === undefined) return [];
  return [...(spec.provider === null ? [] : ["--provider", spec.provider]), "--model", spec.model];
}

interface AnalyzeTarget {
  runId: string;
  budget: BudgetSettings;
  cliPath: string;
  projectDir: string;
  logFile: string;
  spec?: AnalysisSpec;
}

/** The benchmark's `analyze` arguments for one run under the cap `cap`. */
function analyzeArgs(target: AnalyzeTarget, cap: number): string[] {
  // Keep the benchmark's output allowance stable while its input prompt grows.
  const outputArgs = target.budget.analysisAutoCap ? ["--max-output-tokens", "16384"] : [];
  return [
    "analyze", "--run", target.runId, "--cwd", target.projectDir, "--max-cost", String(cap), "--json",
    ...outputArgs, ...analysisSpecArgs(target.spec),
  ];
}

export interface Admission {
  ok: boolean;
  /** The refusal code when `ok` is false. */
  error: string | null;
  /** `estimatedCostUsd`: the expected cost. */
  admissionUsd: number | null;
  admittedUsd: number | null;
  /** The cost if the analyst writes its whole output allowance. The cap does not bound it. */
  worstCaseUsd: number | null;
}

/** `humanish analyze --dry-run` for one run: admission's figures for the spec's analyst. No spend. */
export async function admissionFor(target: AnalyzeTarget, analyze: typeof runCli = runCli): Promise<Admission> {
  const dryRun = await analyze(target.cliPath, [...analyzeArgs(target, target.budget.analysisMaxUsd), "--dry-run"], {
    logFile: target.logFile,
    timeoutMs: SHORT_TIMEOUT_MS,
  });
  const admission = objectField(dryRun.json, "admission");
  const ok = dryRun.json?.ok === true;
  return {
    ok,
    error: ok ? null : stringField(objectField(dryRun.json, "error"), "code"),
    admissionUsd: numberField(admission, "estimatedCostUsd"),
    admittedUsd: numberField(admission, "admittedCostUsd"),
    worstCaseUsd: numberField(admission, "worstCaseCostUsd"),
  };
}

/**
 * Analyze one run when its worst case still fits under the budget. With automatic sizing the cap
 * is the admitted cost the CLI's dry run reports, the smallest cap admission accepts. A dispatched
 * request with no recorded estimate is charged its worst case. `spec` selects the analyst for both
 * the admission check and the analysis; without it the CLI's default model runs. `rerun` makes a
 * new analysis version even when a saved one has the same input and configuration.
 *
 * The analysis's worst case is reserved on `ledger` before it starts and settled to its charge
 * when it ends. When `stopped` turns true before the analysis starts, it returns `not_run`.
 * `detached` runs the CLI in its own process group, so a Ctrl-C at the terminal leaves it to finish
 * and record.
 */
export async function analyzeWithinBudget(
  options: AnalyzeTarget & {
    ledger: SpendLedger;
    analyzeNodeArgs: string[];
    rerun?: boolean;
    stopped?: () => boolean;
    detached?: boolean;
  },
  analyze: typeof runCli = runCli,
): Promise<{ analysis: AnalysisRecord; chargeUsd: number }> {
  const { ledger, budget, logFile, analyzeNodeArgs } = options;
  const { error, admissionUsd, admittedUsd, worstCaseUsd, ok } = await admissionFor(options, analyze);
  const sized = budget.analysisAutoCap && ok && admittedUsd !== null && admittedUsd > 0;
  const maxCostUsd = sized ? admittedUsd : budget.analysisMaxUsd;
  const base = { analysisId: null, estimatedUsd: null, admissionUsd, maxCostUsd, wallMs: null };
  if (!ok) return { analysis: { ...base, state: "refused", error }, chargeUsd: 0 };
  if ((budget.analysisAutoCap && !sized) || worstCaseUsd === null) {
    return { analysis: { ...base, state: "refused", error: "analysis_estimate_unavailable" }, chargeUsd: 0 };
  }
  if (options.stopped?.()) return { analysis: { ...base, state: "not_run", error: null }, chargeUsd: 0 };
  if (!(await ledger.reserve(worstCaseUsd))) {
    return { analysis: { ...base, state: "skipped_budget", error: null }, chargeUsd: 0 };
  }
  if (options.stopped?.()) {
    ledger.settle(worstCaseUsd, 0);
    return { analysis: { ...base, state: "not_run", error: null }, chargeUsd: 0 };
  }
  const started = performance.now();
  const result = await analyze(options.cliPath, [...analyzeArgs(options, maxCostUsd), ...(options.rerun ? ["--rerun"] : [])], {
    logFile,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    nodeArgs: analyzeNodeArgs,
    ...(options.detached ? { detached: true } : {}),
  });
  const wallMs = Math.round(performance.now() - started);
  const usage = objectField(result.json, "usage");
  const estimated = numberField(usage, "estimatedCostUsd");
  const dispatched = usage?.dispatched === true;
  const chargeUsd = estimated ?? (dispatched ? worstCaseUsd : 0);
  ledger.settle(worstCaseUsd, chargeUsd);
  return {
    analysis: {
      ...base,
      admissionUsd: numberField(objectField(result.json, "admission"), "estimatedCostUsd") ?? admissionUsd,
      state: result.json?.ok === true ? "complete" : dispatched ? "failed" : "refused",
      analysisId: stringField(result.json, "analysisId"),
      estimatedUsd: estimated,
      wallMs,
      error: stringField(objectField(result.json, "error"), "code"),
    },
    chargeUsd,
  };
}

