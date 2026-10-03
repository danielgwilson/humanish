import { formatAutomaticAnalysisBudget } from "../../analysis/automatic-config.js";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { inspectLabManifest, listLabManifests } from "../../lab/discover.js";
import type { LabInspectResult, LabListResult } from "../../lab/discover.js";
import {
  runLabPreflight,
  type LabPreflightReachabilityMode,
  type LabPreflightResult,
} from "../../lab/preflight.js";
import { runLabCommand } from "./lab-run.js";
import { countOption, participantsOption } from "../renamed-options.js";
import {
  applyEnvFileOption,
  type CliIo,
  JSON_OPTION_DESCRIPTION,
  type LabCommandOptions,
  parsePositiveInteger,
  writeResult,
} from "../io.js";

export function registerLabCommands(parent: Command, io: CliIo): void {
  const lab = parent
    .command("lab")
    .description("List, inspect, and run humanish lab manifests.")
    .summary("List, inspect, and run humanish lab manifests.");

  lab
    .command("list")
    .description("List committed and ignored humanish lab manifests.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options, command) => handleLabList(io, options, command));

  lab
    .command("inspect")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Inspect a humanish lab manifest without running it.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((labName, options, command) => handleLabInspect(io, labName, options, command));

  lab
    .command("preflight")
    .argument("<lab>", "Lab id or .yaml path.")
    .description(
      "Check lab metadata or explicitly probe reachability. Metadata mode does not verify setup; use doctor --lab <lab> first.",
    )
    .option("--cwd <path>", "Target project directory.", ".")
    .addOption(
      new Option("--reachability <mode>", "Reachability mode.")
        .choices(["metadata", "public-preview", "sandbox-loopback", "prepared-host"])
        .default("metadata"),
    )
    .option("--timeout-ms <ms>", "Target reachability timeout.", String(30_000))
    .option(
      "--env-file <path>",
      "Load a local env file for this preflight without persisting values.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((labName, options, command) => handleLabPreflight(io, labName, options, command));

  lab
    .command("run")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Run a humanish lab manifest. Same as `humanish run <lab>`, grouped under `lab`.")
    .option("--env-file <path>", "Load a local env file for this lab without persisting values.")
    .option("--dry-run", "Render contract evidence without live provider spend.")
    .option("--open", "Open the observer in the default browser.")
    .option("--no-open", "Render without opening a browser.")
    .option("--detach", "Render/open once and exit without attached watch server.")
    .option("--port <port>", "Local observer server port when following.", "0")
    .option("--count <count>", "Override the participant count of a preview or computer-use lab.")
    // The older spelling of --count, hidden and noted on stderr (renamed-options.ts).
    .addOption(new Option("--sims <count>").hideHelp())
    .option(
      "--rerun-failed-from <run>",
      "CUA fan-out only: create a new run for failed participants from a prior run.",
    )
    .option(
      "--participants <ids>",
      "CUA rerun only: comma-separated participant ids from the source run. Ids are the lab's declared actors[0].lanes[].id, or lane-01, lane-02, … by position.",
    )
    // The older spelling of --participants, hidden and noted on stderr (renamed-options.ts).
    .addOption(new Option("--lanes <participant-ids>").hideHelp())
    .option("--run-id <id>", "Explicit lab run id; refused when that run already exists.")
    .option("--cwd <path>", "Target project directory.", ".")
    .option(
      "--scorer <path>",
      "Terminal/computer-use/shared-world labs only: repo-relative adopter scorer module (.mjs). Overrides review.scorer.ref. Executable code: review it as code.",
    )
    .option("--json", JSON_OPTION_DESCRIPTION)
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  humanish lab run first-run",
        "  humanish lab run fanout-demo --rerun-failed-from latest --participants lane-02,lane-04",
        "  humanish lab run my-terminal-lab --scorer scorers/product.mjs",
        "  humanish lab run .humanish/labs/private-dogfood.yaml --env-file .humanish/local/provider.env",
        "",
        "Human watch path:",
        "  humanish watch first-run",
      ].join("\n"),
    )
    .action((labName, options, command) => handleLabRun(io, labName, options, command));
}

async function handleLabList(
  io: CliIo,
  options: { cwd: string; json?: boolean },
  command: Command,
): Promise<void> {
  const result = await listLabManifests(options.cwd);
  writeResult(command, io, result, formatLabListHuman);
  io.setExitCode(0);
}

async function handleLabInspect(
  io: CliIo,
  labName: string,
  options: { cwd: string; json?: boolean },
  command: Command,
): Promise<void> {
  const result = await inspectLabManifest(options.cwd, labName);
  writeResult(command, io, result, formatLabInspectHuman);
  io.setExitCode(result.ok ? 0 : 2);
}

async function handleLabPreflight(
  io: CliIo,
  labName: string,
  options: {
    cwd: string;
    envFile?: string;
    json?: boolean;
    reachability: LabPreflightReachabilityMode;
    timeoutMs: string;
  },
  command: Command,
): Promise<void> {
  if (
    !(await applyEnvFileOption({
      command,
      cwd: options.cwd,
      envFile: options.envFile,
      io,
    }))
  ) {
    return;
  }

  const timeoutMs = parsePositiveInteger(options.timeoutMs);
  if (timeoutMs === null) {
    const result: LabPreflightResult = {
      schema: "humanish.lab-preflight-result.v1",
      ok: false,
      cwd: resolve(options.cwd),
      lab: labName,
      reachability: options.reachability,
      checks: [{ name: "timeout", ok: false, message: "--timeout-ms must be a positive integer." }],
      targets: [],
      sandbox: { created: false },
      spend: { e2bDesktop: false, model: false },
      warnings: [],
      error: {
        code: "HUMANISH_STUDY_PREFLIGHT_INVALID_OPTION",
        message: "--timeout-ms must be a positive integer.",
      },
    };
    writeResult(command, io, result, formatLabPreflightHuman);
    io.setExitCode(2);
    return;
  }

  const result = await runLabPreflight({
    cwd: options.cwd,
    lab: labName,
    reachability: options.reachability,
    timeoutMs,
  });
  writeResult(command, io, result, formatLabPreflightHuman);
  io.setExitCode(result.ok ? 0 : 2);
}

async function handleLabRun(
  io: CliIo,
  labName: string,
  options: LabCommandOptions & { sims?: string; lanes?: string },
  command: Command,
): Promise<void> {
  const count = countOption(io, options);
  const participants = participantsOption(io, options);
  if (
    !(await applyEnvFileOption({
      command,
      cwd: options.cwd,
      envFile: options.envFile,
      io,
      // runLabCommand discovers keys once the lab resolves to a live run.
      discoverKeys: false,
    }))
  ) {
    return;
  }

  await runLabCommand({
    command,
    io,
    lab: labName,
    mode: "run",
    options: { ...options, count, participants },
  });
}

function formatLabListHuman(result: LabListResult): string {
  if (result.labs.length === 0) {
    return (
      [
        `No humanish labs found in ${result.cwd}`,
        "Create one under humanish/studies/*.yaml or humanish/labs/*.yaml, or pass a .yaml path.",
        ...result.warnings.map((warning) => `warning: ${warning}`),
      ].join("\n") + "\n"
    );
  }

  return (
    [
      "humanish labs",
      ...result.labs.map(
        (lab) =>
          `- ${lab.id} ${lab.source} ${lab.origin} ${lab.path}${lab.title ? ` (${lab.title})` : ""}${lab.error ? `\n  error: ${lab.error}` : ""}`,
      ),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

function formatLabInspectHuman(result: LabInspectResult): string {
  if (!result.ok || !result.config) {
    return `${result.error?.code}: ${result.error?.message}\n`;
  }

  const config = result.config;
  return (
    [
      "humanish lab",
      `id: ${config.id}`,
      `subject: ${config.subject.source}`,
      ...(config.execution?.target ? [`execution: ${config.execution.target}`] : []),
      `actors: ${config.actors.map((actor) => actor.type).join(", ")}`,
      ...(config.title ? [`title: ${config.title}`] : []),
      ...(config.description ? [`description: ${config.description}`] : []),
      ...(result.path ? [`path: ${result.path}`] : []),
      ...(result.origin ? [`origin: ${result.origin}`] : []),
      ...(config.subject.repos?.length ? [`repos: ${config.subject.repos.join(", ")}`] : []),
      ...(result.personas ?? []).map(
        (persona) =>
          `persona ${persona.id}: ${persona.brief ? `authored context (before runtime additions)\n${persona.brief.text}` : "unresolved; id only"}`,
      ),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

function formatLabPreflightHuman(result: LabPreflightResult): string {
  const checkedTargets = result.targets.filter((target) => target.checked);
  const reachableTargets = checkedTargets.filter((target) => target.reachable === true);
  const blockedTargets = result.targets.filter((target) => target.status === "blocked");
  return (
    [
      `humanish lab preflight ${result.ok ? "passed" : "failed"}`,
      `lab: ${result.labId ?? result.lab}`,
      ...(result.route ? [`route: ${result.route}`] : []),
      `reachability: ${result.reachability}`,
      `targets: ${checkedTargets.length ? `${reachableTargets.length}/${checkedTargets.length} reachable` : `${result.targets.length} declared, not checked`}`,
      ...(blockedTargets.length ? [`blocked-targets: ${blockedTargets.length}`] : []),
      `spend: ${result.spend.e2bDesktop ? "one e2b desktop, no model calls" : "none"}`,
      ...(result.analysis ? [formatAutomaticAnalysisBudget(result.analysis)] : []),
      ...(result.sandbox.created
        ? [`sandbox: created=yes killed=${result.sandbox.killed === true ? "yes" : "no"}`]
        : []),
      ...result.checks.map(
        (check) => `- ${check.ok ? "ok" : "fail"} ${check.name}: ${check.message}`,
      ),
      ...(result.error ? [`error: ${result.error.code}: ${result.error.message}`] : []),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}
