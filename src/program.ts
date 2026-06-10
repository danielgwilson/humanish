import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Command, Option } from "commander";

import { startCodexAppServerUi } from "./codex-app-server-ui.js";
import type { CodexAppServerUiState } from "./codex-app-server-ui.js";
import { loadEnvFile } from "./env-file.js";
import type { EnvFileLoadResult } from "./env-file.js";
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
import {
  inspectLabManifest,
  listLabManifests,
  resolveLabManifest
} from "./labs.js";
import type {
  LabInspectResult,
  LabListResult,
  LabResolveFailure
} from "./labs.js";
import { runLab, resolveLabDryRun, selectLabBackend } from "./lab-engine.js";
import type { CuaActorLabResult } from "./cua-actor-lab.js";
import type { LabConfig } from "./lab-config.js";
import { renderObserver, serveObserver } from "./observer.js";
import type { ObserverResult, ObserverServer } from "./observer.js";
import {
  DEFAULT_OSS_REPOS,
  runOssLab
} from "./oss-lab.js";
import type { OssLabResult } from "./oss-lab.js";
import {
  cleanupOssMetaLabSandboxes,
  cleanupStaleOssMetaLabSandboxes,
  runOssMetaLab,
  startOssMetaLabLiveRefresh
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

function readCliVersion(): string {
  const packageJsonPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version : "0.0.0";
}

const CLI_VERSION = readCliVersion();

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

interface LabCommandOptions {
  codexAppServer?: boolean | undefined;
  count?: string | undefined;
  cwd: string;
  detach?: boolean | undefined;
  dryRun?: boolean | undefined;
  envFile?: string | undefined;
  json?: boolean | undefined;
  keep?: boolean | undefined;
  limit?: string | undefined;
  open?: boolean | undefined;
  port?: string | undefined;
  redactRepos?: boolean | undefined;
  repo?: string[] | undefined;
  repos?: string | undefined;
  runId?: string | undefined;
  sims?: string | undefined;
}

interface CodexAppServerUiCliResult {
  schema: "mimetic.codex-app-server-ui-result.v1";
  ok: boolean;
  cwd: string;
  reason: string;
  stateFile?: string;
  status?: string;
  url?: string;
  error?: {
    code: "MIMETIC_CODEX_APP_SERVER_PROMPT_REQUIRED" | "MIMETIC_INVALID_PORT" | "MIMETIC_INVALID_TIMEOUT";
    message: string;
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
      { flags: "[lab]", description: "Optional lab id or .yaml path." },
      { flags: "--dry-run", description: "Generate contract proof without browser, keys, or provider spend." },
      { flags: "--app-url <url>", description: "Capture live desktop/mobile browser evidence against a running loopback app URL." },
      { flags: "--actor codex-tui|codex-exec|codex-app-server", description: "Explicitly opt into a local Codex actor." },
      { flags: "--sims <count>", description: "Simulation count. Codex exec runs requested lanes with bounded concurrency; Codex TUI supports 1." },
      { flags: "--env-file <path>", description: "Load a local env file for this run without persisting values." },
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
      { flags: "[lab]", description: "Optional lab id or .yaml path to run and observe." },
      { flags: "--lab <id-or-path>", description: "Explicit lab id or .yaml path." },
      { flags: "--run <id>", description: "Watch an existing run id or latest pointer." },
      { flags: "--sims <count>", description: "Start a fresh synthetic run with this many sims before rendering.", defaultValue: "4 when --run is omitted" },
      { flags: "--env-file <path>", description: "Load a local env file for this watch without persisting values." },
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
    .version(CLI_VERSION)
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
        "  mimetic watch first-run",
        "  mimetic watch --lab .mimetic/labs/local.yaml",
        "  mimetic watch --run latest --detach",
        "  mimetic watch --json --no-open",
        "  mimetic lab list",
        "  mimetic lab run first-run --json --no-open",
        "  mimetic verify --run latest --json",
        "",
        "Public-safety boundary:",
        "  Mimetic must not commit or emit PII, PHI, secrets, keys, raw private transcripts,",
        "  private screenshots, or private upstream artifacts."
      ].join("\n")
    );

  registerInitCommand(program, cliIo);
  registerDoctorCommand(program, cliIo);
  registerRunCommand(program, cliIo);
  registerVerifyCommand(program, cliIo);
  registerReviewCommand(program, cliIo);
  registerRunsCommand(program, cliIo);
  registerWatchCommand(program, cliIo);
  registerCodexCommands(program, cliIo);
  registerLabCommands(program, cliIo);

  const implementedCommands = new Set(["init", "doctor", "run", "verify", "review", "runs", "watch", "codex", "lab"]);
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
    .argument("[lab]", "Optional lab id or .yaml path.")
    .description("Run a persona/scenario simulation or synthetic dry-run bundle.")
    .option("--dry-run", "Generate contract proof without browser, keys, or provider spend.")
    .option("--app-url <url>", "Capture live desktop/mobile browser evidence against a running loopback app URL.")
    .addOption(new Option("--actor <actor>", "Explicit live actor to run.").choices(["codex-tui", "codex-exec", "codex-app-server"]))
    .option("--sims <count>", "Simulation count. Codex exec runs requested lanes with bounded concurrency; Codex TUI supports 1.")
    .option("--timeout-ms <ms>", "Local actor timeout in milliseconds.", String(240_000))
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--env-file <path>", "Load a local env file for this run without persisting values.")
    .option("--run-id <id>", "Explicit run id for deterministic fixture tests.")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (lab: string | undefined, options: {
      actor?: string;
      appUrl?: string;
      cwd: string;
      dryRun?: boolean;
      envFile?: string;
      json?: boolean;
      runId?: string;
      sims?: string;
      timeoutMs?: string;
    }, command) => {
      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      if (lab) {
        if (options.appUrl !== undefined || options.actor !== undefined) {
          const result: RunResult = {
            schema: "mimetic.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "MIMETIC_APP_URL_OPTION_CONFLICT",
              message: "Use lab manifests with lab-compatible options only; --app-url and --actor belong to direct `mimetic run`."
            }
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        await runLabCommand({
          command,
          io,
          lab,
          mode: "run",
          options: {
            cwd: options.cwd,
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            ...(options.sims === undefined ? {} : { sims: options.sims })
          }
        });
        return;
      }

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
            message: "--sims must be a positive integer."
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
        ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
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

function registerCodexCommands(parent: Command, io: CliIo): void {
  const codex = parent
    .command("codex")
    .description("Run Codex-native Mimetic integration surfaces.");

  codex
    .command("app-server")
    .description("Run a browser-visible Codex app-server actor surface and write redacted protocol artifacts.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--prompt <text>", "Prompt to submit to Codex app-server.")
    .option("--prompt-file <path>", "Read the Codex app-server prompt from a file.")
    .option("--run-root <path>", "Artifact directory for redacted app-server evidence.", ".mimetic/codex-app-server-ui")
    .option("--state-file <path>", "State JSON file for external observers.")
    .option("--timeout-ms <ms>", "Actor timeout in milliseconds.", String(240_000))
    .option("--port <port>", "Local browser UI port.", "0")
    .option("--model <model>", "Optional Codex model override.")
    .addOption(new Option("--sandbox <mode>", "Turn sandbox policy.").choices(["read-only", "workspace-write", "danger-full-access"]).default("read-only"))
    .option("--actor-command <command>", "Override app-server command. Defaults to codex app-server --listen stdio://.")
    .option("--keep-open", "Keep the browser UI process alive after the actor finishes.")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: {
      actorCommand?: string;
      cwd: string;
      json?: boolean;
      keepOpen?: boolean;
      model?: string;
      port: string;
      prompt?: string;
      promptFile?: string;
      runRoot: string;
      sandbox: "read-only" | "workspace-write" | "danger-full-access";
      stateFile?: string;
      timeoutMs: string;
    }, command) => {
      const timeoutMs = parseTimeoutMs(options.timeoutMs);
      const port = parseObserverPort(options.port);
      if (timeoutMs === null) {
        const result = codexAppServerUiError(options.cwd, "MIMETIC_INVALID_TIMEOUT", "--timeout-ms must be an integer between 1 and 600000.");
        writeResult(command, io, result, formatCodexAppServerUiHuman);
        io.setExitCode(2);
        return;
      }
      if (port === null) {
        const result = codexAppServerUiError(options.cwd, "MIMETIC_INVALID_PORT", "--port must be an integer between 0 and 65535.");
        writeResult(command, io, result, formatCodexAppServerUiHuman);
        io.setExitCode(2);
        return;
      }

      const prompt = await readCodexAppServerPrompt(options);
      if (!prompt) {
        const result = codexAppServerUiError(options.cwd, "MIMETIC_CODEX_APP_SERVER_PROMPT_REQUIRED", "Provide --prompt or --prompt-file.");
        writeResult(command, io, result, formatCodexAppServerUiHuman);
        io.setExitCode(2);
        return;
      }

      const controller = await startCodexAppServerUi({
        ...(options.actorCommand === undefined ? {} : { actorCommand: options.actorCommand }),
        cwd: options.cwd,
        keepOpen: options.keepOpen === true,
        ...(options.model === undefined ? {} : { model: options.model }),
        port,
        prompt,
        runRoot: options.runRoot,
        sandbox: options.sandbox,
        ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }),
        timeoutMs
      });

      const initial = {
        schema: "mimetic.codex-app-server-ui-result.v1" as const,
        ok: true,
        cwd: resolve(options.cwd),
        stateFile: controller.stateFile,
        url: controller.url,
        status: controller.initialState.status,
        reason: controller.initialState.reason
      };
      if (options.keepOpen === true) {
        writeResult(command, io, initial, formatCodexAppServerUiHuman);
        io.setExitCode(0);
        await controller.completion;
        await new Promise<void>((resolveWait) => {
          process.once("SIGINT", () => {
            void controller.close().finally(resolveWait);
          });
        });
        return;
      }

      const completed = await controller.completion;
      const output = codexAppServerUiResultFromState(completed);
      writeResult(command, io, output, formatCodexAppServerUiHuman);
      io.setExitCode(output.ok ? 0 : 2);
    });
}

function registerWatchCommand(parent: Command, io: CliIo): void {
  parent
    .command("watch")
    .argument("[lab]", "Optional lab id or .yaml path to run and observe.")
    .description("Run sims, open the observer, and keep the shell attached.")
    .option("--lab <id-or-path>", "Explicit lab id or .yaml path.")
    .option("--run <id>", "Watch an existing run id or latest pointer.")
    .option("--dry-run", "Lab only: render contract evidence without live provider spend.")
    .option("--codex-app-server", "Lab only: use Codex app-server client mode for OSS headed desktops.")
    .option("--sims <count>", "Start a fresh synthetic run with this many sims before rendering. Defaults to 4 when --run is omitted.")
    .option("--count <count>", "Lab only: override headed desktop lane count.")
    .option("--limit <count>", "Lab only: override smoke lab repo limit.")
    .option("--repo <owner/repo>", "Lab only: GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--repos <owner/repo,...>", "Lab only: comma-separated GitHub repo slugs.")
    .option("--redact-repos", "Lab only: redact repo labels in durable artifacts.")
    .option("--no-redact-repos", "Lab only: persist repo labels. Use only for public-safe runs.")
    .option("--keep", "Lab only: keep disposable clone sandbox for debugging.")
    .option("--run-id <id>", "Explicit run id for deterministic fixture tests.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--env-file <path>", "Load a local env file for this watch without persisting values.")
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
        "  mimetic watch first-run",
        "  mimetic watch --lab .mimetic/labs/local.yaml",
        "",
        "Agent/CI path:",
        "  mimetic watch --json --no-open",
        "",
        "Existing evidence:",
        "  mimetic watch --run latest --detach"
      ].join("\n")
    )
    .action(async (labArg: string | undefined, options: {
      cwd: string;
      count?: string;
      codexAppServer?: boolean;
      detach?: boolean;
      dryRun?: boolean;
      envFile?: string;
      follow?: boolean;
      json?: boolean;
      keep?: boolean;
      lab?: string;
      limit?: string;
      open?: boolean;
      port: string;
      redactRepos?: boolean;
      repo: string[];
      repos?: string;
      run?: string;
      runId?: string;
      sims?: string;
    }, command) => {
      const lab = options.lab ?? labArg;
      if (options.lab !== undefined && labArg !== undefined) {
        const result: RunResult = {
          schema: "mimetic.run-result.v1",
          ok: false,
          cwd: options.cwd,
          warnings: [],
          error: {
            code: "MIMETIC_WATCH_OPTION_CONFLICT",
            message: "Use either positional lab or --lab, not both."
          }
        };
        writeResult(command, io, result, formatRunHuman);
        io.setExitCode(2);
        return;
      }

      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      if (lab) {
        if (options.run !== undefined) {
          const result: RunResult = {
            schema: "mimetic.run-result.v1",
            ok: false,
            cwd: options.cwd,
            warnings: [],
            error: {
              code: "MIMETIC_WATCH_OPTION_CONFLICT",
              message: "Use either a lab to start evidence or --run to watch existing evidence, not both."
            }
          };
          writeResult(command, io, result, formatRunHuman);
          io.setExitCode(2);
          return;
        }

        await runLabCommand({
          command,
          io,
          lab,
          mode: "watch",
          options: {
            cwd: options.cwd,
            ...(options.count === undefined ? {} : { count: options.count }),
            ...(options.codexAppServer === undefined ? {} : { codexAppServer: options.codexAppServer }),
            ...(options.detach === undefined ? {} : { detach: options.detach }),
            ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
            ...(options.keep === undefined ? {} : { keep: options.keep }),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.open === undefined ? {} : { open: options.open }),
            port: options.port,
            ...(options.redactRepos === undefined ? {} : { redactRepos: options.redactRepos }),
            repo: options.repo,
            ...(options.repos === undefined ? {} : { repos: options.repos }),
            ...(options.runId === undefined ? {} : { runId: options.runId }),
            ...(options.sims === undefined ? {} : { sims: options.sims })
          }
        });
        return;
      }

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
            message: "--sims must be a positive integer."
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
    .description("List, inspect, and run Mimetic lab manifests.");

  lab
    .command("list")
    .description("List committed and ignored Mimetic lab manifests.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean }, command) => {
      const result = await listLabManifests(options.cwd);
      writeResult(command, io, result, formatLabListHuman);
      io.setExitCode(0);
    });

  lab
    .command("inspect")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Inspect a Mimetic lab manifest without running it.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (labName: string, options: { cwd: string; json?: boolean }, command) => {
      const result = await inspectLabManifest(options.cwd, labName);
      writeResult(command, io, result, formatLabInspectHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  lab
    .command("cleanup")
    .argument("[lab]", "Provider-backed lab to clean up.", "oss")
    .description("Clean up stale provider resources for a lab without printing provider ids.")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (labName: string, _options: { json?: boolean }, command) => {
      if (labName !== "oss") {
        const result = {
          schema: "mimetic.oss-meta-lab-cleanup-result.v1" as const,
          ok: false,
          lab: labName,
          cleanup: { killed: 0, skipped: 0, errors: [`Unsupported cleanup lab '${labName}'.`] }
        };
        writeResult(command, io, result, formatOssMetaLabCleanupHuman);
        io.setExitCode(2);
        return;
      }

      const cleanup = await cleanupStaleOssMetaLabSandboxes();
      const result = {
        schema: "mimetic.oss-meta-lab-cleanup-result.v1" as const,
        ok: cleanup.errors.length === 0,
        lab: "oss",
        cleanup
      };
      writeResult(command, io, result, formatOssMetaLabCleanupHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });

  lab
    .command("run")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Run a Mimetic lab manifest.")
    .option("--env-file <path>", "Load a local env file for this lab without persisting values.")
    .option("--dry-run", "Render contract evidence without live provider spend.")
    .option("--codex-app-server", "Use Codex app-server client mode for headed desktop actor surfaces.")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--sims <count>", "Override synthetic sims or headed desktop lanes.")
    .option("--count <count>", "Override headed desktop lane count.")
    .option("--limit <count>", "Override smoke lab repo limit.")
    .option("--run-id <id>", "Explicit lab run id.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--repo <owner/repo>", "GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--repos <owner/repo,...>", "Comma-separated GitHub repo slugs.")
    .option("--redact-repos", "Redact repo labels in durable lab artifacts.")
    .option("--no-redact-repos", "Persist repo labels in durable lab artifacts. Use only for public-safe runs.")
    .option("--keep", "Smoke labs only: keep disposable clone sandbox for debugging.")
    .option("--json", "Print a machine-readable JSON response.")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  mimetic lab run first-run",
        "  mimetic lab run oss --dry-run --json --no-open",
        "  mimetic lab run .mimetic/labs/private-dogfood.yaml --env-file .mimetic/local/provider.env",
        "",
        "Human watch path:",
        "  mimetic watch first-run",
        "  mimetic watch --lab .mimetic/labs/local.yaml"
      ].join("\n")
    )
    .action(async (labName: string, options: LabCommandOptions, command) => {
      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

      await runLabCommand({
        command,
        io,
        lab: labName,
        mode: "run",
        options
      });
    });

  lab
    .command("oss", { hidden: true })
    .description("Alias: run the bundled OSS meta-lab manifest.")
    .option("--env-file <path>", "Load a local env file for this lab without persisting values.")
    .option("--repos <owner/repo,...>", "Comma-separated GitHub repo slugs.")
    .option("--repo <owner/repo>", "GitHub repo slug. Repeatable.", collectRepeated, [])
    .option("--count <count>", "Number of headed desktop sims to assign.", String(DEFAULT_OSS_REPOS.length))
    .option("--sims <count>", "Alias for --count.")
    .option("--run-id <id>", "Explicit lab run id.")
    .option("--cwd <path>", "Host directory for ignored .mimetic lab report.", ".")
    .option("--dry-run", "Render the Observer-of-Observers contract without provider spend or live E2B launch.")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--redact-repos", "Redact repo labels in durable lab artifacts.")
    .option("--no-redact-repos", "Persist repo labels in durable lab artifacts. Defaults to redacted when a GitHub token is present.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--smoke", "Run the disposable local clone smoke harness instead of headed meta-sims.")
    .option("--limit <count>", "Smoke mode only: number of selected repos to trial.", String(DEFAULT_OSS_REPOS.length))
    .option("--keep", "Smoke mode only: keep disposable clone sandbox for debugging.")
    .option("--json", "Print a machine-readable JSON response.")
    .addHelpText(
      "after",
      [
        "",
        "Preferred paths:",
        "  mimetic watch oss",
        "  mimetic lab run oss",
        "",
        "Repo selection:",
        "  mimetic watch --lab .mimetic/labs/local-oss.yaml",
        "  mimetic lab run oss --repos CorentinTh/it-tools,drawdb-io/drawdb,maciekt07/TodoApp,lissy93/dashy",
        "  mimetic lab run oss --repo CorentinTh/it-tools --repo drawdb-io/drawdb --count 4",
        "",
        "Agent/CI path:",
        "  mimetic lab run oss --dry-run --json --no-open",
        "",
        "Disposable clone smoke:",
        "  mimetic lab run oss-smoke --limit 1 --keep",
        "  mimetic lab oss-smoke --limit 1 --keep",
        "",
        "Shape:",
        "  The top-level Observer shows headed E2B desktop lanes. Each desktop clones",
        "  its assigned authorized repo, sets up Mimetic, starts the target app where",
        "  feasible, opens desktop/mobile app windows plus the nested Observer, and",
        "  starts a nonblocking Codex actor attempt.",
        "",
        "Safety:",
        "  Only GitHub owner/repo slugs are accepted. Live stream auth URLs are",
        "  runtime-only. Repo labels are redacted by default when a GitHub token",
        "  is present; pass --no-redact-repos only for public-safe runs."
      ].join("\n")
    )
    .action(async (options: {
      count: string;
      codexAppServer?: boolean;
      cwd: string;
      detach?: boolean;
      dryRun?: boolean;
      envFile?: string;
      json?: boolean;
      keep?: boolean;
      limit: string;
      open?: boolean;
      port: string;
      redactRepos?: boolean;
      repo: string[];
      repos?: string;
      runId?: string;
      sims?: string;
      smoke?: boolean;
    }, command) => {
      if (!await applyEnvFileOption({
        command,
        cwd: options.cwd,
        envFile: options.envFile,
        io
      })) {
        return;
      }

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
      const repoOverrideRequested = options.repo.length > 0 || options.repos !== undefined;
      const redactRepoNames = options.redactRepos ?? (repoOverrideRequested ? true : undefined);
      let server: ObserverServer | null = null;
      let liveRefresh = null as ReturnType<typeof startOssMetaLabLiveRefresh>;
      let result: OssMetaLabResult;
      try {
        result = await runOssMetaLab({
          ...(wantsFollow ? { completionTimeoutMs: 0 } : {}),
          ...(options.codexAppServer === undefined ? {} : { codexAppServer: options.codexAppServer }),
          cwd: options.cwd,
          ...(wantsFollow
            ? {
                onObserverReady: async (observer) => {
                  if (!server) {
                    server = await serveObserver(observer, { open: shouldOpen, port });
                  }
                }
              }
            : {}),
          open: wantsFollow ? false : shouldOpen,
          ...(redactRepoNames === undefined ? {} : { redactRepoNames }),
          repos: [...options.repo, ...(options.repos ? [options.repos] : [])],
          ...(count === null ? { count: Number.NaN } : { count }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
          ...(options.runId === undefined ? {} : { runId: options.runId })
        });
      } catch (error) {
        const earlyServer = server as ObserverServer | null;
        await earlyServer?.close().catch((cleanupError: unknown) => {
          io.writeErr(`watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
        });
        server = null;
        throw error;
      }

      let output = result;
      if (server && shouldServeOssMetaLabObserver(result, { wantsFollow: true })) {
        liveRefresh = startOssMetaLabLiveRefresh(result);
        output = withOssMetaLabServer(result, server);
      } else if (shouldServeOssMetaLabObserver(result, { wantsFollow })) {
        server = await serveObserver(result.observer, { open: shouldOpen, port });
        liveRefresh = startOssMetaLabLiveRefresh(result);
        output = withOssMetaLabServer(result, server);
      } else {
        const earlyServer = server as ObserverServer | null;
        await earlyServer?.close().catch((error: unknown) => {
          io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
        server = null;
      }

      const exitCode = exitCodeForOssMetaLab(output);
      writeResult(command, io, output, formatOssMetaLabHuman);
      io.setExitCode(exitCode);

      if (shouldForceExitAfterOssMetaLab(output, { detach: options.detach === true, wantsMachine })) {
        // The E2B SDK keeps local handles open after stream URL creation. Detach should
        // return the user's shell, and JSON mode should exit after printing the result.
        setTimeout(() => process.exit(exitCode), 50);
      }

      if (server && output.observer?.ok) {
        await followObserver(io, output.observer, server, output.liveRequested
          ? {
	          onStop: async () => {
	            const cleanup = liveRefresh
	              ? await liveRefresh.cleanup()
	              : await cleanupOssMetaLabSandboxes(output);
	            return [
	              `E2B sandbox cleanup killed ${cleanup.killed}, skipped ${cleanup.skipped}.`,
	              ...cleanup.errors.map((error) => `E2B sandbox cleanup error: ${error}`)
                ];
              }
            }
          : {});
      }
    });

  lab
    .command("oss-smoke", { hidden: true })
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
        "  mimetic lab oss-smoke --repos CorentinTh/it-tools,drawdb-io/drawdb",
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

async function runLabCommand(args: {
  command: Command;
  io: CliIo;
  lab: string;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const resolved = await resolveLabManifest(args.options.cwd, args.lab);
  if (!resolved.ok) {
    writeResult(args.command, args.io, resolved, formatLabResolveFailureHuman);
    args.io.setExitCode(2);
    return;
  }

  // Surface forward-declared-field + .yml warnings on run/watch too, not only on inspect —
  // otherwise a setting that does nothing is silently swallowed on the path users actually run.
  for (const warning of resolved.warnings) {
    args.io.writeErr(`warning: ${warning}\n`);
  }

  const config = resolved.config;
  const backend = selectLabBackend(config);
  switch (backend) {
    case "synthetic":
      await runSyntheticBackend({ ...args, config });
      return;
    case "meta":
      await runMetaBackend({ ...args, config });
      return;
    case "smoke":
      await runSmokeBackend({ ...args, config });
      return;
    case "cua":
      await runCuaBackend({ ...args, config });
      return;
    default:
      // Compile-time exhaustiveness: a future backend must be handled here, not silently no-op.
      throw new Error(`Unhandled lab backend: ${String(backend satisfies never)}`);
  }
}

async function runSyntheticBackend(args: {
  command: Command;
  io: CliIo;
  lab: string;
  config: LabConfig;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const simCount = parseLabCount(args.options.sims, args.config.actors[0]?.count ?? 4);
  if (simCount === null) {
    const result: RunResult = {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: args.options.cwd,
      warnings: [],
      error: {
        code: "MIMETIC_INVALID_SIM_COUNT",
        message: "--sims must be a positive integer."
      }
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    count: simCount,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  });
  if (outcome.backend !== "synthetic") {
    throw new Error(`Expected synthetic backend, got ${outcome.backend}.`);
  }
  const runResult = outcome.result;

  if (args.mode === "run") {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(runResult.ok ? 0 : 2);
    return;
  }

  if (!runResult.ok || !runResult.runId) {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  const openOverride = args.options.open ?? args.config.defaults?.open;
  await renderAndMaybeFollowObserver({
    command: args.command,
    cwd: args.options.cwd,
    io: args.io,
    port: args.options.port ?? "0",
    runInput: runResult.runId,
    ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
    ...(openOverride === undefined ? {} : { open: openOverride })
  });
}

async function runCuaBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = args.options.open === false
    ? false
    : wantsMachine
      ? args.options.open === true
      : args.options.open ?? args.config.defaults?.open ?? args.mode === "watch";

  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    // Watch mode opens the served Observer below instead of the static render.
    open: args.mode === "watch" ? false : shouldOpen,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  });
  if (outcome.backend !== "cua") {
    throw new Error(`Expected cua backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatCuaLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  // Watch mode serves the freshly rendered Observer (and opens it unless told not to).
  if (args.mode === "watch" && result.ok && !wantsMachine) {
    await renderAndMaybeFollowObserver({
      command: args.command,
      cwd: args.options.cwd,
      io: args.io,
      port: args.options.port ?? "0",
      runInput: result.runId,
      ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
      ...(shouldOpen === undefined ? {} : { open: shouldOpen })
    });
  }
}

function formatCuaLabHuman(result: CuaActorLabResult): string {
  return [
    `mimetic lab cua ${result.ok ? (result.dryRun ? "dry-run" : "live") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
    `run: ${result.runId}`,
    `lab: ${result.labId}`,
    `actor: ${result.actor}`,
    `subject: ${result.appUrl}`,
    ...(result.subject?.source === "clone"
      ? [`repo: ${result.subject.repo}${result.subject.commit ? `@${result.subject.commit.slice(0, 12)}` : ""}${result.subject.envNames && result.subject.envNames.length > 0 ? ` env=[${result.subject.envNames.join(", ")}]` : ""}`]
      : []),
    ...(result.session
      ? [`session: ${result.session.status} (${result.session.completionReason}) — ${result.session.reason}`,
         `screenshots: ${result.session.screenshots} (redacted)`]
      : []),
    ...(result.sandbox
      ? [`sandbox: ${result.sandbox.sandboxId} stream=${result.sandbox.streamUrlPresent ? "connected" : "missing"} killed=${result.sandbox.killed ? "yes" : "no"}`]
      : []),
    ...(result.observer?.observerPath ? [`observer: ${result.observer.observerPath}`] : []),
    ...(result.observer?.opened === undefined ? [] : [`opened: ${result.observer.opened ? "yes" : "no"}`]),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

async function runSmokeBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const fanout = args.config.subject.clone?.fanout ?? args.config.subject.repos?.length ?? DEFAULT_OSS_REPOS.length;
  const limit = parseLabCount(args.options.limit ?? args.options.sims, fanout);
  if (limit === null) {
    const result: OssLabResult = {
      schema: "mimetic.oss-lab-result.v1",
      ok: false,
      cleanup: { kept: Boolean(args.options.keep), sandboxRemoved: false },
      completedAt: new Date().toISOString(),
      cwd: args.options.cwd,
      error: {
        code: "MIMETIC_INVALID_OSS_LIMIT",
        message: "--limit must be a positive integer."
      },
      repos: [],
      runId: args.options.runId ?? "not-created",
      sandboxPath: ".mimetic/tmp/oss-lab/not-created",
      startedAt: new Date().toISOString(),
      warnings: []
    };
    writeResult(args.command, args.io, result, formatOssLabHuman);
    args.io.setExitCode(2);
    return;
  }

  const repos = labReposOverride(args.options);
  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    count: limit,
    ...(repos === undefined ? {} : { repos }),
    ...(args.options.keep === undefined ? {} : { keep: args.options.keep }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
  });
  if (outcome.backend !== "smoke") {
    throw new Error(`Expected smoke backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatOssLabHuman);
  args.io.setExitCode(result.ok ? 0 : 2);
}

async function runMetaBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const metaCountDefault = args.config.subject.clone?.fanout ?? args.config.subject.repos?.length ?? DEFAULT_OSS_REPOS.length;
  const count = parseLabCount(args.options.count ?? args.options.sims, metaCountDefault);
  const repos = labReposOverride(args.options);
  const port = parseObserverPort(args.options.port ?? "0");
  if (port === null) {
    const result: OssMetaLabResult = {
      schema: "mimetic.oss-meta-lab-result.v1",
      ok: false,
      assignments: [],
      cwd: args.options.cwd,
      dryRun: args.options.dryRun === true,
      error: {
        code: "MIMETIC_META_RUN_FAILED",
        message: "--port must be an integer between 0 and 65535."
      },
      liveRequested: args.options.dryRun !== true,
      repos: repos ?? args.config.subject.repos ?? [],
      sandboxes: [],
      warnings: []
    };
    writeResult(args.command, args.io, result, formatOssMetaLabHuman);
    args.io.setExitCode(2);
    return;
  }

  const wantsMachine = wantsJson(args.command);
  const dryRun = resolveLabDryRun(args.config, args.options.dryRun, undefined);
  const shouldOpen = args.options.open === false
    ? false
    : wantsMachine
      ? args.options.open === true
      : args.options.open ?? args.config.defaults?.open ?? args.mode === "watch";
  const wantsFollow = args.mode === "watch" && !wantsMachine && args.options.detach !== true && dryRun !== true;
  const codexAppServer = args.options.codexAppServer ?? args.config.execution?.desktop?.codexAppServer;
  const repoOverrideRequested = (args.options.repo?.length ?? 0) > 0 || args.options.repos !== undefined;
  const defaultRedactRepos = repoOverrideRequested ? true : args.config.policies?.redactRepos;
  const redactRepoNames = args.options.redactRepos ?? defaultRedactRepos;
  let server: ObserverServer | null = null;
  let liveRefresh = null as ReturnType<typeof startOssMetaLabLiveRefresh>;
  let result: OssMetaLabResult;
  try {
    const outcome = await runLab(args.config, {
      cwd: args.options.cwd,
      ...(wantsFollow ? { completionTimeoutMs: 0 } : {}),
      ...(codexAppServer === undefined ? {} : { codexAppServer }),
      ...(wantsFollow
        ? {
            onObserverReady: async (observer) => {
              if (!server) {
                server = await serveObserver(observer, { open: shouldOpen, port });
              }
            }
          }
        : {}),
      open: wantsFollow ? false : shouldOpen,
      ...(dryRun === undefined ? {} : { dryRun }),
      ...(redactRepoNames === undefined ? {} : { redactRepos: redactRepoNames }),
      ...(repos === undefined ? {} : { repos }),
      count: count === null ? Number.NaN : count,
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId })
    });
    if (outcome.backend !== "meta") {
      throw new Error(`Expected meta backend, got ${outcome.backend}.`);
    }
    result = outcome.result;
  } catch (error) {
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((cleanupError: unknown) => {
      args.io.writeErr(`watch cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`);
    });
    server = null;
    throw error;
  }

  let output = result;
  if (server && shouldServeOssMetaLabObserver(result, { wantsFollow: true })) {
    liveRefresh = startOssMetaLabLiveRefresh(result);
    output = withOssMetaLabServer(result, server);
  } else if (shouldServeOssMetaLabObserver(result, { wantsFollow })) {
    server = await serveObserver(result.observer, { open: shouldOpen, port });
    liveRefresh = startOssMetaLabLiveRefresh(result);
    output = withOssMetaLabServer(result, server);
  } else {
    const earlyServer = server as ObserverServer | null;
    await earlyServer?.close().catch((error: unknown) => {
      args.io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    server = null;
  }

  const exitCode = exitCodeForOssMetaLab(output);
  writeResult(args.command, args.io, output, formatOssMetaLabHuman);
  args.io.setExitCode(exitCode);

  if (shouldForceExitAfterOssMetaLab(output, { detach: args.options.detach === true, wantsMachine })) {
    setTimeout(() => process.exit(exitCode), 50);
  }

  if (server && output.observer?.ok) {
    await followObserver(args.io, output.observer, server, output.liveRequested
	      ? {
	          onStop: async () => {
	            const cleanup = liveRefresh
	              ? await liveRefresh.cleanup()
	              : await cleanupOssMetaLabSandboxes(output);
	            return [
	              `E2B sandbox cleanup killed ${cleanup.killed}, skipped ${cleanup.skipped}.`,
	              ...cleanup.errors.map((error) => `E2B sandbox cleanup error: ${error}`)
            ];
          }
        }
      : {});
  }
}

async function renderAndMaybeFollowObserver(args: {
  command: Command;
  cwd: string;
  detach?: boolean | undefined;
  io: CliIo;
  open?: boolean | undefined;
  port: string;
  runInput: string;
}): Promise<void> {
  const port = parseObserverPort(args.port);
  if (port === null) {
    const result: RunResult = {
      schema: "mimetic.run-result.v1",
      ok: false,
      cwd: args.cwd,
      warnings: [],
      error: {
        code: "MIMETIC_INVALID_PORT",
        message: "--port must be an integer between 0 and 65535."
      }
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  const wantsMachine = wantsJson(args.command);
  const shouldOpen = args.open === false ? false : wantsMachine ? args.open === true : true;
  const wantsFollow = !wantsMachine && args.detach !== true;
  const rendered = await renderObserver(args.cwd, args.runInput, { open: wantsFollow ? false : shouldOpen });
  let server: ObserverServer | null = null;
  let result = rendered;
  if (rendered.ok && wantsFollow) {
    server = await serveObserver(rendered, { open: shouldOpen, port });
    result = withObserverServer(rendered, server);
  }
  writeResult(args.command, args.io, result, formatObserverHuman);
  args.io.setExitCode(result.ok ? 0 : 2);

  if (result.ok && server) {
    await followObserver(args.io, result, server);
  }
}

async function applyEnvFileOption(args: {
  command: Command;
  cwd: string;
  envFile?: string | undefined;
  io: CliIo;
}): Promise<boolean> {
  if (!args.envFile) {
    return true;
  }

  const result = await loadEnvFile(args.cwd, args.envFile);
  if (result.ok) {
    return true;
  }

  writeResult(args.command, args.io, result, formatEnvFileHuman);
  args.io.setExitCode(2);
  return false;
}

function labReposOverride(options: LabCommandOptions): string[] | undefined {
  const override = [
    ...(options.repo ?? []),
    ...(options.repos ? [options.repos] : [])
  ];
  return override.length > 0 ? override : undefined;
}

function parseLabCount(value: string | undefined, fallback: number): number | null {
  return value === undefined ? fallback : parsePositiveInteger(value);
}

function withObserverServer(rendered: ObserverResult, server: ObserverServer): ObserverResult {
  return {
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

function withOssMetaLabServer(result: OssMetaLabResult & { observer: ObserverResult & { ok: true } }, server: ObserverServer): OssMetaLabResult {
  return {
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

function formatCodexAppServerUiHuman(result: CodexAppServerUiCliResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "mimetic codex app-server",
    `url: ${result.url ?? "not-started"}`,
    `status: ${result.status ?? "unknown"}`,
    `state: ${result.stateFile ?? "none"}`,
    `reason: ${result.reason}`
  ].join("\n") + "\n";
}

function formatEnvFileHuman(result: EnvFileLoadResult): string {
  if (!result.ok) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  return [
    "mimetic env-file loaded",
    `env-file: ${result.envFile}`,
    `loaded: ${result.loaded.length ? result.loaded.join(", ") : "none"}`,
    `skipped-existing: ${result.skipped.length ? result.skipped.join(", ") : "none"}`
  ].join("\n") + "\n";
}

function formatLabListHuman(result: LabListResult): string {
  if (result.labs.length === 0) {
    return [
      `No Mimetic labs found in ${result.cwd}`,
      "Create one under mimetic/labs/*.yaml, .mimetic/labs/*.yaml, or pass a .yaml path.",
      ...result.warnings.map((warning) => `warning: ${warning}`)
    ].join("\n") + "\n";
  }

  return [
    "mimetic labs",
    ...result.labs.map((lab) => `- ${lab.id} ${lab.source} ${lab.origin} ${lab.path}${lab.title ? ` (${lab.title})` : ""}`),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatLabInspectHuman(result: LabInspectResult): string {
  if (!result.ok || !result.config) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  const config = result.config;
  return [
    "mimetic lab",
    `id: ${config.id}`,
    `subject: ${config.subject.source}`,
    ...(config.execution?.target ? [`execution: ${config.execution.target}`] : []),
    `actors: ${config.actors.map((actor) => actor.type).join(", ")}`,
    ...(config.title ? [`title: ${config.title}`] : []),
    ...(config.description ? [`description: ${config.description}`] : []),
    ...(result.path ? [`path: ${result.path}`] : []),
    ...(result.origin ? [`origin: ${result.origin}`] : []),
    ...(config.subject.repos?.length ? [`repos: ${config.subject.repos.join(", ")}`] : []),
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

function formatLabResolveFailureHuman(result: LabResolveFailure): string {
  return [
    `${result.error.code}: ${result.error.message}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
}

async function readCodexAppServerPrompt(options: {
  cwd: string;
  prompt?: string;
  promptFile?: string;
}): Promise<string | null> {
  if (options.prompt !== undefined && options.prompt.trim()) {
    return options.prompt;
  }
  if (options.promptFile !== undefined && options.promptFile.trim()) {
    const promptPath = resolve(options.cwd, options.promptFile);
    const text = await readFile(promptPath, "utf8");
    return text.trim() || null;
  }
  return null;
}

function codexAppServerUiError(
  cwd: string,
  code: NonNullable<CodexAppServerUiCliResult["error"]>["code"],
  message: string
): CodexAppServerUiCliResult {
  return {
    schema: "mimetic.codex-app-server-ui-result.v1",
    ok: false,
    cwd: resolve(cwd),
    reason: message,
    error: { code, message }
  };
}

function codexAppServerUiResultFromState(state: CodexAppServerUiState): CodexAppServerUiCliResult {
  return {
    schema: "mimetic.codex-app-server-ui-result.v1",
    ok: state.status === "passed",
    cwd: state.cwd,
    reason: state.reason,
    stateFile: state.stateFile,
    status: state.status,
    ...(state.url === undefined ? {} : { url: state.url })
  };
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
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

type WatchStopSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

interface WatchSignalTarget {
  once(event: WatchStopSignal, listener: () => void): unknown;
  removeListener(event: WatchStopSignal, listener: () => void): unknown;
}

export async function followObserver(
  io: CliIo,
  result: ObserverResult,
  server: ObserverServer,
  options: {
    onStop?: () => Promise<string[]>;
    signalTarget?: WatchSignalTarget;
    signals?: WatchStopSignal[];
  } = {}
): Promise<void> {
  io.writeOut(`watching: ${result.serverUrl ?? result.observerUrl ?? result.observerPath}\n`);
  io.writeOut("watching: press Ctrl-C to stop\n");
  await new Promise<void>((resolve) => {
    const signalTarget = options.signalTarget ?? process;
    const signals = options.signals ?? ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<WatchStopSignal, () => void>();
    let stopping = false;

    const stop = (signal: WatchStopSignal) => {
      if (stopping) {
        return;
      }

      stopping = true;
      for (const [registeredSignal, handler] of handlers.entries()) {
        signalTarget.removeListener(registeredSignal, handler);
      }
      io.setExitCode(exitCodeForSignal(signal));

      (async () => {
        try {
          await server.close();
        } catch (error: unknown) {
          io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }

        if (options.onStop) {
          try {
            const messages = await options.onStop();
            for (const message of messages) {
              io.writeOut(`watch cleanup: ${message}\n`);
            }
          } catch (error: unknown) {
            io.writeErr(`watch cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }

        io.writeOut("watch stopped\n");
        resolve();
      })();
    };

    for (const signal of signals) {
      const handler = () => stop(signal);
      handlers.set(signal, handler);
      signalTarget.once(signal, handler);
    }
  });
}

function exitCodeForSignal(signal: WatchStopSignal): number {
  switch (signal) {
    case "SIGINT":
      return 130;
    case "SIGTERM":
      return 143;
    case "SIGHUP":
      return 129;
  }
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
  return [
    `mimetic lab oss ${result.ok ? (result.dryRun ? "dry-run" : "watch") : "failed"}`,
    ...(result.error ? [`${result.error.code}: ${result.error.message}`] : []),
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

function formatOssMetaLabCleanupHuman(result: {
  cleanup: {
    errors: string[];
    killed: number;
    matched?: number;
    remaining?: number;
    skipped: number;
  };
  lab: string;
  ok: boolean;
  schema: string;
}): string {
  return [
    `mimetic lab cleanup ${result.lab} ${result.ok ? "passed" : "failed"}`,
    ...(result.cleanup.matched === undefined ? [] : [`matched: ${result.cleanup.matched}`]),
    `killed: ${result.cleanup.killed}`,
    `skipped: ${result.cleanup.skipped}`,
    ...(result.cleanup.remaining === undefined ? [] : [`remaining: ${result.cleanup.remaining}`]),
    ...result.cleanup.errors.map((error) => `error: ${error}`)
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

export function shouldForceExitAfterOssMetaLab(
  output: OssMetaLabResult,
  options: { detach: boolean; wantsMachine: boolean }
): boolean {
  return output.liveRequested === true
    && (options.detach || options.wantsMachine)
    && output.sandboxes.some((sandbox) => sandbox.urlPresent);
}

export function shouldServeOssMetaLabObserver(
  output: OssMetaLabResult,
  options: { wantsFollow: boolean }
): output is OssMetaLabResult & { observer: ObserverResult & { ok: true } } {
  return options.wantsFollow
    && output.observer?.ok === true;
}

export function exitCodeForOssMetaLab(output: OssMetaLabResult): number {
  return output.ok ? 0 : 2;
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
