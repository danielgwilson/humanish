import { Command, Option } from "commander";

import {
  draftFeedback,
  listFeedback,
  renderIssueMarkdown,
  renderIssueUrl,
  verifyFeedback
} from "./feedback.js";
import type { FeedbackResult } from "./feedback.js";
import { runInit } from "./init.js";
import type { InitChange, InitResult } from "./init.js";
import { renderObserver, serveObserver } from "./observer.js";
import type { ObserverResult, ObserverServer } from "./observer.js";
import {
  DEFAULT_OSS_REPOS,
  runOssLab
} from "./oss-lab.js";
import type { OssLabResult } from "./oss-lab.js";
import {
  runOssMetaLab
} from "./oss-meta-lab.js";
import type { OssMetaLabResult } from "./oss-meta-lab.js";
import {
  doctor,
  listRuns,
  readReview,
  runDryRun,
  verifyRun
} from "./run.js";
import type {
  DoctorResult,
  RunsResult,
  RunResult,
  VerifyResult
} from "./run.js";

export const CLI_RESPONSE_SCHEMA = "mimetic.cli-response.v1";

export interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
  setExitCode(code: number): void;
}

export interface PlannedCommand {
  name: string;
  description: string;
  issue: string;
  docs: string[];
  options?: Array<{
    flags: string;
    description: string;
    defaultValue?: string | boolean;
  }>;
}

export interface UnsupportedEnvelope {
  schema: typeof CLI_RESPONSE_SCHEMA;
  ok: false;
  command: string;
  error: {
    code: "MIMETIC_UNIMPLEMENTED";
    message: string;
  };
  docs: string[];
  issue: string;
  capabilities: {
    githubMutation: false;
    providerSpend: false;
    productionData: false;
  };
}

const defaultIo: CliIo = {
  writeOut: (text) => process.stdout.write(text),
  writeErr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  }
};

const commonDocs = [
  "docs/product/open-source-install-experience.md",
  "docs/roadmap/world-class-open-source-v0.md",
  "docs/release/open-source-readiness.md"
];

export const plannedCommands: PlannedCommand[] = [
  {
    name: "init",
    description: "Set up committed mimetic/ source files and ignored .mimetic/ runtime state.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/14",
    docs: ["docs/architecture/project-layout.md", ...commonDocs],
    options: [
      { flags: "--dry-run", description: "Print planned changes without writing files." },
      { flags: "--yes", description: "Apply safe generated changes without prompting." },
      { flags: "--cwd <path>", description: "Target project directory.", defaultValue: "." }
    ]
  },
  {
    name: "doctor",
    description: "Explain project readiness and missing Mimetic setup.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/7",
    docs: commonDocs
  },
  {
    name: "run",
    description: "Run a persona/scenario simulation or synthetic dry-run bundle.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/7",
    docs: commonDocs,
    options: [
      { flags: "--dry-run", description: "Generate contract proof without browser, keys, or provider spend." },
      { flags: "--actor codex-tui|codex-exec", description: "Explicitly opt into one local Codex actor." },
      { flags: "--sims <count>", description: "Simulation count. Local Codex actors support 1x in this slice." },
      { flags: "--cwd <path>", description: "Target project directory.", defaultValue: "." }
    ]
  },
  {
    name: "verify",
    description: "Validate a run bundle and public-safety gates.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/7",
    docs: commonDocs,
    options: [
      { flags: "--run <id>", description: "Run id or latest pointer.", defaultValue: "latest" }
    ]
  },
  {
    name: "review",
    description: "Build a review packet from verified run evidence.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/7",
    docs: commonDocs,
    options: [
      { flags: "--run <id>", description: "Run id or latest pointer.", defaultValue: "latest" }
    ]
  },
  {
    name: "watch",
    description: "Run sims, open the observer, and keep the shell attached.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/10",
    docs: commonDocs,
    options: [
      { flags: "--run <id>", description: "Watch an existing run id or latest pointer." },
      { flags: "--sims <count>", description: "Start a fresh synthetic run with this many sims before rendering.", defaultValue: "4 when --run is omitted" },
      { flags: "--open", description: "Open the observer in the default browser.", defaultValue: "true for human output" },
      { flags: "--detach", description: "Render/open once and exit without attached watch server." },
      { flags: "--port <port>", description: "Local observer server port when following.", defaultValue: "0" },
      { flags: "--no-open", description: "Render without opening a browser." }
    ]
  },
  {
    name: "runs",
    description: "List local Mimetic runs and latest pointers.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/7",
    docs: commonDocs
  }
];

export function createProgram(io: Partial<CliIo> = {}): Command {
  const cliIo: CliIo = { ...defaultIo, ...io };
  const program = new Command();

  program
    .name("mimetic")
    .description("Open-source-safe persona simulation CLI and proof harness.")
    .version("0.1.2")
    .showHelpAfterError()
    .option("--json", "Print machine-readable JSON responses where supported.")
    .configureOutput({
      writeOut: (text) => cliIo.writeOut(text),
      writeErr: (text) => cliIo.writeErr(text)
    })
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  mimetic watch",
        "  mimetic watch --run latest --detach",
        "  mimetic watch --json --no-open",
        "  mimetic lab oss --repos developit/mitt,lukeed/clsx",
        "  mimetic lab oss-smoke --limit 1 --keep",
        "  mimetic verify --run latest --json",
        "",
        "Public-safety boundary:",
        "  Mimetic must not commit or emit PII, PHI, secrets, keys, raw private transcripts,",
        "  private screenshots, or private source-system artifacts."
      ].join("\n")
    );

  registerInitCommand(program, cliIo);
  registerDoctorCommand(program, cliIo);
  registerRunCommand(program, cliIo);
  registerVerifyCommand(program, cliIo);
  registerReviewCommand(program, cliIo);
  registerRunsCommand(program, cliIo);
  registerWatchCommand(program, cliIo);
  registerLabCommands(program, cliIo);

  const implementedCommands = new Set(["init", "doctor", "run", "verify", "review", "runs", "watch", "lab"]);
  for (const plannedCommand of plannedCommands.filter((command) => !implementedCommands.has(command.name))) {
    registerUnsupportedCommand(program, plannedCommand, cliIo);
  }

  registerFeedbackCommands(program, cliIo);

  return program;
}

function registerInitCommand(parent: Command, io: CliIo): void {
  parent
    .command("init")
    .description("Set up committed mimetic/ source files and ignored .mimetic/ runtime state.")
    .option("--dry-run", "Print planned changes without writing files.")
    .option("--yes", "Apply safe generated changes without prompting.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; dryRun?: boolean; json?: boolean; yes?: boolean }, command) => {
      const initOptions = {
        cwd: options.cwd,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.yes === undefined ? {} : { yes: options.yes })
      };
      const result = await runInit(initOptions);

      if (wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok) {
        io.writeOut(formatInitHuman(result));
      } else {
        io.writeErr(formatInitHuman(result));
      }

      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerDoctorCommand(parent: Command, io: CliIo): void {
  parent
    .command("doctor")
    .description("Explain project readiness and missing Mimetic setup.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean }, command) => {
      const result = await doctor(options.cwd);
      writeResult(command, io, result, formatDoctorHuman);
      io.setExitCode(result.ok ? 0 : 1);
    });
}

function registerRunCommand(parent: Command, io: CliIo): void {
  parent
    .command("run")
    .description("Run a persona/scenario simulation or synthetic dry-run bundle.")
    .option("--dry-run", "Generate contract proof without browser, keys, or provider spend.")
    .addOption(new Option("--actor <actor>", "Explicit live actor to run.").choices(["codex-tui", "codex-exec"]))
    .option("--sims <count>", "Simulation count. Local Codex actors support 1x in this slice.")
    .option("--timeout-ms <ms>", "Local actor timeout in milliseconds.", String(120_000))
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--run-id <id>", "Explicit run id for deterministic fixture tests.")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: {
      actor?: string;
      cwd: string;
      dryRun?: boolean;
      json?: boolean;
      runId?: string;
      sims?: string;
      timeoutMs?: string;
    }, command) => {
      const simCount = options.sims === undefined ? undefined : parsePositiveInteger(options.sims);
      const timeoutMs = options.timeoutMs === undefined ? undefined : parseTimeoutMs(options.timeoutMs);
      if (options.sims !== undefined && simCount === null) {
        const result: RunResult = {
          schema: "mimetic.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "MIMETIC_INVALID_SIM_COUNT",
            message: "--sims must be an integer between 1 and 64."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (options.timeoutMs !== undefined && timeoutMs === null) {
        const result: RunResult = {
          schema: "mimetic.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "MIMETIC_INVALID_TIMEOUT",
            message: "--timeout-ms must be an integer between 1 and 600000."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }

      const result = await runDryRun({
        cwd: options.cwd,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.runId === undefined ? {} : { runId: options.runId }),
        ...(simCount === undefined || simCount === null ? {} : { simCount }),
        ...(timeoutMs === undefined || timeoutMs === null ? {} : { timeoutMs })
      });
      writeResult(command, io, result, formatRunHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerVerifyCommand(parent: Command, io: CliIo): void {
  parent
    .command("verify")
    .description("Validate a run bundle and public-safety gates.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await verifyRun(options.cwd, options.run);
      writeResult(command, io, result, formatVerifyHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerReviewCommand(parent: Command, io: CliIo): void {
  parent
    .command("review")
    .description("Build a review packet from verified run evidence.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await readReview(options.cwd, options.run);
      writeResult(command, io, result, (value) => `${JSON.stringify(value, null, 2)}\n`);
      io.setExitCode("ok" in result && result.ok === false ? 2 : 0);
    });
}

function registerRunsCommand(parent: Command, io: CliIo): void {
  parent
    .command("runs")
    .description("List local Mimetic runs and latest pointers.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean }, command) => {
      const result = await listRuns(options.cwd);
      writeResult(command, io, result, formatRunsHuman);
      io.setExitCode(0);
    });
}

function registerWatchCommand(parent: Command, io: CliIo): void {
  parent
    .command("watch")
    .description("Run sims, open the observer, and keep the shell attached.")
    .option("--run <id>", "Watch an existing run id or latest pointer.")
    .option("--sims <count>", "Start a fresh synthetic run with this many sims before rendering. Defaults to 4 when --run is omitted.")
    .option("--run-id <id>", "Explicit run id for deterministic fixture tests.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .addOption(new Option("--follow", "Deprecated; human output follows by default.").hideHelp())
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--json", "Print a machine-readable JSON response.")
    .addHelpText(
      "after",
      [
        "",
        "Happy path:",
        "  mimetic watch",
        "",
        "Agent/CI path:",
        "  mimetic watch --json --no-open",
        "",
        "Existing evidence:",
        "  mimetic watch --run latest --detach"
      ].join("\n")
    )
    .action(async (options: {
      cwd: string;
      detach?: boolean;
      follow?: boolean;
      json?: boolean;
      open?: boolean;
      port: string;
      run?: string;
      runId?: string;
      sims?: string;
    }, command) => {
      const runOptionSource = typeof command.getOptionValueSource === "function"
        ? command.getOptionValueSource("run")
        : undefined;
      const runWasOmitted = runOptionSource === undefined || runOptionSource === "default";
      const simCount = options.sims === undefined ? undefined : parsePositiveInteger(options.sims);
      const port = parseObserverPort(options.port);
      if (options.sims !== undefined && simCount === null) {
        const result: RunResult = {
          schema: "mimetic.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "MIMETIC_INVALID_SIM_COUNT",
            message: "--sims must be an integer between 1 and 64."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (!runWasOmitted && options.sims !== undefined) {
        const result: RunResult = {
          schema: "mimetic.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "MIMETIC_WATCH_OPTION_CONFLICT",
            message: "Use either --run to watch existing evidence or --sims to start a fresh run, not both."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (!runWasOmitted && options.runId !== undefined) {
        const result: RunResult = {
          schema: "mimetic.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "MIMETIC_WATCH_OPTION_CONFLICT",
            message: "--run-id only applies to fresh watch runs; remove --run or remove --run-id."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      if (port === null) {
        const result: RunResult = {
          schema: "mimetic.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "MIMETIC_INVALID_PORT",
            message: "--port must be an integer between 0 and 65535."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }
      const requestedSimCount = simCount ?? (runWasOmitted ? 4 : undefined);

      let runInput = options.run ?? "latest";
      if (requestedSimCount !== undefined && requestedSimCount !== null) {
        const runResult = await runDryRun({
          cwd: options.cwd,
          dryRun: true,
          simCount: requestedSimCount,
          ...(options.runId === undefined ? {} : { runId: options.runId })
        });

        if (!runResult.ok || !runResult.runId) {
          writeResult(command, io, runResult, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        runInput = runResult.runId;
      }

      const wantsMachine = wantsJson(command);
      const shouldOpen = options.open === false ? false : wantsMachine ? options.open === true : true;
      const wantsFollow = !wantsMachine && options.detach !== true && (options.follow !== false);
      const rendered = await renderObserver(options.cwd, runInput, { open: wantsFollow ? false : shouldOpen });
      let server: ObserverServer | null = null;
      let result = rendered;
      if (rendered.ok && wantsFollow) {
        server = await serveObserver(rendered, { open: shouldOpen, port });
        result = {
          ...rendered,
          observerUrl: server.url,
          serverUrl: server.url,
          opened: server.opened,
          ...(server.openCommand ? { openCommand: server.openCommand } : {}),
          warnings: [
            ...rendered.warnings,
            "Live observer server is polling observer-data.json with no-store caching.",
            ...(server.warning ? [server.warning] : [])
          ]
        };
      }
      writeResult(command, io, result, formatObserverHuman);
      io.setExitCode(result.ok ? 0 : 2);

      if (result.ok && server) {
        await followObserver(io, result, server);
      }
    });
}

function registerFeedbackCommands(parent: Command, io: CliIo): void {
  const feedback = parent
    .command("feedback")
    .description("Create public-safe feedback drafts without GitHub API mutation.");

  feedback
    .command("list")
    .description("List feedback draft state for a run.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await listFeedback(options.cwd, options.run);
      writeResult(command, io, result, formatFeedbackHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("draft")
    .description("Generate a public-safe feedback draft from verified evidence.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await draftFeedback(options.cwd, options.run);
      writeResult(command, io, result, formatFeedbackHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("verify")
    .description("Verify the feedback draft for public issue eligibility.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean; run: string }, command) => {
      const result = await verifyFeedback(options.cwd, options.run);
      writeResult(command, io, result, formatFeedbackHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("issue")
    .description("Print Markdown for a public GitHub issue. Does not mutate GitHub.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .requiredOption("--repo <owner/repo>", "Repository slug used in rendered filing instructions.")
    .option("--format <format>", "Output format.", "markdown")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; format: string; json?: boolean; repo: string; run: string }, command) => {
      const result = await renderIssueMarkdown(options.cwd, options.run, options.repo);

      if (wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else if (options.format !== "markdown") {
        io.writeErr("Only --format markdown is supported.\n");
        io.setExitCode(2);
        return;
      } else if (result.ok && result.issueMarkdown) {
        io.writeOut(result.issueMarkdown);
      } else {
        io.writeErr(formatFeedbackHuman(result));
      }

      io.setExitCode(result.ok ? 0 : 2);
    });

  feedback
    .command("issue-url")
    .description("Print a prefilled public issue URL. Does not mutate GitHub.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .requiredOption("--repo <owner/repo>", "Repository slug used in the generated URL.")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean; repo: string; run: string }, command) => {
      const result = await renderIssueUrl(options.cwd, options.run, options.repo);

      if (wantsJson(command)) {
        io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.ok && result.issueUrl) {
        io.writeOut(`${result.issueUrl}\n`);
      } else {
        io.writeErr(formatFeedbackHuman(result));
      }

      io.setExitCode(result.ok ? 0 : 2);
    });
}

function registerLabCommands(parent: Command, io: CliIo): void {
  const lab = parent
    .command("lab")
    .description("Run experimental Mimetic proof loops against disposable public targets.");

  lab
    .command("oss")
    .description("Watch headed Codex/E2B OSS meta-sims setting up Mimetic inside public repos.")
    .option("--repos <owner/repo,...>", "Comma-separated public GitHub repo slugs.")
    .option("--repo <owner/repo>", "Public GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--count <count>", "Number of headed desktop sims to assign.", String(DEFAULT_OSS_REPOS.length))
    .option("--sims <count>", "Alias for --count.")
    .option("--run-id <id>", "Explicit lab run id.")
    .option("--cwd <path>", "Host directory for ignored .mimetic lab report.", ".")
    .option("--dry-run", "Render the Observer-of-Observers contract without provider spend or live E2B launch.")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--smoke", "Run the disposable local clone smoke harness instead of headed meta-sims.")
    .option("--limit <count>", "Smoke mode only: number of selected repos to trial.", String(DEFAULT_OSS_REPOS.length))
    .option("--keep", "Smoke mode only: keep disposable clone sandbox for debugging.")
    .option("--json", "Print a machine-readable JSON response.")
    .addHelpText(
      "after",
      [
        "",
        "Happy path:",
        "  mimetic lab oss",
        "",
        "Repo selection:",
        "  mimetic lab oss --repos developit/mitt,lukeed/clsx,sindresorhus/is-plain-obj,ai/nanoid",
        "  mimetic lab oss --repo developit/mitt --repo lukeed/clsx --count 4",
        "",
        "Agent/CI path:",
        "  mimetic lab oss --dry-run --json --no-open",
        "",
        "Disposable clone smoke:",
        "  mimetic lab oss-smoke --limit 1 --keep",
        "  mimetic lab oss --smoke --limit 1 --keep",
        "",
        "Shape:",
        "  The top-level Observer shows headed E2B desktop lanes. Each desktop is intended",
        "  to run Codex TUI, clone its assigned public OSS repo, set up Mimetic, and keep",
        "  that repo's nested Mimetic Observer visible in the E2B browser.",
        "",
        "Safety:",
        "  Only public GitHub owner/repo slugs are accepted. No keys or private artifacts",
        "  are written into committed Mimetic source."
      ].join("\n")
    )
    .action(async (options: {
      count: string;
      cwd: string;
      detach?: boolean;
      dryRun?: boolean;
      json?: boolean;
      keep?: boolean;
      limit: string;
      open?: boolean;
      port: string;
      repo: string[];
      repos?: string;
      runId?: string;
      sims?: string;
      smoke?: boolean;
    }, command) => {
      if (options.smoke) {
        await runOssSmokeAction({ command, io, options });
        return;
      }

      const countInput = options.sims ?? options.count;
      const count = parsePositiveInteger(countInput);
      const port = parseObserverPort(options.port);
      if (port === null) {
        const result: OssMetaLabResult = {
          schema: "mimetic.oss-meta-lab-result.v1",
          ok: false,
          assignments: [],
          cwd: options.cwd,
          dryRun: options.dryRun === true,
          error: {
            code: "MIMETIC_META_RUN_FAILED",
            message: "--port must be an integer between 0 and 65535."
          },
          liveRequested: options.dryRun !== true,
          repos: [...options.repo, ...(options.repos ? [options.repos] : [])],
          sandboxes: [],
          warnings: []
        };
        writeResult(command, io, result, formatOssMetaLabHuman);
        io.setExitCode(2);
        return;
      }

      const wantsMachine = wantsJson(command);
      const shouldOpen = options.open === false ? false : wantsMachine ? options.open === true : true;
      const wantsFollow = !wantsMachine && options.detach !== true && options.dryRun !== true;
      const result = await runOssMetaLab({
        cwd: options.cwd,
        open: wantsFollow ? false : shouldOpen,
        repos: [...options.repo, ...(options.repos ? [options.repos] : [])],
        ...(count === null ? { count: Number.NaN } : { count }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.runId === undefined ? {} : { runId: options.runId })
      });

      let server: ObserverServer | null = null;
      let output = result;
      if (result.ok && wantsFollow && result.observer?.ok) {
        server = await serveObserver(result.observer, { open: shouldOpen, port });
        output = {
          ...result,
          observer: {
            ...result.observer,
            observerUrl: server.url,
            serverUrl: server.url,
            opened: server.opened,
            ...(server.openCommand ? { openCommand: server.openCommand } : {}),
            warnings: [
              ...result.observer.warnings,
              "Live OSS meta-lab server is polling observer-data.json with no-store caching.",
              ...(server.warning ? [server.warning] : [])
            ]
          },
          warnings: [
            ...result.warnings,
            "Live OSS meta-lab server is polling observer-data.json with no-store caching.",
            ...(server.warning ? [server.warning] : [])
          ]
        };
      }

      writeResult(command, io, output, formatOssMetaLabHuman);
      io.setExitCode(output.ok ? 0 : 2);

      if (output.ok && options.detach === true && output.sandboxes.some((sandbox) => sandbox.urlPresent)) {
        // The E2B SDK keeps local handles open after stream URL creation. Detach should
        // return the user's shell while the remote desktops continue on E2B.
        setTimeout(() => process.exit(0), 50);
      }

      if (output.ok && server && output.observer?.ok) {
        await followObserver(io, output.observer, server);
      }
    });

  lab
    .command("oss-smoke")
    .description("Clone lightweight public OSS repos, try Mimetic setup/proof, then discard clones.")
    .option("--repos <owner/repo,...>", "Comma-separated public GitHub repo slugs.")
    .option("--repo <owner/repo>", "Public GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--limit <count>", "Number of selected repos to trial.", String(DEFAULT_OSS_REPOS.length))
    .option("--run-id <id>", "Explicit lab run id.")
    .option("--cwd <path>", "Host directory for ignored .mimetic lab report.", ".")
    .option("--keep", "Keep disposable clone sandbox for debugging.")
    .option("--json", "Print a machine-readable JSON response.")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  mimetic lab oss-smoke",
        "  mimetic lab oss-smoke --repos developit/mitt,lukeed/clsx",
        "  mimetic lab oss-smoke --limit 1 --keep --json",
        "",
        "Safety:",
        "  Only public GitHub owner/repo slugs are accepted. Clones live under ignored .mimetic/",
        "  runtime state and are removed by default."
      ].join("\n")
    )
    .action(async (options: {
      cwd: string;
      json?: boolean;
      keep?: boolean;
      limit: string;
      repo: string[];
      repos?: string;
      runId?: string;
    }, command) => {
      await runOssSmokeAction({ command, io, options });
    });
}

async function runOssSmokeAction(args: {
  command: Command;
  io: CliIo;
  options: {
    cwd: string;
    keep?: boolean;
    limit: string;
    repo: string[];
    repos?: string;
    runId?: string;
  };
}): Promise<void> {
  const limit = parsePositiveInteger(args.options.limit);
  const labOptions = {
    cwd: args.options.cwd,
    limit: limit ?? Number.NaN,
    repos: [...args.options.repo, ...(args.options.repos ? [args.options.repos] : [])],
    ...(args.options.keep === undefined ? {} : { keep: args.options.keep }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  };
  const result = await runOssLab(labOptions);
  writeResult(args.command, args.io, result, formatOssLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);
}

function writeResult<T>(command: Command, io: CliIo, result: T, formatHuman: (result: T) => string): void {
  if (wantsJson(command)) {
    io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    io.writeOut(formatHuman(result));
  }
}

function formatDoctorHuman(result: DoctorResult): string {
  return [
    `mimetic doctor ${result.ok ? "ok" : "needs setup"}`,
    `cwd: ${result.cwd}`,
    ...result.checks.map((check) => `- ${check.ok ? "ok" : "missing"} ${check.name}: ${check.message}`)
  ].join("\n") + "\n";
}

function formatRunHuman(result: RunResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    `mimetic run ${result.mode}`,
    `run: ${result.runId}`,
    ...(result.simCount === undefined ? [] : [`sims: ${result.simCount}`]),
    `bundle: ${result.bundlePath}`,
    `review: ${result.reviewPath}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatVerifyHuman(result: VerifyResult): string {
  return [
    `mimetic verify ${result.ok ? "passed" : "failed"}`,
    `run: ${result.run}`,
    ...result.checks.map((check) => `- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`)
  ].join("\n") + "\n";
}

function formatRunsHuman(result: RunsResult): string {
  if (result.runs.length === 0) {
    return `No Mimetic runs found in ${result.cwd}\n`;
  }

  return [
    `latest: ${result.latest ?? "none"}`,
    ...result.runs.map((run) => `- ${run.runId} ${run.mode ?? "unknown"} ${run.createdAt ?? "unknown"} ${run.path}`)
  ].join("\n") + "\n";
}

function formatObserverHuman(result: ObserverResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "mimetic observer rendered",
    `run: ${result.run}`,
    `observer: ${result.observerPath}`,
    ...(result.observerUrl ? [`url: ${result.observerUrl}`] : []),
    ...(result.opened === undefined ? [] : [`opened: ${result.opened ? "yes" : "no"}`]),
    `bundle: ${result.bundlePath}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 64 ? parsed : null;
}

function parseTimeoutMs(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 1 && parsed <= 600_000 ? parsed : null;
}

function parseObserverPort(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= 65535 ? parsed : null;
}

async function followObserver(io: CliIo, result: ObserverResult, server: ObserverServer): Promise<void> {
  io.writeOut(`watching: ${result.serverUrl ?? result.observerUrl ?? result.observerPath}\n`);
  io.writeOut("watching: press Ctrl-C to stop\n");
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => {
      server.close()
        .catch((error: unknown) => {
          io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        })
        .finally(() => {
          io.writeOut("watch stopped\n");
          resolve();
        });
    });
  });
}

function formatFeedbackHuman(result: FeedbackResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "mimetic feedback ready",
    `run: ${result.run}`,
    ...(result.draftPath ? [`draft: ${result.draftPath}`] : []),
    ...(result.issuePath ? [`issue: ${result.issuePath}`] : [])
  ].join("\n") + "\n";
}

function formatOssLabHuman(result: OssLabResult): string {
  if (!result.ok && result.error) {
    return `${result.error.code}: ${result.error.message}\n`;
  }

  return [
    `mimetic lab oss-smoke ${result.ok ? "passed" : "failed"}`,
    `run: ${result.runId}`,
    ...(result.reportMarkdownPath ? [`report: ${result.reportMarkdownPath}`] : []),
    `sandbox: ${result.cleanup.kept ? result.sandboxPath : "removed"}`,
    ...result.repos.map((repo) => {
      const passed = repo.steps.filter((step) => step.ok).length;
      return `- ${repo.ok ? "ok" : "fail"} ${repo.repo}: ${passed}/${repo.steps.length} steps, ${repo.changedFiles.length} changed files in disposable clone`;
    }),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatOssMetaLabHuman(result: OssMetaLabResult): string {
  if (!result.ok && result.error) {
    return `${result.error.code}: ${result.error.message}\n`;
  }

  return [
    `mimetic lab oss ${result.dryRun ? "dry-run" : "watch"}`,
    `run: ${result.runId ?? "not-created"}`,
    `repos: ${result.repos.join(", ")}`,
    ...(result.count === undefined ? [] : [`desktops: ${result.count}`]),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.observerUrl ? [`url: ${result.observer.observerUrl}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...(result.observer?.bundlePath ? [`bundle: ${result.observer.bundlePath}`] : []),
    ...result.assignments.map((assignment) => `- ${String(assignment.index).padStart(2, "0")} ${assignment.repo}: top-level desktop lane -> nested Mimetic Observer`),
    ...result.sandboxes.map((sandbox) => {
      const sandboxLabel = sandbox.sandboxId ? ` sandbox=${sandbox.sandboxId}` : "";
      const bootstrapLabel = sandbox.bootstrapStatus ? ` bootstrap=${sandbox.bootstrapStatus}` : "";
      const completionLabel = sandbox.completionStatus ? ` completion=${sandbox.completionStatus}` : "";
      const screenshotLabel = sandbox.screenshotPresent ? " screenshot=yes" : "";
      return `sandbox ${sandbox.streamId}: ${sandbox.repo} stream=${sandbox.urlPresent ? "connected" : "missing"}${bootstrapLabel}${completionLabel}${screenshotLabel}${sandboxLabel}`;
    }),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function formatInitHuman(result: InitResult): string {
  const title = result.ok
    ? `mimetic init ${result.mode}`
    : `mimetic init ${result.mode} blocked`;
  const lines = [
    title,
    `cwd: ${result.cwd}`,
    "",
    "changes:",
    ...result.changes.map(formatInitChange)
  ];

  if (result.warnings.length > 0) {
    lines.push("", "warnings:", ...result.warnings.map((warning) => `- ${warning}`));
  }

  if (result.error) {
    lines.push("", `${result.error.code}: ${result.error.message}`);
  }

  if (result.mode === "needs-confirmation") {
    lines.push("", "Run with --dry-run --json to inspect or --yes to apply.");
  }

  return `${lines.join("\n")}\n`;
}

function formatInitChange(change: InitChange): string {
  return `- ${change.action.padEnd(6)} ${change.path} (${change.target}: ${change.reason})`;
}

function registerUnsupportedCommand(
  parent: Command,
  plannedCommand: PlannedCommand,
  io: CliIo,
  commandName = plannedCommand.name
): void {
  const command = parent.command(commandName).description(plannedCommand.description);
  command.option("--json", "Print a machine-readable JSON response.");

  for (const option of plannedCommand.options ?? []) {
    if (option.defaultValue === undefined) {
      command.option(option.flags, option.description);
    } else {
      command.option(option.flags, option.description, option.defaultValue);
    }
  }

  command.action((_options: unknown, actionCommand: Command) => {
    emitUnsupported(plannedCommand, actionCommand, io);
  });
}

function emitUnsupported(plannedCommand: PlannedCommand, command: Command, io: CliIo): void {
  const envelope: UnsupportedEnvelope = {
    schema: CLI_RESPONSE_SCHEMA,
    ok: false,
    command: plannedCommand.name,
    error: {
      code: "MIMETIC_UNIMPLEMENTED",
      message: `${plannedCommand.name} is planned but not implemented in this scaffold slice.`
    },
    docs: plannedCommand.docs,
    issue: plannedCommand.issue,
    capabilities: {
      githubMutation: false,
      providerSpend: false,
      productionData: false
    }
  };

  if (wantsJson(command)) {
    io.writeOut(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    io.writeErr(
      [
        `mimetic ${plannedCommand.name} is planned but not implemented yet.`,
        `Track: ${plannedCommand.issue}`,
        `Docs: ${plannedCommand.docs.join(", ")}`,
        "This scaffold does not mutate GitHub, spend provider credits, or use production data."
      ].join("\n") + "\n"
    );
  }

  io.setExitCode(2);
}

function wantsJson(command: Command): boolean {
  let current: Command | null = command;

  while (current) {
    if (current.opts<{ json?: boolean }>().json === true) {
      return true;
    }

    current = current.parent ?? null;
  }

  return false;
}
