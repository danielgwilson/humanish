import path from "node:path";
import { Command, Option } from "commander";
import { computeStats, formatStatsHuman } from "../../run/stats.js";
import { DEFAULT_EXPORT_MAX_BYTES, exportRun, formatExportHuman } from "../../feedback/export.js";
import { cleanupRun, listRuns, readReview } from "../../run/stored-runs.js";
import { runDryRun } from "../../run/dry-run.js";
import { verifyRun } from "../../verify/verify.js";
import {
  reclaimPreflightSandboxes,
  reclaimRunSandboxes,
  type ReclaimResult,
} from "../../run/reclaim.js";
import type { CleanupResult, RunResult } from "../../run/results.js";
import type { ReviewSummary } from "../../run/bundle.js";
import type { RunsResult } from "../../run/stored-runs.js";
import type { VerifyResult } from "../../verify/verify.js";
import { runLabCommand } from "./lab-run.js";
import { countOption } from "../renamed-options.js";
import {
  applyEnvFileOption,
  type CliIo,
  formatRunHuman,
  JSON_OPTION_DESCRIPTION,
  type LabCommandOptions,
  parsePositiveInteger,
  writeResult,
} from "../io.js";

const SCRIPTED_BROWSER_DOCS_URL =
  "https://humanish.dev/docs/lab-manifests#scripted-browser-scenarios";

export function registerRunCommand(parent: Command, io: CliIo): void {
  parent
    .command("run")
    .argument("[lab]", "Optional lab id or .yaml path.")
    .description(
      "Run a study, as a dry run or with live participants. This is the everyday command.",
    )
    .summary("Run a study, as a dry run or with live participants.")
    .option("--dry-run", "Generate contract proof without browser, keys, or provider spend.")
    // `humanish run <lab>` and `humanish lab run <lab>` are the same operation on the same
    // dispatcher, but this one used to forward four options while its sibling forwarded all of
    // them, so `humanish run first-run --no-open` failed while `lab run` accepted it. A
    // participant hit exactly that and filed it as a documentation mismatch. Same command, same
    // flags (clig.dev: "be consistent across subcommands").
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without an attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option(
      "--count <count>",
      "Override the participant count of a preview or computer-use lab, or of the synthetic run without a lab.",
    )
    // The older spelling of --count, hidden and noted on stderr (renamed-options.ts).
    .addOption(new Option("--sims <count>").hideHelp())
    // Agents with an older installed skill still send --app-url. Accepting it hidden lets the
    // refusal name the replacement; commander's bare unknown-option error names nothing. Delete
    // after 0.106.x.
    .addOption(new Option("--app-url <url>").hideHelp())
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--env-file <path>", "Load a local env file for this run without persisting values.")
    .option(
      "--run-id <id>",
      "Explicit run id for deterministic fixture tests; refused when that run already exists.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (
        lab: string | undefined,
        options: {
          appUrl?: string;
          count?: string;
          cwd: string;
          dryRun?: boolean;
          envFile?: string;
          json?: boolean;
          runId?: string;
          sims?: string;
        },
        command,
      ) => {
        const count = countOption(io, options);
        if (options.appUrl !== undefined) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_APP_URL_REMOVED",
              message: `--app-url was removed. To drive an app on a loopback URL, write a scripted-browser lab and run \`humanish run <lab>\`: ${SCRIPTED_BROWSER_DOCS_URL}`,
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        if (
          !(await applyEnvFileOption({
            command,
            cwd: options.cwd,
            envFile: options.envFile,
            io,
            // runLabCommand discovers keys for a live lab; the lab-less preview needs none.
            discoverKeys: false,
          }))
        ) {
          return;
        }

        if (lab) {
          await runLabCommand({
            command,
            io,
            lab,
            mode: "run",
            // Forwarded wholesale, exactly as `lab run` does. Cherry-picking a subset here is what
            // made the two commands disagree in the first place.
            options: { ...options, count } as LabCommandOptions,
          });
          return;
        }

        const participantCount = count === undefined ? undefined : parsePositiveInteger(count);
        if (participantCount === null) {
          const result: RunResult = {
            schema: "humanish.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "HUMANISH_INVALID_SIM_COUNT",
              message: "--count must be a positive integer.",
            },
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        const result = await runDryRun({
          cwd: options.cwd,
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.runId === undefined ? {} : { runId: options.runId }),
          ...(participantCount === undefined ? {} : { participantCount }),
          // Rendered the way `watch` renders it, so a bundle is the same bundle whichever command
          // produced it. A render failure is a warning on the result.
          observer: { open: false },
        });
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(result.ok ? 0 : 2);
      },
    );
}

export function registerVerifyCommand(parent: Command, io: CliIo): void {
  parent
    .command("verify")
    .description("Check a run's evidence and share safety.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
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
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await cleanupRun(options.cwd, options.run);
      writeResult(command, io, result, formatCleanupHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

export function registerReviewCommand(parent: Command, io: CliIo): void {
  parent
    .command("review")
    .description("Show a run's review: verdict, summary and gaps.")
    .summary("Build a review packet from verified run evidence.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
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
    .summary("Export a run as an Observer page or a redacted bundle.")
    .option("--run <id>", "Run id or 'latest'.", "latest")
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
      "Export a bundle that is not share_ready, with a LOCAL ONLY banner in the file.",
    )
    .option(
      "--max-bytes <n>",
      "Refuse an export larger than this.",
      String(DEFAULT_EXPORT_MAX_BYTES),
    )
    .option("--cwd <path>", "Target project directory.", ".")
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
    .option("--lab <id>", "Only runs from this lab id.")
    .option("--since <date>", "Only runs that started on or after this ISO date or datetime.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action(
      async (options: { cwd: string; json?: boolean; lab?: string; since?: string }, command) => {
        const result = await computeStats(options.cwd, {
          ...(options.lab === undefined ? {} : { lab: options.lab }),
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
    .option("--cwd <path>", "Target project directory.", ".")
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
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--run <id>", "Run id, or 'latest'.", "latest")
    .addOption(
      new Option(
        "--preflight",
        "Reclaim sandboxes left by interrupted `humanish lab preflight` probes (journaled in .humanish/preflight) instead of a run's.",
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

function formatReclaimHuman(result: ReclaimResult): string {
  const lines: string[] = [];
  lines.push(
    `Reclaim ${result.runId}: ${result.ok ? "ok" : "FAILED"} — ${result.receiptCount} sandbox receipt(s).`,
  );
  for (const outcome of result.outcomes) {
    lines.push(
      `  ${outcome.sandboxId} (${outcome.laneId}): ${outcome.state}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
    );
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (result.error) lines.push(`  error: ${result.error.message}`);
  return lines.join("\n");
}

const REVIEW_VERDICTS: Record<ReviewSummary["verdict"], string> = {
  contract_proof_only: "preview only; no product behavior was tested",
  pass: "pass",
  fail: "fail",
  blocked: "blocked",
  timed_out: "timed out",
};

/** A run's review: its verdict, summary and gaps, and where review.json is. */
function formatReviewHuman(
  result: VerifyResult | (ReviewSummary & { path: string; runId: string }),
): string {
  if (!("verdict" in result)) {
    const why = result.error
      ? `${result.error.code}: ${result.error.message}`
      : `the run did not pass verify; humanish verify --run ${result.run} shows why`;
    return `humanish review failed\nrun: ${result.run}\n${why}\n`;
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
function formatVerifyHuman(result: VerifyResult): string {
  if (result.error?.code === "HUMANISH_RUN_NOT_FOUND")
    return `verify failed: ${result.error.message}\n`;
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

function formatVerifyVerbose(result: VerifyResult): string {
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

function formatCleanupHuman(result: CleanupResult): string {
  if (!result.ok && result.error) {
    return `${result.error.code}: ${result.error.message}\n`;
  }

  return (
    [
      `humanish cleanup ${result.ok ? "passed" : "failed"}`,
      `run: ${result.runId ?? result.run}`,
      `resources: already-clean ${result.summary.alreadyClean}, skipped ${result.summary.skipped}, failed ${result.summary.failed}`,
      ...(result.cleanupPath ? [`cleanup: ${result.cleanupPath}`] : []),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

function formatRunsHuman(result: RunsResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

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
