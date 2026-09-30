import {
  resolveAutomaticAnalysis,
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_TIMEOUT_MS,
} from "../../analysis/automatic-config.js";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { forTerminal } from "../../routes/terminal/encoding.js";
import {
  analyzeStudy,
  correctStudyAnalysis,
  dryRunBundleRefusal,
  showStudyAnalysis,
} from "../../analysis/service.js";
import { listStudyAnalyses, listStudyAnalysisExecutions } from "../../analysis/store.js";
import { resolveRunPath } from "../../run/locate.js";
import { type CliIo, JSON_OPTION_DESCRIPTION, writeResult } from "../io.js";

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
    .summary("Generate evidence-linked study findings.")
    .option("--run <id>", "Completed run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option(
      "--provider <name>",
      "Analyst: openai (default) or restricted codex account. No provider fallback.",
    )
    .option(
      "--max-cost <usd>",
      "Required for OpenAI, including dry-run: USD admission estimate ceiling, not a billing cap. Unsupported for Codex.",
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
    .action(
      async (
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
        command,
      ) => {
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
            resolve(options.cwd),
            options.run,
            options.dryRun === true,
          );
          if (refusal) {
            writeResult(command, io, refusal, (value) =>
              forTerminal(`${value.error?.message ?? ""}\n${value.error?.code ?? ""}\n`),
            );
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
          writeResult(command, io, result, (value) => `${value.error.message}\n`);
          io.setExitCode(2);
          return;
        }
        const controller = new AbortController();
        const cancel = (): void => controller.abort();
        process.once("SIGINT", cancel);
        try {
          const result = await analyzeStudy(
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
            if (value.ok && value.dryRun)
              return `Admission estimate: $${value.admission?.estimatedCostUsd ?? "unknown"}; output allowance: ${value.admission?.outputTokenAllowance ?? "unknown"} tokens including reasoning. No request sent.\n`;
            const lines: string[] = [];
            if (!value.ok)
              lines.push(value.error?.message ?? "Analysis unavailable.", value.error?.code ?? "");
            if (value.artifactPath)
              lines.push(
                `${value.reused ? "Reused" : "Saved"} ${value.status} analysis: ${value.artifactPath}`,
              );
            if (value.executionReceiptPath)
              lines.push(`Execution receipt: ${value.executionReceiptPath}`);
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
            return forTerminal(lines.filter(Boolean).join("\n") + "\n");
          });
          io.setExitCode(result.ok ? 0 : 2);
        } finally {
          process.removeListener("SIGINT", cancel);
        }
      },
    );
  analyze
    .command("list")
    .description("List immutable analysis versions, including failed attempts.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; run: string }, command) => {
      options = analysisSelection(options, command);
      const prepared = await resolveRunPath(resolve(options.cwd), options.run).catch(() => null);
      const versions = prepared ? await listStudyAnalyses(prepared) : [];
      const executions = prepared
        ? await listStudyAnalysisExecutions(prepared)
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
      writeResult(command, io, result, (value) =>
        forTerminal(JSON.stringify(value, null, 2) + "\n"),
      );
      io.setExitCode(result.ok ? 0 : 2);
    });
  analyze
    .command("show")
    .description(
      "Read validated analysis and correction history. Defaults to the latest usable version.",
    )
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--id <id>", "Exact analysis version.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; run: string; id?: string }, command) => {
      options = analysisSelection(options, command);
      const result = await showStudyAnalysis(options.cwd, options.run, options.id);
      writeResult(command, io, result, (value) =>
        forTerminal(JSON.stringify(value, null, 2) + "\n"),
      );
      io.setExitCode(result.state === "invalid" ? 2 : 0);
    });
  analyze
    .command("correct")
    .description(
      "Append a human review note bound to one exact finding version; original claims remain intact.",
    )
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
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
    .action(
      async (
        options: {
          cwd: string;
          run: string;
          analysis: string;
          finding: string;
          status: "confirmed" | "dismissed" | "amended";
          reason: string;
          claim?: string;
        },
        command,
      ) => {
        options = analysisSelection(options, command);
        try {
          const correction = await correctStudyAnalysis(options.cwd, options.run, {
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
      },
    );
}
