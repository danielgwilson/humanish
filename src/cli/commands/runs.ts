import path from "node:path";
import { Command, Option } from "commander";
import { shellQuote } from "../../substrates/shell.js";
import { computeStats, formatStatsHuman } from "../../run/stats.js";
import { DEFAULT_EXPORT_MAX_BYTES, exportRun, formatExportHuman } from "../../feedback/export.js";
import { cleanupRun, listRuns, readReview } from "../../run/stored-runs.js";
import { verifyRun } from "../../verify/verify.js";
import {
  reclaimPreflightSandboxes,
  reclaimRunSandboxes,
  type ReclaimResult,
} from "../../run/reclaim.js";
import type { CleanupResult } from "../../run/results.js";
import type { ReviewSummary } from "../../run/bundle.js";
import type { RunsResult } from "../../run/stored-runs.js";
import type { VerifyResult } from "../../verify/verify.js";
import { addRunOptions, handleRun, type RunOptions } from "./run-command.js";
import { oldStudyOption, studyOptionValue } from "../deprecations.js";
import {
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  RUN_OPTION_DESCRIPTION,
  writeResult,
  humanError,
  type HumanOutput,
} from "../io.js";
import { plural } from "../../run/text.js";

export function registerRunCommand(parent: Command, io: CliIo): void {
  addRunOptions(
    parent
      .command("run")
      .argument("[study]", "Optional study id or .yaml path.")
      .description(
        "Run a study, as a dry run or with live participants. This is the everyday command.",
      )
      .summary("Run a study, as a dry run or with live participants."),
  ).action((study: string | undefined, options: RunOptions, command: Command) =>
    handleRun(io, study, options, command),
  );
}

export function registerVerifyCommand(parent: Command, io: CliIo): void {
  parent
    .command("verify")
    .description("Check a run's evidence and share safety.")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--verbose", "Print every check, passing ones included.")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (options: { cwd: string; json?: boolean; run: string; verbose?: boolean }, command) => {
        const result = await verifyRun(options.cwd, options.run);
        writeResult(command, io, result, (value) =>
          options.verbose ? formatVerifyVerbose(value) : formatVerifyHuman(value),
        );
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

export function registerCleanupCommand(parent: Command, io: CliIo): void {
  parent
    .command("cleanup")
    .description(
      "Check a run's recorded resources and write cleanup.json. It stops nothing; humanish reclaim stops leftover sandboxes.",
    )
    .summary("Check that a run's resources were stopped.")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await cleanupRun(options.cwd, options.run);
      writeResult(command, io, result, (value) => formatCleanupHuman(value, options.cwd));
      io.setExitCode(result.ok ? 0 : 2);
    });
}

export function registerReviewCommand(parent: Command, io: CliIo): void {
  parent
    .command("review")
    .description("Show a run's review: verdict, summary and gaps.")
    .summary("Build a review packet from verified run evidence.")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await readReview(options.cwd, options.run);
      writeResult(command, io, result, formatReviewHuman);
      io.setExitCode("ok" in result && result.ok === false ? 2 : 0);
    });
}

export function registerExportCommand(parent: Command, io: CliIo): void {
  parent
    .command("export")
    .description(
      "Export a run as self-contained Observer HTML, or a separately verified redacted bundle workspace. HTML requires share_ready unless --local-only; bundle format requires --redact-screenshots and preserves the original.",
    )
    .summary("Export a run as an Observer page or redacted bundle.")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .addOption(
      new Option("--format <format>", "Output format; bundle creates a new standalone workspace.")
        .choices(["html", "bundle"])
        .default("html"),
    )
    .option(
      "--redact-screenshots",
      "Bundle only: blur PNG screenshots in a verified copy; keep original evidence unchanged.",
    )
    .option(
      "--out <path>",
      "HTML file or new bundle workspace. Default: .humanish/exports/<runId>.html or <runId>-redacted/.",
    )
    .option(
      "--local-only",
      'Export a bundle that is not share_ready, with a "Local only" banner in the file.',
    )
    .addOption(
      new Option("--max-bytes <n>", "Refuse an export larger than this many bytes.").default(
        String(DEFAULT_EXPORT_MAX_BYTES),
        `${DEFAULT_EXPORT_MAX_BYTES / 1024 / 1024} MB`,
      ),
    )
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: {
          cwd: string;
          json?: boolean;
          run: string;
          out?: string;
          localOnly?: boolean;
          maxBytes: string;
          format: "html" | "bundle";
          redactScreenshots?: boolean;
        },
        command,
      ) => {
        const maxBytes =
          options.format === "bundle"
            ? Number(options.maxBytes)
            : Number.parseInt(options.maxBytes, 10);
        const result = await exportRun(options.cwd, options.run, {
          format: options.format,
          ...(options.redactScreenshots === undefined
            ? {}
            : { redactScreenshots: options.redactScreenshots }),
          ...(options.out === undefined ? {} : { out: options.out }),
          ...(options.localOnly === undefined ? {} : { localOnly: options.localOnly }),
          ...(options.format === "bundle" || (Number.isFinite(maxBytes) && maxBytes > 0)
            ? { maxBytes }
            : {}),
        });
        writeResult(command, io, result, formatExportHuman);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

export function registerStatsCommand(parent: Command, io: CliIo): void {
  parent
    .command("stats")
    .description(
      "Cost, outcome, and duration roll-ups across run history. Estimates stay labelled; unknown costs count as unknown.",
    )
    .summary("Show cost, outcomes and durations across runs.")
    .option("--study <id>", "Only runs of this study id.")
    .addOption(oldStudyOption("id"))
    .option("--since <date>", "Only runs that started on or after this ISO date or datetime.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: { cwd: string; json?: boolean; study?: string; lab?: string; since?: string },
        command,
      ) => {
        const study = studyOptionValue(command, io, options);
        const result = await computeStats(options.cwd, {
          ...(study === undefined ? {} : { lab: study }),
          ...(options.since === undefined ? {} : { since: options.since }),
        });
        writeResult(command, io, result, formatStatsHuman);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

export function registerRunsCommand(parent: Command, io: CliIo): void {
  parent
    .command("runs")
    .description("List this project's runs and which one is latest.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean }, command) => {
      const result = await listRuns(options.cwd);
      writeResult(command, io, result, formatRunsHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

export function registerRuntimeCommands(parent: Command, io: CliIo): void {
  const runtime = parent
    .command("runtime")
    .description("Prepare or inspect the local browser runtime.");
  for (const action of ["status", "setup"] as const) {
    runtime
      .command(action)
      .description(
        action === "status"
          ? "Check local Docker, virtualization and the cached browser image without downloads."
          : "Download and install the local browser image. Does not start a study or use model quota.",
      )
      .option("--json", JSON_OPTION_DESCRIPTION)
      .option("--media", "Prepare or inspect the optional camera and speech runtime.")
      .action(async (_options, command) => {
        const { localRuntimeStatus, prepareLocalRuntime } =
          await import("../../substrates/local/runtime.js");
        try {
          if (action === "setup")
            await prepareLocalRuntime({
              media: _options.media === true,
              progress: (message) => io.writeErr(`${message}\n`),
            });
          const status = await localRuntimeStatus({ media: _options.media === true });
          const result = { schema: "humanish.runtime-result.v1", ...status };
          writeResult(command, io, result, () => `${status.message}\n`);
          io.setExitCode(status.ok ? 0 : 2);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Local runtime setup failed. Run humanish runtime setup to retry.";
          const result = {
            schema: "humanish.runtime-result.v1",
            ok: false,
            error: { code: "HUMANISH_LOCAL_RUNTIME_SETUP_FAILED", message },
          };
          writeResult(command, io, result, () => `${message}\n`);
          io.setExitCode(2);
        }
      });
  }
}

export function registerReclaimCommand(parent: Command, io: CliIo): void {
  parent
    .command("reclaim")
    .description(
      "Kill an interrupted run's sandboxes by the exact ids journaled in its sandbox-receipts.ndjson; never enumerates the E2B account. Needs E2B_API_KEY in the environment.",
    )
    .summary("Stop an interrupted run's leftover sandboxes.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .addOption(
      new Option(
        "--preflight",
        "Reclaim sandboxes left by interrupted `humanish study check` probes (journaled in .humanish/preflight) instead of a run's.",
      ).conflicts("run"),
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        options: { cwd: string; run: string; preflight?: boolean; json?: boolean },
        command,
      ) => {
        const result = options.preflight
          ? await reclaimPreflightSandboxes(options.cwd)
          : await reclaimRunSandboxes(options.cwd, options.run);
        writeResult(command, io, result, formatReclaimHuman);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

function formatReclaimHuman(result: ReclaimResult): HumanOutput {
  const lines: string[] = [];
  lines.push(
    `Reclaim ${result.runId}: ${result.ok ? "ok" : "failed"}, ${plural(result.receiptCount, "sandbox receipt")}.`,
  );
  for (const outcome of result.outcomes) {
    lines.push(
      `  ${outcome.sandboxId} (${outcome.laneId}): ${outcome.state}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
    );
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  const stdout = lines.join("\n");
  return result.error === undefined ? stdout : { stdout: `${stdout}\n`, error: result.error };
}

const REVIEW_VERDICTS: Record<ReviewSummary["verdict"], string> = {
  // A dry run, or a live run with no participant result; review's result does not carry the mode.
  contract_proof_only: "no verdict; no product behavior was tested",
  pass: "pass",
  fail: "fail",
  blocked: "blocked",
  timed_out: "timed out",
};

/** A run's review: its verdict, summary and gaps, and where review.json is. */
function formatReviewHuman(
  result: VerifyResult | (ReviewSummary & { path: string; runId: string }),
): HumanOutput {
  if (!("verdict" in result)) {
    // A run that did not pass verify has no review to show; verify says why.
    const error = result.error ?? {
      code: "HUMANISH_INVALID_RUN_BUNDLE",
      message: "Run bundle failed verification.",
    };
    return error.code === "HUMANISH_INVALID_RUN_BUNDLE"
      ? {
          error: {
            ...error,
            message: `${error.message} humanish verify --run ${result.run} shows why.`,
          },
        }
      : humanError(error);
  }
  return (
    [
      `humanish review ${result.runId}: ${REVIEW_VERDICTS[result.verdict]}`,
      "",
      result.summary,
      ...(result.gaps.length === 0 ? [] : ["", "gaps:", ...result.gaps.map((gap) => `- ${gap}`)]),
      "",
      `review: ${result.path}`,
    ].join("\n") + "\n"
  );
}

/** The run id verify read, from the bundle path, so `latest` prints as the id it points at. */
function verifiedRunId(result: VerifyResult): string {
  return result.bundlePath === undefined
    ? result.run
    : path.basename(path.dirname(result.bundlePath));
}

/** Share-safety reasons, except VERIFY_FAILED, which the failing checks above it already say. */
function shareSafetyLines(result: VerifyResult): string[] {
  return result.shareSafety.reasons
    .filter((reason) => reason.code !== "VERIFY_FAILED")
    .map((reason) => `share-safety: ${reason.code}: ${reason.message}`);
}

/**
 * One line for a pass. A failure lists only the failing checks. `--verbose` prints every check.
 * A run that does not exist prints only that.
 */
function formatVerifyHuman(result: VerifyResult): HumanOutput {
  if (result.error?.code === "HUMANISH_RUN_NOT_FOUND") return humanError(result.error);
  const runId = verifiedRunId(result);
  const total = result.checks.length;
  const failed = result.checks.filter((check) => !check.ok);
  const lines = result.ok
    ? [`verified ${runId} · ${result.shareSafety.status} · ${total} checks passed`]
    : [
        `verify failed: ${runId} · ${result.shareSafety.status} · ${failed.length} of ${total} checks failed`,
        ...failed.map((check) => `- ${check.message}`),
      ];
  lines.push(
    ...shareSafetyLines(result),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  );
  const cwdFlag = result.cwd === process.cwd() ? "" : ` --cwd ${result.cwd}`;
  if (!result.ok) lines.push(`every check: humanish verify --run ${runId}${cwdFlag} --verbose`);
  return `${lines.join("\n")}\n`;
}

function formatVerifyVerbose(result: VerifyResult): HumanOutput {
  if (result.error?.code === "HUMANISH_RUN_NOT_FOUND") return humanError(result.error);
  return (
    [
      `humanish verify ${result.ok ? "passed" : "failed"}`,
      `run: ${verifiedRunId(result)}`,
      `share-safety: ${result.shareSafety.status}`,
      ...result.shareSafety.reasons.map(
        (reason) => `share-safety reason: ${reason.code}: ${reason.message}`,
      ),
      ...result.checks.map(
        (check) => `- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`,
      ),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

/** A command-line argument, single-quoted only when the shell would split or expand it. */
function shellArg(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * Cleanup only reads evidence and never stops a sandbox. A failed resource is an E2B sandbox not
 * recorded as stopped, which reclaim can stop from the run's sandbox receipts, so the last line
 * names it. A skipped resource is a provider reclaim does not handle, so it gets no line. `cwd` is
 * the --cwd the command was given, since cleanup's result masks it.
 */
function reclaimPointer(result: CleanupResult, cwd: string): string[] {
  if (result.runId === undefined || result.summary.failed === 0) return [];
  const cwdFlag = cwd === "." ? "" : ` --cwd ${shellArg(cwd)}`;
  return [
    `To stop leftover sandboxes, run humanish reclaim --run ${shellArg(result.runId)}${cwdFlag}.`,
  ];
}

function formatCleanupHuman(result: CleanupResult, cwd: string): HumanOutput {
  if (!result.ok && result.error) return humanError(result.error);

  return (
    [
      `humanish cleanup ${result.ok ? "passed" : "failed"}`,
      `run: ${result.runId ?? result.run}`,
      `resources: already-clean ${result.summary.alreadyClean}, skipped ${result.summary.skipped}, failed ${result.summary.failed}`,
      ...(result.cleanupPath ? [`cleanup: ${result.cleanupPath}`] : []),
      ...result.warnings.map((warning) => `warning: ${warning}`),
      ...reclaimPointer(result, cwd),
    ].join("\n") + "\n"
  );
}

function formatRunsHuman(result: RunsResult): HumanOutput {
  if (!result.ok) return humanError(result.error);

  if (result.runs.length === 0) {
    return `No humanish runs found in ${result.cwd}\n`;
  }

  return (
    [
      `latest: ${result.latest ?? "none"}`,
      ...result.runs.map(
        (run) =>
          `- ${run.runId} ${run.mode ?? "unknown"} ${run.createdAt ?? "unknown"} ${run.path}`,
      ),
    ].join("\n") + "\n"
  );
}
