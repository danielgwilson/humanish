import { Command } from "commander";

import { runInit } from "./init.js";
import type { InitChange, InitResult } from "./init.js";
import { renderObserver } from "./observer.js";
import type { ObserverResult } from "./observer.js";
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
  "docs/goals/mimetic-cli-open-source-v0/goal.md"
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
    description: "Open or render the local observer for a run bundle.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/10",
    docs: commonDocs,
    options: [
      { flags: "--run <id>", description: "Run id or latest pointer.", defaultValue: "latest" },
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

const feedbackCommands: PlannedCommand[] = [
  {
    name: "draft",
    description: "Generate a public-safe feedback draft from verified evidence.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/5",
    docs: ["docs/contracts/feedback.md", "docs/architecture/github-feedback-loop.md", ...commonDocs],
    options: [
      { flags: "--run <id>", description: "Run id or latest pointer.", defaultValue: "latest" }
    ]
  },
  {
    name: "issue",
    description: "Print Markdown for a public GitHub issue. Does not mutate GitHub.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/5",
    docs: ["docs/contracts/feedback.md", "docs/architecture/github-feedback-loop.md", ...commonDocs],
    options: [
      { flags: "--run <id>", description: "Run id or latest pointer.", defaultValue: "latest" },
      { flags: "--repo <owner/repo>", description: "Repository slug used in rendered filing instructions." },
      { flags: "--format <format>", description: "Output format.", defaultValue: "markdown" }
    ]
  },
  {
    name: "issue-url",
    description: "Print a prefilled public issue URL. Does not mutate GitHub.",
    issue: "https://github.com/danielgwilson/mimetic-cli/issues/5",
    docs: ["docs/contracts/feedback.md", "docs/architecture/github-feedback-loop.md", ...commonDocs],
    options: [
      { flags: "--run <id>", description: "Run id or latest pointer.", defaultValue: "latest" },
      { flags: "--repo <owner/repo>", description: "Repository slug used in the generated URL." }
    ]
  }
];

export function createProgram(io: Partial<CliIo> = {}): Command {
  const cliIo: CliIo = { ...defaultIo, ...io };
  const program = new Command();

  program
    .name("mimetic")
    .description("Open-source-safe persona simulation CLI and proof harness.")
    .version("0.0.0")
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

  const implementedCommands = new Set(["init", "doctor", "run", "verify", "review", "runs", "watch"]);
  for (const plannedCommand of plannedCommands.filter((command) => !implementedCommands.has(command.name))) {
    registerUnsupportedCommand(program, plannedCommand, cliIo);
  }

  const feedback = program
    .command("feedback")
    .description("Create public-safe feedback drafts without GitHub API mutation.");

  for (const plannedCommand of feedbackCommands) {
    registerUnsupportedCommand(feedback, {
      ...plannedCommand,
      name: `feedback ${plannedCommand.name}`
    }, cliIo, plannedCommand.name);
  }

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
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--run-id <id>", "Explicit run id for deterministic fixture tests.")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; dryRun?: boolean; json?: boolean; runId?: string }, command) => {
      const result = await runDryRun({
        cwd: options.cwd,
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        ...(options.runId === undefined ? {} : { runId: options.runId })
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
    .description("Open or render the local observer for a run bundle.")
    .option("--run <id>", "Run id or latest pointer.", "latest")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--no-open", "Render without opening a browser.")
    .option("--json", "Print a machine-readable JSON response.")
    .action(async (options: { cwd: string; json?: boolean; open?: boolean; run: string }, command) => {
      const result = await renderObserver(options.cwd, options.run);
      const resultWithOpenWarning = options.open === false
        ? result
        : {
            ...result,
            warnings: [
              ...result.warnings,
              "Automatic browser open is not implemented yet; use observerPath."
            ]
          };
      writeResult(command, io, resultWithOpenWarning, formatObserverHuman);
      io.setExitCode(result.ok ? 0 : 2);
    });
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
    `bundle: ${result.bundlePath}`,
    ...result.warnings.map((warning) => `warning: ${warning}`)
  ].join("\n") + "\n";
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
