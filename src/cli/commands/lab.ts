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
import { addRunOptions, handleRun } from "./run-command.js";
import {
  applyEnvFileOption,
  type CliIo,
  CWD_OPTION_DESCRIPTION,
  ENV_FILE_OPTION_DESCRIPTION,
  JSON_OPTION_DESCRIPTION,
  type LabCommandOptions,
  parsePositiveInteger,
  writeResult,
} from "../io.js";

export function registerLabCommands(parent: Command, io: CliIo): void {
  const lab = parent
    .command("lab")
    .description("List, inspect and check the studies in humanish/labs/.");

  lab
    .command("list")
    .description("List committed and ignored humanish lab manifests.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((options, command) => handleLabList(io, options, command));

  lab
    .command("inspect")
    .argument("<lab>", "Lab id or .yaml path.")
    .description("Inspect a humanish lab manifest without running it.")
    .option("--cwd <path>", CWD_OPTION_DESCRIPTION, ".")
    .option("--json", JSON_OPTION_DESCRIPTION)
    .action((labName, options, command) => handleLabInspect(io, labName, options, command));

  lab
    .command("preflight")
    .argument("<lab>", "Lab id or .yaml path.")
    .description(
      "Check lab metadata or explicitly probe reachability. Metadata mode does not verify setup; use doctor --lab <lab> first.",
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
    .action((labName, options, command) => handleLabPreflight(io, labName, options, command));

  // Removed in 0.109.0: `lab run` stays one minor as a hidden alias of `run`, with the same flags.
  addRunOptions(
    lab.command("run", { hidden: true }).argument("<lab>", "Lab id or .yaml path."),
  ).action((labName: string, options: LabCommandOptions, command: Command) => {
    io.writeErr(LAB_RUN_DEPRECATION);
    return handleRun(io, labName, options, command);
  });
}

const LAB_RUN_DEPRECATION =
  "warning: humanish lab run is deprecated and is removed in the next minor. Use humanish run <lab>.\n";

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
