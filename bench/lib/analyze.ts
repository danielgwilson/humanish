import { numberField, objectField, runCli, stringField } from "./humanish-cli.js";
import { canStartAnalysis, type BudgetSettings } from "./plan.js";
import type { RunRecord } from "./report.js";

const SHORT_TIMEOUT_MS = 5 * 60_000;
const ANALYSIS_TIMEOUT_MS = 12 * 60_000;

/**
 * Analyze one run when its worst case still fits under the brain's budget. With automatic sizing
 * the cap is the admitted cost the CLI's dry run reports, the smallest cap admission accepts. A
 * dispatched request with no recorded estimate is charged its worst case.
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
  // Keep the benchmark's output allowance stable while its input prompt grows.
  const outputArgs = budget.analysisAutoCap ? ["--max-output-tokens", "16384"] : [];
  const args = (cap: number): string[] => [
    "analyze", "--run", runId, "--cwd", projectDir, "--max-cost", String(cap), "--json", ...outputArgs,
  ];
  const dryRun = await analyze(cliPath, [...args(budget.analysisMaxUsd), "--dry-run"], { logFile, timeoutMs: SHORT_TIMEOUT_MS });
  const admission = objectField(dryRun.json, "admission");
  const admissionUsd = numberField(admission, "estimatedCostUsd");
  const admittedUsd = numberField(admission, "admittedCostUsd");
  // An analysis can bill up to its worst case, whatever its cap.
  const worstCaseUsd = numberField(admission, "worstCaseCostUsd");
  const sized = budget.analysisAutoCap && dryRun.json?.ok === true && admittedUsd !== null && admittedUsd > 0;
  const maxCostUsd = sized ? admittedUsd : budget.analysisMaxUsd;
  const base = { analysisId: null, estimatedUsd: null, admissionUsd, maxCostUsd };
  if (dryRun.json?.ok !== true) {
    return {
      analysis: { ...base, state: "refused", error: stringField(objectField(dryRun.json, "error"), "code") },
      chargeUsd: 0,
    };
  }
  if ((budget.analysisAutoCap && !sized) || worstCaseUsd === null) {
    return { analysis: { ...base, state: "refused", error: "analysis_estimate_unavailable" }, chargeUsd: 0 };
  }
  if (!canStartAnalysis(spentUsd, budget, worstCaseUsd)) {
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
    chargeUsd: estimated ?? (dispatched ? worstCaseUsd : 0),
  };
}

