import {
  analysisRequestsText,
  resolveAutomaticAnalysis,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_TIMEOUT_MS,
} from "../../analysis/automatic-config.js";
import { Command, Option } from "commander";
import { forTerminal } from "../../routes/terminal/encoding.js";
import {
  analyzeRun,
  correctAnalysis,
  dryRunBundleRefusal,
  showAnalysis,
} from "../../analysis/service.js";
import { admissionRule } from "../../analysis/admission.js";
import type { AnalysisAdmission } from "../../analysis/execute.js";
import { listAnalyses } from "../../analysis/store.js";
import { listAnalysisExecutions } from "../../analysis/store-executions.js";
import { resolveRunPath } from "../../run/locate.js";
import {
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  discoverCliKeys,
  JSON_OPTION_DESCRIPTION,
  RUN_OPTION_DESCRIPTION,
  writeResult,
  humanError,
  wantsJson,
} from "../io.js";
import {
  type AnalysisFindings,
  analysisFindings,
  missingRunFindings,
  readRunAnalysis,
} from "../findings.js";
import { formatFindings } from "../findings-text.js";
import { resolvePhysicalCwd } from "../../run/paths.js";

/** Commander may collect a shared flag on the parent; only explicit values override leaf defaults. */
function analysisSelection<T extends { cwd: string; run: string }>(
  options: T,
  command: Command,
): T {
  const parent = command.parent;
  const selected = { ...options };
  for (const key of ["cwd", "run"] as const) {
    if (
      parent?.getOptionValueSource(key) === "cli" &&
      command.getOptionValueSource(key) !== "cli"
    ) {
      selected[key] = parent.getOptionValue(key) as T[typeof key];
    }
  }
  return selected;
}

export function registerAnalyzeCommand(parent: Command, io: CliIo): void {
  const analyze = parent
    .command("analyze")
    .enablePositionalOptions()
    .description(
      "Analyze retained participant evidence into versioned findings. Selected text and captures go to the chosen remote analyst. Opening Observer never starts analysis.",
    )
    .summary("Analyze a live run into evidence-linked findings.")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option(
      "--provider <name>",
      "Analyst: openai (default) or restricted codex account. No provider fallback.",
    )
    .option(
      "--max-cost <usd>",
      `Required for OpenAI, also with --dry-run: an analysis is refused before it sends anything if ${admissionRule("this")}. It does not limit billing. Unsupported for Codex.`,
    )
    .option(
      "--model <id>",
      "Supported vision model. OpenAI uses high effort; qualified Codex account analysis uses low effort.",
      DEFAULT_ANALYSIS_MODEL,
    )
    .option(
      "--question <text>",
      "Additional reviewer question; does not change participant instructions.",
    )
    .option(
      "--timeout-ms <ms>",
      "Request timeout, at most 600000 ms.",
      String(DEFAULT_ANALYSIS_TIMEOUT_MS),
    )
    .option(
      "--max-output-tokens <n>",
      "OpenAI response-token limit including reasoning, 256–32768. Omit for admission-based sizing. Unsupported for Codex.",
    )
    .option(
      "--dry-run",
      "Capture and validate local input and estimate admission; no request or analysis artifact.",
    )
    .option(
      "--rerun",
      "Create a new immutable version even when the same input and configuration were analyzed.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options, command) => handleAnalyze(io, options, command));
  analyze
    .command("list")
    .description("List immutable analysis versions, including failed attempts.")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options, command) => handleAnalyzeList(io, options, command));
  analyze
    .command("show")
    .description(
      "Print a run's analysis findings with the evidence each one cites. --json prints the validated analysis record and its correction history. Defaults to the latest usable version.",
    )
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--id <id>", "Exact analysis version.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options, command) => handleAnalyzeShow(io, options, command));
  analyze
    .command("correct")
    .description(
      "Append a human review note bound to one exact finding version; original claims remain intact.",
    )
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .requiredOption("--analysis <id>", "Analysis version to review.")
    .requiredOption("--finding <id>", "Finding to review.")
    .addOption(
      new Option("--status <status>", "Review disposition.")
        .choices(["confirmed", "dismissed", "amended"])
        .makeOptionMandatory(),
    )
    .requiredOption("--reason <text>", "Why this disposition is supported.")
    .option("--claim <text>", "Replacement claim, required only for amended findings.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options, command) => handleAnalyzeCorrect(io, options, command));
}

async function handleAnalyze(
  io: CliIo,
  options: {
    cwd: string;
    run: string;
    provider?: string;
    maxCost?: string;
    model: string;
    question?: string;
    timeoutMs: string;
    maxOutputTokens?: string;
    dryRun?: boolean;
    rerun?: boolean;
  },
  command: Command,
): Promise<void> {
  const selected = resolveAutomaticAnalysis({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    model: options.model,
    ...(options.question === undefined ? {} : { question: options.question }),
    timeoutMs: Number(options.timeoutMs),
    ...(options.provider === "codex" && options.maxCost === undefined
      ? {}
      : { maxCostUsd: Number(options.maxCost) }),
    ...(options.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: Number(options.maxOutputTokens) }),
  });
  if (!selected.ok || !selected.config) {
    const refusal = await dryRunBundleRefusal(
      await resolvePhysicalCwd(options.cwd),
      options.run,
      options.dryRun === true,
    );
    if (refusal) {
      writeResult(command, io, refusal, (value) => humanError(value.error));
      io.setExitCode(2);
      return;
    }
    const result = {
      schema: "humanish.analyze-result.v1",
      ok: false,
      run: options.run,
      dryRun: options.dryRun === true,
      reused: false,
      warnings: [],
      error: {
        code: "ANALYSIS_CONFIG_INVALID",
        message: selected.ok ? "Analysis is disabled." : selected.message,
      },
    };
    writeResult(command, io, result, (value) => humanError(value.error));
    io.setExitCode(2);
    return;
  }
  // Only a live OpenAI analysis sends OPENAI_API_KEY. A dry run and the Codex account analyst
  // read no provider key, so they skip discovery and its `gh auth token` spawn.
  if (options.dryRun !== true && selected.config.provider !== "codex")
    await discoverCliKeys({ io, cwd: options.cwd });
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.once("SIGINT", cancel);
  try {
    const result = await analyzeRun(
      options.cwd,
      options.run,
      {
        config: selected.config,
        preferLargerOutput: selected.preferLargerOutput === true,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
      },
      {
        signal: controller.signal,
        onProgress: (progress) =>
          io.writeErr(
            `Analysis ${progress.phase}: ${progress.evidenceCount} evidence items, ${progress.captureCount} captures.\n`,
          ),
      },
    );
    writeResult(command, io, result, (value) => {
      if (value.ok && value.dryRun && selected.config?.provider === "codex")
        return "Local evidence and configuration passed admission. Codex CLI, login and model access were not checked. Dollar cost and output-token ceiling are unknown. No provider request sent.\n";
      if (value.ok && value.dryRun) return admittedDryRunText(value.admission);
      const lines: string[] = [];
      if (value.artifactPath)
        lines.push(
          `${value.reused ? "Reused" : "Saved"} ${value.status} analysis: ${value.artifactPath}`,
        );
      if (value.executionReceiptPath)
        lines.push(`Execution receipt: ${value.executionReceiptPath}`);
      if (value.rejectedOutputPath)
        lines.push(`Rejected output, kept locally for diagnosis: ${value.rejectedOutputPath}`);
      if (value.usage) {
        lines.push(
          `Recorded attempt usage${value.usage.usageComplete ? "" : " (incomplete)"}: ${value.usage.inputTokens ?? "unknown"} input tokens, ${value.usage.outputTokens ?? "unknown"} output tokens.`,
        );
        lines.push(
          `Estimated attempt cost: ${value.usage.estimatedCostUsd === null ? "unknown" : `$${value.usage.estimatedCostUsd}`}.`,
        );
      }
      if (value.reused) lines.push("No new request sent.");
      lines.push(...value.warnings);
      const stdout = lines.length === 0 ? "" : forTerminal(lines.join("\n") + "\n");
      // A failed analysis keeps its artifact and usage lines on stdout; the error goes to stderr.
      if (value.ok) return stdout;
      const error = value.error ?? { message: "Analysis unavailable." };
      return { ...(stdout ? { stdout } : {}), error };
    });
    io.setExitCode(result.ok ? 0 : 2);
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

async function handleAnalyzeList(
  io: CliIo,
  options: { cwd: string; run: string },
  command: Command,
): Promise<void> {
  options = analysisSelection(options, command);
  const prepared = await resolveRunPath(await resolvePhysicalCwd(options.cwd), options.run).catch(
    () => null,
  );
  const versions = prepared ? await listAnalyses(prepared) : [];
  const executions = prepared
    ? await listAnalysisExecutions(prepared)
    : { receipts: [], warnings: [] };
  const result = {
    schema: "humanish.analysis-history.v1",
    ok: prepared !== null,
    run: options.run,
    executions: executions.receipts,
    warnings: executions.warnings,
    versions: versions.map(({ id, state, analysis, warnings }) => ({
      id,
      state,
      status: analysis?.status ?? null,
      createdAt: analysis?.createdAt ?? null,
      findings: analysis?.result?.findings.length ?? null,
      usage: analysis?.usage ?? null,
      warnings,
    })),
  };
  writeResult(command, io, result, (value) => forTerminal(JSON.stringify(value, null, 2) + "\n"));
  io.setExitCode(result.ok ? 0 : 2);
}

async function handleAnalyzeShow(
  io: CliIo,
  options: { cwd: string; run: string; id?: string },
  command: Command,
): Promise<void> {
  options = analysisSelection(options, command);
  if (wantsJson(command)) {
    const result = await showAnalysis(options.cwd, options.run, options.id);
    writeResult(command, io, result, () => "");
    io.setExitCode(result.state === "invalid" ? 2 : 0);
    return;
  }
  const source = await readRunAnalysis(options.cwd, options.run, options.id);
  const findings = source ? analysisFindings(source) : missingRunFindings(options.cwd, options.run);
  writeResult(command, io, findings, formatAnalysisShowHuman);
  // The exit code the --json form gives for the same record.
  io.setExitCode(source === null || source.loaded.state === "invalid" ? 2 : 0);
}

/**
 * `analyze show` without --json: the findings, or why there are none and the command that gets
 * them.
 */
function formatAnalysisShowHuman(findings: AnalysisFindings): string {
  return (
    [`humanish analyze show ${findings.runId}`, "", ...formatFindings(findings)].join("\n") + "\n"
  );
}

async function handleAnalyzeCorrect(
  io: CliIo,
  options: {
    cwd: string;
    run: string;
    analysis: string;
    finding: string;
    status: "confirmed" | "dismissed" | "amended";
    reason: string;
    claim?: string;
  },
  command: Command,
): Promise<void> {
  options = analysisSelection(options, command);
  try {
    const correction = await correctAnalysis(options.cwd, options.run, {
      analysisId: options.analysis,
      findingId: options.finding,
      status: options.status,
      reason: options.reason,
      ...(options.claim === undefined ? {} : { replacementClaim: options.claim }),
    });
    writeResult(
      command,
      io,
      { schema: "humanish.analysis-correction-result.v1", ok: true, correction },
      (value) => `Saved correction ${value.correction.id}. Original analysis preserved.\n`,
    );
    io.setExitCode(0);
  } catch (error) {
    const code =
      error instanceof Error &&
      ["ANALYSIS_BUSY", "ANALYSIS_CORRECTION_HISTORY_UNAVAILABLE"].includes(error.message)
        ? error.message
        : "ANALYSIS_CORRECTION_INVALID";
    const message =
      code === "ANALYSIS_BUSY"
        ? "Another analysis or correction holds this run's lock. Retry after it finishes."
        : code === "ANALYSIS_CORRECTION_HISTORY_UNAVAILABLE"
          ? "Correction history is unavailable or full. No correction was added; existing records were preserved."
          : "Correction requires a current valid finding, a reason, and a replacement claim only for amended status. Sensitive text is rejected.";
    writeResult(
      command,
      io,
      {
        schema: "humanish.analysis-correction-result.v1",
        ok: false,
        error: { code, message },
      },
      (value) => value.error.message + "\n",
    );
    io.setExitCode(2);
  }
}

/**
 * An admitted dry run's costs: the expected cost, the worst case and the cap it was admitted
 * under. The worst case of an analysis in cohorts is every request writing its whole allowance.
 */
function admittedDryRunText(admission: AnalysisAdmission | undefined): string {
  const usd = (value: number | null | undefined): string =>
    value === null || value === undefined ? "unknown" : `$${value.toFixed(2)}`;
  const requests = analysisRequestsText(admission?.requests ?? 1);
  const writer =
    requests === undefined ? "the analyst writes its" : `every request (${requests}) writes its`;
  return `Expected cost: ${usd(admission?.estimatedCostUsd)}. Worst case: ${usd(admission?.worstCaseCostUsd)}, if ${writer} whole ${admission?.outputTokenAllowance ?? "unknown"}-token output allowance, reasoning included. Admitted under the $${admission?.maxCostUsd ?? "unknown"} cap. No request sent.\n`;
}
