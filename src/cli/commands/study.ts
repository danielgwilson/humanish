import { formatAutomaticAnalysisBudget } from "../../analysis/automatic-config.js";
import { resolve } from "node:path";
import { Command, Option } from "commander";
import { inspectLabManifest, listLabManifests } from "../../study/discover.js";
import type { LabInspectResult, LabListResult } from "../../study/discover.js";
import {
  runLabPreflight,
  type LabPreflightReachabilityMode,
  type LabPreflightResult,
} from "../../study/preflight.js";
import { addRunOptions, handleRun } from "./run-command.js";
import { deprecationMessage, warnAndQueue } from "../deprecations.js";
import {
  applyEnvFileOption,
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  ENV_FILE_OPTION_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  type LabCommandOptions,
  parsePositiveInteger,
  writeResult,
  type HumanOutput,
  humanError,
} from "../io.js";

export function registerStudyCommands(parent: Command, io: CliIo): void {
  const study = parent
    .command("study")
    .description("List, show and check studies in humanish/studies/.");
  listCommand(study.command("list"), io);
  showCommand(study.command("show"), io);
  checkCommand(study.command("check"), io);

  // Removed in 0.109.0: the `lab` group stays one minor, hidden. Its list, inspect and preflight
  // run as study list, show and check, and `lab run` runs as `run`, each after a warning.
  const lab = parent
    .command("lab", { hidden: true })
    .description("Deprecated: use humanish study.");
  listCommand(lab.command("list"), io, "humanish study list");
  showCommand(lab.command("inspect"), io, "humanish study show <study>");
  checkCommand(lab.command("preflight"), io, "humanish study check <study>");
  addRunOptions(
    lab.command("run", { hidden: true }).argument("<study>", "Study id or .yaml path."),
  ).action((name: string, options: LabCommandOptions, command: Command) => {
    warnOldCommand(command, io, "humanish run <study>");
    return handleRun(io, name, options, command);
  });
}

/** The warning for a `lab` subcommand, naming its replacement. */
function warnOldCommand(command: Command, io: CliIo, replacement: string): void {
  warnAndQueue(command, io, deprecationMessage(`humanish lab ${command.name()}`, replacement));
}

function listCommand(command: Command, io: CliIo, replacement?: string): void {
  command
    .description("List the studies in this project, committed and local.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options: { cwd: string; json?: boolean }, command: Command) => {
      if (replacement !== undefined) warnOldCommand(command, io, replacement);
      return handleStudyList(io, options, command);
    });
  if (replacement !== undefined) command.description(`Deprecated: use ${replacement}.`);
}

function showCommand(command: Command, io: CliIo, replacement?: string): void {
  command
    .argument("<study>", "Study id or .yaml path.")
    .description("Show a study's parsed file and its warnings without running it.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((name: string, options: { cwd: string; json?: boolean }, command: Command) => {
      if (replacement !== undefined) warnOldCommand(command, io, replacement);
      return handleStudyShow(io, name, options, command);
    });
  if (replacement !== undefined) command.description(`Deprecated: use ${replacement}.`);
}

function checkCommand(command: Command, io: CliIo, replacement?: string): void {
  command
    .argument("<study>", "Study id or .yaml path.")
    .description(
      "Check the study file and, with --reachability, its named endpoints. humanish doctor --study <study> checks this machine.",
    )
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .addOption(
      new Option("--reachability <mode>", "Reachability mode.")
        .choices(["metadata", "public-preview", "sandbox-loopback", "prepared-host"])
        .default("metadata"),
    )
    .option("--timeout-ms <ms>", "Target reachability timeout.", String(30_000))
    .option("--env-file <path>", ENV_FILE_OPTION_DESCRIPTION)
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((name: string, options: StudyCheckOptions, command: Command) => {
      if (replacement !== undefined) warnOldCommand(command, io, replacement);
      return handleStudyCheck(io, name, options, command);
    });
  if (replacement !== undefined) command.description(`Deprecated: use ${replacement}.`);
}

interface StudyCheckOptions {
  cwd: string;
  envFile?: string;
  json?: boolean;
  reachability: LabPreflightReachabilityMode;
  timeoutMs: string;
}

async function handleStudyList(
  io: CliIo,
  options: { cwd: string; json?: boolean },
  command: Command,
): Promise<void> {
  const result = await listLabManifests(options.cwd);
  writeResult(command, io, result, formatStudyListHuman);
  io.setExitCode(0);
}

async function handleStudyShow(
  io: CliIo,
  name: string,
  options: { cwd: string; json?: boolean },
  command: Command,
): Promise<void> {
  const result = await inspectLabManifest(options.cwd, name);
  writeResult(command, io, result, formatStudyShowHuman);
  io.setExitCode(result.ok ? 0 : 2);
}

async function handleStudyCheck(
  io: CliIo,
  name: string,
  options: StudyCheckOptions,
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
      schema: "humanish.study-check.v1",
      ok: false,
      cwd: resolve(options.cwd),
      study: name,
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
    writeResult(command, io, result, formatStudyCheckHuman);
    io.setExitCode(2);
    return;
  }

  const result = await runLabPreflight({
    cwd: options.cwd,
    lab: name,
    reachability: options.reachability,
    timeoutMs,
  });
  writeResult(command, io, result, formatStudyCheckHuman);
  io.setExitCode(result.ok ? 0 : 2);
}

function formatStudyListHuman(result: LabListResult): string {
  if (result.studies.length === 0) {
    return (
      [
        `No studies found in ${result.cwd}`,
        "Create one under humanish/studies/*.yaml, or pass a .yaml path.",
        ...result.warnings.map((warning) => `warning: ${warning}`),
      ].join("\n") + "\n"
    );
  }

  return (
    [
      "humanish studies",
      ...result.studies.map(
        (lab) =>
          `- ${lab.id} ${lab.source} ${lab.origin} ${lab.path}${lab.title ? ` (${lab.title})` : ""}${lab.error ? `\n  error: ${lab.error}` : ""}`,
      ),
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n"
  );
}

function formatStudyShowHuman(result: LabInspectResult): HumanOutput {
  if (!result.ok || !result.config) return humanError(result.error);

  const config = result.config;
  return (
    [
      "humanish study",
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

function formatStudyCheckHuman(result: LabPreflightResult): HumanOutput {
  const checkedTargets = result.targets.filter((target) => target.checked);
  const reachableTargets = checkedTargets.filter((target) => target.reachable === true);
  const blockedTargets = result.targets.filter((target) => target.status === "blocked");
  const stdout =
    [
      `humanish study check ${result.ok ? "passed" : "failed"}`,
      `study: ${result.studyId ?? result.study}`,
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
      ...result.warnings.map((warning) => `warning: ${warning}`),
    ].join("\n") + "\n";
  return result.error === undefined ? stdout : { stdout, error: result.error };
}
