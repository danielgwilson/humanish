// The analysis matrix: every recorded run analyzed once per analysis model and repeat, so a model
// comparison holds the recording fixed and varies only the analyst.

import { analysisSpecArgs, analyzeWithinBudget } from "./analyze.js";
import { objectField, runCli, stringField } from "./humanish-cli.js";
import { mapWithConcurrency } from "../../src/run/concurrency.js";
import { SpendLedger, type BudgetSettings } from "./plan.js";
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
  /** Analyses in flight at once, across every model. */
  concurrency: number;
  /** `maxUsdPerBrain` is the cap on each analysis model's spend in this invocation. */
  budget: BudgetSettings;
  cliPath: string;
  cliVersion: string;
  projectDir: string;
  logFile: string;
  analyzeNodeArgs: string[];
  /** Called after each analysis is recorded, with its model's settled spend in this invocation. */
  onRecord: (analysis: MatrixAnalysis, modelSpentUsd: number) => void;
  /** Once true, no analysis starts; the ones in flight finish and are recorded. */
  stopped: () => boolean;
}

/**
 * Analyze each of the manifest's recorded runs with every model, `repeats` times, appending to
 * `manifest.analysisMatrix`. Every analysis is a new version (`--rerun`), so neither a repeat nor
 * an earlier analysis with the same configuration is reused.
 *
 * The plan orders analyses by repeat, then run, then model, and fixes each repeat number up front.
 * Up to `concurrency` analyses run at once and start in plan order. Each model's spend goes
 * through its own SpendLedger, which decides that model's analyses in plan order, so a budget stop
 * cuts each repeat at the same point in the run order, and the arms stay within one run of each
 * other, as with one analysis at a time. Records land in plan order whatever order the analyses
 * finish in, and `onRecord` is the one place a caller saves them.
 */
export async function runAnalysisMatrix(
  manifest: Manifest,
  options: MatrixOptions,
  analyze: typeof runCli = runCli,
): Promise<void> {
  const matrix = (manifest.analysisMatrix ??= []);
  const earlier = matrix.length;
  const ledgers = new Map(options.specs.map((spec) => [spec.label, new SpendLedger(options.budget)]));
  const runIds = manifest.runs.flatMap((run) => (run.runId === null ? [] : [run.runId]));
  const recorded = (runId: string, spec: string): number =>
    matrix.filter((prior) => prior.runId === runId && prior.spec === spec).length;
  const plan = Array.from({ length: options.repeats }, (_, pass) =>
    runIds.flatMap((runId) =>
      options.specs.map((spec) => ({ runId, spec, repeat: recorded(runId, spec.label) + pass + 1 })),
    ),
  ).flat();
  const position = new Map<MatrixAnalysis, number>();
  await mapWithConcurrency(plan, options.concurrency, async ({ runId, spec, repeat }, index) => {
    if (options.stopped()) return;
    const ledger = ledgers.get(spec.label) as SpendLedger;
    const { analysis } = await analyzeWithinBudget(
      { ...options, runId, spec, ledger, rerun: true, detached: true },
      analyze,
    );
    if (analysis.state === "not_run") return;
    const record: MatrixAnalysis = { runId, spec: spec.label, repeat, humanish: options.cliVersion, ...analysis };
    position.set(record, index);
    const added = [...matrix.splice(earlier), record].sort(
      (a, b) => (position.get(a) ?? 0) - (position.get(b) ?? 0),
    );
    matrix.push(...added);
    options.onRecord(record, ledger.spentUsd);
  });
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
