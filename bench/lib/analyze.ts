import { numberField, objectField, runCli, stringField } from "./humanish-cli.js";
import { canStartAnalysis, round, type BudgetSettings } from "./plan.js";
import type { RunRecord } from "./report.js";

const SHORT_TIMEOUT_MS = 5 * 60_000;
const ANALYSIS_TIMEOUT_MS = 12 * 60_000;

/**
 * Analyze one run when its admission estimate still fits under the cap. A dispatched request with
 * no recorded estimate is charged its whole limit.
 */
export async function analyzeWithinBudget(
  options: {
    runId: string;
    spentUsd: number;
    budget: BudgetSettings;
    cliPath: string;
    projectDir: string;
    logFile: string;
    analyzeNodeArgs: string[];
  },
  analyze: typeof runCli = runCli,
): Promise<{ analysis: RunRecord["analysis"]; chargeUsd: number }> {
  const { runId, spentUsd, budget, cliPath, projectDir, logFile, analyzeNodeArgs } = options;
  let maxCostUsd = budget.analysisMaxUsd;
  // Keep the benchmark's output allowance stable while its input prompt grows.
  const outputArgs = budget.analysisAutoCap ? ["--max-output-tokens", "16384"] : [];
  const args = (cap: number): string[] => [
    "analyze", "--run", runId, "--cwd", projectDir, "--max-cost", String(cap), "--json", ...outputArgs,
  ];
  const admission = await analyze(cliPath, [...args(maxCostUsd), "--dry-run"], { logFile, timeoutMs: SHORT_TIMEOUT_MS });
  const admissionUsd = numberField(objectField(admission.json, "admission"), "estimatedCostUsd");
  if (budget.analysisAutoCap && admission.json?.ok === true && admissionUsd !== null) {
    // Ten percent headroom follows prompt growth without raising the brain's spending limit.
    // The budget gate below checks the estimate first. Subtraction must not round its cap below it.
    maxCostUsd = Math.max(admissionUsd, Math.min(round(admissionUsd * 1.1),
      budget.analysisMaxUsd, budget.maxUsdPerBrain - spentUsd));
  }
  const base = { analysisId: null, estimatedUsd: null, admissionUsd, maxCostUsd };
  if (admission.json?.ok !== true) {
    return {
      analysis: { ...base, state: "refused", error: stringField(objectField(admission.json, "error"), "code") },
      chargeUsd: 0,
    };
  }
  if (budget.analysisAutoCap && (admissionUsd === null || admissionUsd <= 0)) {
    return { analysis: { ...base, state: "refused", error: "analysis_estimate_unavailable" }, chargeUsd: 0 };
  }
  if (!canStartAnalysis(spentUsd, budget, admissionUsd ?? budget.analysisMaxUsd)) {
    return { analysis: { ...base, state: "skipped_budget", error: null }, chargeUsd: 0 };
  }
  const result = await analyze(cliPath, args(maxCostUsd), {
    logFile,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
    nodeArgs: analyzeNodeArgs,
  });
  const usage = objectField(result.json, "usage");
  const estimated = numberField(usage, "estimatedCostUsd");
  const dispatched = usage?.dispatched === true;
  return {
    analysis: {
      ...base,
      admissionUsd: numberField(objectField(result.json, "admission"), "estimatedCostUsd") ?? admissionUsd,
      state: result.json?.ok === true ? "complete" : dispatched ? "failed" : "refused",
      analysisId: stringField(result.json, "analysisId"),
      estimatedUsd: estimated,
      error: stringField(objectField(result.json, "error"), "code"),
    },
    chargeUsd: estimated ?? (dispatched ? maxCostUsd : 0),
  };
}

