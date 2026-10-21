// The analysis matrix: every recorded run analyzed once per analysis model and repeat, so a model
// comparison holds the recording fixed and varies only the analyst.

import { analysisSpecArgs, analyzeWithinBudget } from "./analyze.js";
import { objectField, runCli, stringField } from "./humanish-cli.js";
import { round, type BudgetSettings } from "./plan.js";
import type { AnalysisSpec, Manifest, MatrixAnalysis } from "./report.js";

const PROVIDER = /^[a-z][a-z0-9-]*$/;

/** `--analysis-models`: comma-separated, each `model` or `provider:model`. */
export function parseAnalysisSpecs(raw: string): AnalysisSpec[] {
  const specs = raw.split(",").map((part): AnalysisSpec => {
    const label = part.trim();
    const colon = label.indexOf(":");
    const provider = colon === -1 ? null : label.slice(0, colon);
    const model = label.slice(colon + 1);
    if (model === "" || (provider !== null && !PROVIDER.test(provider))) {
      throw new Error(
        `--analysis-models takes a comma-separated list of model or provider:model, such as gpt-6-astra,gemini:gemini-3.8-flash. Got ${JSON.stringify(raw)}.`,
      );
    }
    return { label, provider, model };
  });
  const repeated = specs.find((spec, index) => specs.findIndex((other) => other.label === spec.label) !== index);
  if (repeated) throw new Error(`--analysis-models names ${repeated.label} twice. Use --analysis-repeats to analyze a run more than once with one model.`);
  return specs;
}

export interface MatrixOptions {
  specs: readonly AnalysisSpec[];
  /** Analyses of each run per model in this invocation. */
  repeats: number;
  /** `maxUsdPerBrain` is the cap on each analysis model's spend in this invocation. */
  budget: BudgetSettings;
  cliPath: string;
  cliVersion: string;
  projectDir: string;
  logFile: string;
  analyzeNodeArgs: string[];
  /** Called after each analysis is recorded, with its model's spend so far in this invocation. */
  onRecord: (analysis: MatrixAnalysis, modelSpentUsd: number) => void;
  stopped: () => boolean;
}

/**
 * Analyze each of the manifest's recorded runs with every model, `repeats` times, appending to
 * `manifest.analysisMatrix`. Every analysis is a new version (`--rerun`), so neither a repeat nor
 * an earlier analysis with the same configuration is reused. Each model starts an analysis only
 * when that analysis's worst case fits its own cap. One repeat finishes on every run before the
 * next starts, so a budget stop leaves the arms within one run of each other.
 */
export async function runAnalysisMatrix(
  manifest: Manifest,
  options: MatrixOptions,
  analyze: typeof runCli = runCli,
): Promise<void> {
  const matrix = (manifest.analysisMatrix ??= []);
  const spent = new Map<string, number>();
  const runIds = manifest.runs.flatMap((run) => (run.runId === null ? [] : [run.runId]));
  for (let pass = 0; pass < options.repeats; pass++) {
    for (const runId of runIds) {
      for (const spec of options.specs) {
        if (options.stopped()) return;
        const spentUsd = spent.get(spec.label) ?? 0;
        const { analysis, chargeUsd } = await analyzeWithinBudget(
          { ...options, runId, spentUsd, spec, rerun: true },
          analyze,
        );
        spent.set(spec.label, round(spentUsd + chargeUsd));
        const record: MatrixAnalysis = {
          runId,
          spec: spec.label,
          repeat: 1 + matrix.filter((prior) => prior.runId === runId && prior.spec === spec.label).length,
          humanish: options.cliVersion,
          ...analysis,
        };
        matrix.push(record);
        options.onRecord(record, spent.get(spec.label) ?? 0);
      }
    }
  }
}

/**
 * The analysis models the CLI refuses, with its reason, checked before any spend. `analyze`
 * validates the analyst before it looks up the run, so for a run id that does not exist it answers
 * ANALYSIS_RUN_NOT_FOUND when it accepts the analyst and another code when it does not.
 */
export async function refusedSpecs(
  specs: readonly AnalysisSpec[],
  cli: { cliPath: string; projectDir: string; logFile: string },
  analyze: typeof runCli = runCli,
): Promise<{ spec: string; message: string }[]> {
  const refusals: { spec: string; message: string }[] = [];
  for (const spec of specs) {
    const check = await analyze(
      cli.cliPath,
      [
        "analyze", "--run", "bench-analyst-check", "--cwd", cli.projectDir, "--max-cost", "1", "--json", "--dry-run",
        ...analysisSpecArgs(spec),
      ],
      { logFile: cli.logFile, timeoutMs: 60_000 },
    );
    const error = objectField(check.json, "error");
    if (stringField(error, "code") !== "ANALYSIS_RUN_NOT_FOUND") {
      refusals.push({ spec: spec.label, message: stringField(error, "message") ?? `analyze exited ${check.code ?? "on a signal"}` });
    }
  }
  return refusals;
}
