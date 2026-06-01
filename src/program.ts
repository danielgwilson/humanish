import { Command } from "commander";

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

  for (const plannedCommand of plannedCommands) {
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
