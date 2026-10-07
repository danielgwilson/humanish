import path from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { shellArg } from "../../substrates/shell.js";
import { computeStats, formatStatsHuman } from "../../run/stats.js";
import { DEFAULT_EXPORT_MAX_BYTES, exportRun, formatExportHuman } from "../../feedback/export.js";
import { listRuns, readReview } from "../../run/stored-runs.js";
import { verifyRun } from "../../verify/verify.js";
import {
  reclaimPreflightSandboxes,
  reclaimRunSandboxes,
  type ReclaimResult,
} from "../../run/reclaim.js";
import type { ReviewSummary } from "../../run/bundle.js";
import type { RunsResult } from "../../run/stored-runs.js";
import { runDisplay, type RunDisplay } from "../../run/display.js";
import type { VerifyResult } from "../../verify/verify.js";
import { addRunOptions, handleRun, type RunOptions } from "./run-command.js";
import {
  applyEnvFileOption,
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  DOTENV_OPTION_DESCRIPTION,
  dotenvPathOf,
  envFileAliasOption,
  JSON_OPTION_DESCRIPTION,
  parsePositiveInteger,
  RUN_OPTION_DESCRIPTION,
  writeResult,
  humanError,
  type HumanOutput,
} from "../io.js";
import { plural } from "../../run/text.js";
import { warnAndQueue } from "../deprecations.js";
import { type AnalysisFindings, formatFindings, readRunFindings } from "../findings.js";
import { cli } from "../invocation.js";

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

const CLEANUP_RENAMED =
  "`cleanup` is now `reclaim --check`; `cleanup` is removed in the first minor release on or after 2026-11-03.";

/**
 * The deprecated `cleanup`, hidden from help: one warning, then exactly `reclaim --check`, with
 * its output and exit code. The old command read only what computer-use runs recorded and passed
 * when it found no record; the check asks E2B.
 */
export function registerCleanupCommand(parent: Command, io: CliIo): void {
  parent
    .command("cleanup", { hidden: true })
    .description(`Deprecated: ${CLEANUP_RENAMED}`)
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--dotenv <path>", DOTENV_OPTION_DESCRIPTION)
    .addOption(envFileAliasOption())
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: ReclaimCommandOptions, command: Command) => {
      warnAndQueue(command, io, CLEANUP_RENAMED);
      await runReclaimCommand(io, command, { ...options, check: true });
    });
}

export function registerReviewCommand(parent: Command, io: CliIo): void {
  parent
    .command("review")
    .description(
      "Show a run's review: verdict, summary, gaps and the findings of its analysis, with the evidence each one cites.",
    )
    .summary("Show a run's outcome and analysis findings.")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const review = await readReview(options.cwd, options.run);
      // The verified run's exact id, so a run that moves `latest` meanwhile cannot swap the analysis.
      const result =
        "verdict" in review
          ? { ...review, analysis: await readRunFindings(options.cwd, review.runId) }
          : review;
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
    .option("--since <date>", "Only runs that started on or after this ISO date or datetime.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (options: { cwd: string; json?: boolean; study?: string; since?: string }, command) => {
        const result = await computeStats(options.cwd, {
          ...(options.study === undefined ? {} : { study: options.study }),
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

/** A whole number of GiB or CPUs above zero, for `runtime setup --memory` and `--cpus`. */
function wholeNumber(flag: string): (value: string) => number {
  return (value) => {
    const parsed = parsePositiveInteger(value);
    if (parsed === null)
      throw new InvalidArgumentError(`${flag} takes a whole number above zero, such as 8.`);
    return parsed;
  };
}

export function registerRuntimeCommands(parent: Command, io: CliIo): void {
  const runtime = parent
    .command("runtime")
    .description("Prepare or inspect the local browser runtime.");
  for (const action of ["status", "setup"] as const) {
    const command = runtime
      .command(action)
      .description(
        action === "status"
          ? "Check local Docker, virtualization and the cached browser image without downloads, and how many participant desktops fit."
          : "Download and install the local browser image. Does not start a study or use model quota.",
      )
      .option("--json", JSON_OPTION_DESCRIPTION)
      .option("--media", "Prepare or inspect the optional camera and speech runtime.");
    if (action === "setup")
      command
        .option(
          "--memory <GiB>",
          "Mac only: the humanish Lima VM's memory. Resizes an existing VM, which stops it first.",
          wholeNumber("--memory"),
        )
        .option(
          "--cpus <n>",
          "Mac only: the humanish Lima VM's CPUs. Resizes an existing VM, which stops it first.",
          wholeNumber("--cpus"),
        );
    command.action(
      async (
        options: { json?: boolean; media?: boolean; memory?: number; cpus?: number },
        command: Command,
      ) => {
        const { localRuntimeStatus, prepareLocalRuntime } =
          await import("../../substrates/local/runtime.js");
        const { describeCapacity } = await import("../../substrates/local/capacity.js");
        const media = options.media === true;
        try {
          if (action === "setup") {
            const size = {
              ...(options.memory === undefined ? {} : { memoryGiB: options.memory }),
              ...(options.cpus === undefined ? {} : { cpus: options.cpus }),
            };
            await prepareLocalRuntime({
              media,
              ...(Object.keys(size).length === 0 ? {} : { size }),
              progress: (message) => io.writeErr(`${message}\n`),
            });
          }
          const status = await localRuntimeStatus({ media });
          const result = { schema: "humanish.runtime-result.v1", ...status };
          writeResult(command, io, result, () =>
            [status.message, ...(status.capacity ? [describeCapacity(status.capacity)] : [])]
              .map((line) => `${line}\n`)
              .join(""),
          );
          io.setExitCode(status.ok ? 0 : 2);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : `Local runtime setup failed. Run ${cli("runtime setup")} to retry.`;
          const result = {
            schema: "humanish.runtime-result.v1",
            ok: false,
            error: { code: "HUMANISH_LOCAL_RUNTIME_SETUP_FAILED", message },
          };
          writeResult(command, io, result, () => `${message}\n`);
          io.setExitCode(2);
        }
      },
    );
  }
}

export function registerReclaimCommand(parent: Command, io: CliIo): void {
  parent
    .command("reclaim")
    .description(
      "Kill an interrupted run's sandboxes: the exact ids journaled in its sandbox-receipts.ndjson, and any sandbox E2B lists with this run's owner tags (a sandbox whose id never reached a receipt). It lists only sandboxes that match every tag of this run. --check asks E2B whether each still exists and kills nothing. Needs E2B_API_KEY in the environment or in --dotenv.",
    )
    .summary("Stop or check an interrupted run's sandboxes.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--run <id>", RUN_OPTION_DESCRIPTION, "latest")
    .addOption(
      new Option(
        "--preflight",
        "Reclaim sandboxes left by interrupted `humanish study check` probes (journaled in .humanish/preflight) instead of a run's.",
      ).conflicts("run"),
    )
    .option(
      "--check",
      "Ask E2B whether each sandbox still exists; kill nothing and write nothing. Exits 0 only when all are gone.",
    )
    .option("--dotenv <path>", DOTENV_OPTION_DESCRIPTION)
    .addOption(envFileAliasOption())
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options: ReclaimCommandOptions, command: Command) =>
      runReclaimCommand(io, command, options),
    );
}

interface ReclaimCommandOptions {
  cwd: string;
  run: string;
  preflight?: boolean;
  check?: boolean;
  dotenv?: string;
  envFile?: string;
  json?: boolean;
}

/** `reclaim`, and the deprecated `cleanup`, which runs it with `check`. */
async function runReclaimCommand(
  io: CliIo,
  command: Command,
  options: ReclaimCommandOptions,
): Promise<void> {
  // The kill calls read E2B_API_KEY from the environment: the env file, then discovered keys.
  if (
    !(await applyEnvFileOption({
      command,
      cwd: options.cwd,
      envFile: dotenvPathOf(options, command, io),
      io,
    }))
  )
    return;
  const hooks = { check: options.check === true };
  const result = options.preflight
    ? await reclaimPreflightSandboxes(options.cwd, hooks)
    : await reclaimRunSandboxes(options.cwd, options.run, hooks);
  writeResult(command, io, result, (value) =>
    formatReclaimHuman(value, options.cwd, options.preflight === true),
  );
  io.setExitCode(result.ok ? 0 : 2);
}

/** The command that finishes what a reclaim left open, with --cwd when it was given. */
function reclaimCommand(result: ReclaimResult, cwd: string, preflight: boolean): string {
  const target = preflight ? "--preflight" : `--run ${shellArg(result.runId)}`;
  return cli(`reclaim ${target}${cwd === "." ? "" : ` --cwd ${shellArg(cwd)}`}`);
}

function formatReclaimHuman(result: ReclaimResult, cwd: string, preflight: boolean): HumanOutput {
  const lines: string[] = [];
  const check = result.mode === "check";
  const search =
    result.tagSearch.status === "done"
      ? `E2B lists ${plural(result.tagSearch.found, "more sandbox", "more sandboxes")} tagged with it`
      : `E2B tag search ${result.tagSearch.status}`;
  const head = `${check ? "Reclaim check" : "Reclaim"} ${result.runId}: ${result.state}.`;
  lines.push(
    result.reason === "dry-run"
      ? `${head} It was a dry run, which creates no sandboxes, so E2B was not contacted.`
      : result.reason === "no-sandbox"
        ? `${head} Its status.json records that its route created no sandbox, so E2B was not contacted.`
        : `${head} ${plural(result.receiptCount, "sandbox receipt")}; ${search}.`,
  );
  for (const outcome of result.outcomes) {
    lines.push(
      `  sandbox ${outcome.sandboxIdDigest} (${outcome.laneId}, from ${outcome.source}): ${outcome.state}${outcome.detail ? `: ${outcome.detail}` : ""}`,
    );
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.error === undefined && result.state !== "clean")
    lines.push(
      result.state === "running"
        ? `To stop them, run ${reclaimCommand(result, cwd, preflight)}.`
        : `Run ${reclaimCommand(result, cwd, preflight)} again once E2B is reachable; each sandbox's create-time timeout is the backstop.`,
    );
  const stdout = `${lines.join("\n")}\n`;
  return result.error === undefined ? stdout : { stdout, error: result.error };
}

const NOTHING_TESTED = "no product behavior was tested";

const REVIEW_VERDICTS: Record<ReviewSummary["verdict"], string> = {
  // A dry run, or a live run with no participant result; review's result does not carry the mode.
  contract_proof_only: `no verdict; ${NOTHING_TESTED}`,
  pass: "pass",
  fail: "fail",
  blocked: "blocked",
  timed_out: "timed out",
};

/**
 * Review's headline: the run's display label, as `humanish runs`, review.md and the Observer show
 * it. A verdict that names another state follows in parentheses, so an interrupted run whose last
 * flush judged its participants `fail` reads "interrupted (verdict fail)". A run with no display,
 * which verify does not pass, falls back to the verdict.
 */
function reviewHeadline(
  verdict: ReviewSummary["verdict"],
  display: RunDisplay | undefined,
): string {
  if (display === undefined) return REVIEW_VERDICTS[verdict];
  if (display.state === "no_verdict" || display.state === "dry_run")
    return `${display.label}; ${NOTHING_TESTED}`;
  const judged = runDisplay({ liveness: "finished", verdict }).state;
  return verdict === "contract_proof_only" || judged === display.state
    ? display.label
    : `${display.label} (verdict ${REVIEW_VERDICTS[verdict]})`;
}

/**
 * A run's review: how it ended (runDisplay) and why it failed when it says, its summary and gaps,
 * its analysis findings, and where review.json is.
 */
function formatReviewHuman(
  result:
    | VerifyResult
    | (ReviewSummary & {
        path: string;
        runId: string;
        analysis: AnalysisFindings;
        display?: RunDisplay;
      }),
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
            message: `${error.message} ${cli(`verify --run ${result.run}`)} shows why.`,
          },
        }
      : humanError(error);
  }
  const display = result.display;
  return (
    [
      `humanish review ${result.runId}: ${reviewHeadline(result.verdict, display)}`,
      ...(display?.reason === undefined ? [] : [`why: ${display.reason}`]),
      "",
      result.summary,
      ...(result.gaps.length === 0 ? [] : ["", "gaps:", ...result.gaps.map((gap) => `- ${gap}`)]),
      "",
      ...formatFindings(result.analysis),
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

/** For a run that is not finished, its liveness and sandbox state, so the line leads with them. */
function unfinishedNote(result: VerifyResult): string {
  return result.unfinished === undefined
    ? ""
    : ` (${result.unfinished.liveness}, sandboxes ${result.unfinished.sandboxes})`;
}

/**
 * One line for a pass. A failure lists only the failing checks. `--verbose` prints every check.
 * A run that does not exist prints only that.
 */
function formatVerifyHuman(result: VerifyResult): HumanOutput {
  if (result.error?.code === "HUMANISH_RUN_NOT_FOUND") return humanError(result.error);
  const runId = verifiedRunId(result);
  const named = `${runId}${unfinishedNote(result)}`;
  const total = result.checks.length;
  const failed = result.checks.filter((check) => !check.ok);
  const lines = result.ok
    ? [`verified ${named} · ${result.shareSafety.status} · ${total} checks passed`]
    : [
        `verify failed: ${named} · ${result.shareSafety.status} · ${failed.length} of ${total} checks failed`,
        ...failed.map((check) => `- ${check.message}`),
      ];
  lines.push(
    ...shareSafetyLines(result),
    ...result.warnings.map((warning) => `warning: ${warning}`),
  );
  const cwdFlag = result.cwd === process.cwd() ? "" : ` --cwd ${result.cwd}`;
  if (!result.ok) lines.push(`every check: ${cli(`verify --run ${runId}${cwdFlag} --verbose`)}`);
  return `${lines.join("\n")}\n`;
}

function formatVerifyVerbose(result: VerifyResult): HumanOutput {
  if (result.error?.code === "HUMANISH_RUN_NOT_FOUND") return humanError(result.error);
  return (
    [
      `humanish verify ${result.ok ? "passed" : "failed"}`,
      `run: ${verifiedRunId(result)}${unfinishedNote(result)}`,
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
          `- ${run.runId} ${run.mode ?? "unknown"} ${run.display?.label ?? "unreadable"} ${run.createdAt ?? "unknown"} ${run.path}`,
      ),
    ].join("\n") + "\n"
  );
}
