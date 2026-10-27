// `--remote` on run and watch: plan here, refuse what cannot run remotely, then launch and follow
// the run in a runner sandbox (src/remote/launch.ts). The result and exit code are the run's own.
import path from "node:path";

import type { Command } from "commander";

import {
  launchRemoteRun,
  runnerKeys,
  runsFromPackage,
  type RemoteOutcome,
  type RunnerKeys,
} from "../../remote/launch.js";
import { planRemoteRun, type RemotePlan } from "../../remote/plan.js";
import { INSIDE_RUNNER_ENV } from "../../remote/runner.js";
import type { RunResult } from "../../run/results.js";
import { planStudy, resolveStudyDryRun } from "../../study/plan.js";
import type { StudyConfig } from "../../study/types.js";
import { concurrentSandboxes, sandboxCeiling } from "../../substrates/e2b/lifetime.js";
import { importE2BDesktop } from "../../substrates/e2b/sdk.js";
import { loadModalModule, MODAL_MAX_SANDBOX_MS } from "../../substrates/modal/sdk.js";
import {
  type CliIo,
  formatRunHuman,
  parseObserverPort,
  type StudyCommandOptions,
  wantsJson,
  writeResult,
} from "../io.js";

type RemoteErrorCode = "HUMANISH_REMOTE_REFUSED" | "HUMANISH_REMOTE_FAILED";

/** Where a study's run executes, decided before anything is created. */
export type RunPlacement =
  | { kind: "local"; note?: string }
  | { kind: "remote"; plan: RemotePlan }
  | { kind: "refused"; message: string };

/**
 * Whether this run executes here or in a runner sandbox. A hosted study runs remotely by default
 * when it can; `--local` or `execution.remote: false` keeps it here, and `--remote` or
 * `execution.remote: true` requires a remote run, refused with the reason when the study cannot
 * have one. `--local` and `--remote` win over the study's field.
 */
export function placeRun(args: {
  options: StudyCommandOptions;
  config: StudyConfig;
  studyPath: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Whether this humanish is a built package a runner can install; read from the module when absent. */
  packaged?: boolean;
}): RunPlacement {
  const { options, config } = args;
  if ((args.env ?? process.env)[INSIDE_RUNNER_ENV] === "1")
    return options.remote === true
      ? {
          kind: "refused",
          message: "This run is already inside a runner sandbox, so it runs here.",
        }
      : { kind: "local" };
  const declared = config.execution?.remote;
  if (options.local === true || (options.remote !== true && declared === false))
    return { kind: "local" };
  const required = options.remote === true || declared === true;
  // A dry run creates no sandbox, so it never needs a runner, whatever asked for one.
  if (resolveStudyDryRun(config, options.dryRun, true) !== false)
    return required
      ? { kind: "local", note: "A dry run creates no sandbox, so it runs here, not remotely." }
      : { kind: "local" };
  const local = (reason: string): RunPlacement =>
    required
      ? { kind: "refused", message: `This study cannot run remotely: ${reason}` }
      : movable(config)
        ? {
            kind: "local",
            note: `Not running remotely: ${reason} A run on this machine stops if it sleeps.`,
          }
        : { kind: "local" };
  const flags = localOnlyFlags(options);
  if (flags.length > 0)
    return local(`${flags.join(", ")} ${flags.length === 1 ? "does" : "do"} not run remotely yet.`);
  const cwd = path.resolve(options.cwd);
  const planned = planStudy(config, { cwd, dryRun: false });
  // A study that does not plan is refused by its route with the plan's own message.
  if (!planned.ok)
    return required ? { kind: "refused", message: planned.refusal.message } : { kind: "local" };
  const plan = planned.planned.plan;
  const provider =
    plan.route === "computer-use" && plan.runner.desktop === "e2b-desktop"
      ? plan.runner.provider
      : plan.route === "terminal"
        ? plan.sandboxProvider
        : "e2b";
  const e2bCeiling = sandboxCeiling(process.env);
  const sandboxes = concurrentSandboxes(process.env);
  const remote = planRemoteRun({
    config,
    plan,
    cwd,
    studyPath: args.studyPath,
    ceilingMs: provider === "modal" ? MODAL_MAX_SANDBOX_MS : e2bCeiling.ok ? e2bCeiling.ms : 0,
    concurrentSandboxes: sandboxes.ok ? sandboxes.count : 1,
  });
  if (!remote.ok) return local(remote.reason);
  // Checked last, so a study that could not run remotely anyway gives its own reason.
  if (!(args.packaged ?? runsFromPackage()))
    return local(
      "this humanish runs from source, which a runner cannot install. Build it with pnpm build and run node dist/cli.js to run remotely.",
    );
  return { kind: "remote", plan: remote.plan };
}

/**
 * Whether the study is of a kind that runs remotely, so a reason it does not this time is worth
 * saying: a computer-use study on hosted desktops, or a terminal study. Other routes never run
 * remotely yet.
 */
function movable(config: StudyConfig): boolean {
  const target = config.execution?.target;
  return (
    (config.route === "computer-use" && (target === "e2b-desktop" || target === "modal-desktop")) ||
    config.route === "terminal"
  );
}

/** A refused placement as the command's result. */
export function refuseRemote(
  command: Command,
  io: CliIo,
  cwd: string,
  message: string,
  code: RemoteErrorCode = "HUMANISH_REMOTE_REFUSED",
  forwarded?: NonNullable<RunResult["remote"]>,
): void {
  const result: RunResult = {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd: path.resolve(cwd),
    warnings: [],
    ...(forwarded === undefined ? {} : { remote: forwarded }),
    error: { code, message },
  };
  writeResult(command, io, result, formatRunHuman);
  io.setExitCode(2);
}

/** Launch `remote` in a runner sandbox and report how it ended. */
export async function runRemoteStudy(args: {
  command: Command;
  io: CliIo;
  options: StudyCommandOptions;
  studyPath: string;
  remote: RemotePlan;
}): Promise<void> {
  const { io, options } = args;
  const cwd = path.resolve(options.cwd);
  const port = parseObserverPort(options.port ?? "0");
  if (port === null) {
    refuseRemote(args.command, io, cwd, "--port must be an integer between 0 and 65535.");
    return;
  }
  // The launch names the run and records its owner before it first loads the provider's SDK, so
  // a missing optional peer is refused here, before anything is written.
  const sdk = await (
    args.remote.provider === "modal" ? loadModalModule() : importE2BDesktop()
  ).then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
  if (sdk !== undefined) {
    refuseRemote(args.command, io, cwd, sdk);
    return;
  }
  const keys = runnerKeys(args.remote, process.env);
  const forwarded = {
    provider: args.remote.provider,
    keys: [...keys.held, ...keys.sent].sort(),
  };
  io.writeErr(`${runnerKeysLine(args.remote.provider, keys)}\n`);
  let outcome;
  try {
    outcome = await launchRemoteRun({
      cwd,
      study: path.relative(cwd, path.resolve(cwd, args.studyPath)).split(path.sep).join("/"),
      remote: args.remote,
      env: process.env,
      port,
      say: (line) => io.writeErr(`${line}\n`),
    });
  } catch (error) {
    refuseRemote(
      args.command,
      io,
      cwd,
      error instanceof Error ? error.message : String(error),
      "HUMANISH_REMOTE_FAILED",
      forwarded,
    );
    return;
  }
  reportRemoteOutcome(args.command, io, cwd, outcome, forwarded);
}

/** The line that says, before the runner exists, where each of this machine's keys goes. */
export function runnerKeysLine(
  provider: RemotePlan["provider"],
  keys: Pick<RunnerKeys, "held" | "sent">,
): string {
  const list = (names: readonly string[]) => names.join(", ");
  const asEnv = (names: readonly string[]) =>
    names.length === 1 ? "as an environment variable" : "as environment variables";
  const local = "Run with --local to keep the study on this machine.";
  if (provider === "modal")
    return `The runner runs in your own Modal account and receives ${list(keys.sent) || "no keys"} ${asEnv(keys.sent)}, since Modal has no egress proxy that could hold them. ${local}`;
  const held =
    keys.held.length === 0
      ? ""
      : ` E2B's egress proxy holds ${list(keys.held)} and adds ${keys.held.length === 1 ? "it" : "them"} to the runner's requests, so the runner's environment holds ${keys.held.length === 1 ? "a placeholder" : "placeholders"}.`;
  const sent =
    keys.sent.length === 0 ? "" : ` The runner receives ${list(keys.sent)} ${asEnv(keys.sent)}.`;
  return `The runner runs in your own E2B account.${held}${sent} ${local}`;
}

/** The run options a remote run does not carry to the runner yet. */
function localOnlyFlags(options: StudyCommandOptions): string[] {
  return [
    options.scorer === undefined ? [] : ["--scorer"],
    options.count === undefined ? [] : ["--count"],
    options.rerunFailedFrom === undefined ? [] : ["--rerun-failed-from"],
    options.participants === undefined ? [] : ["--participants"],
    options.expose === true || options.tunnel !== undefined || options.publicUrl !== undefined
      ? ["--expose"]
      : [],
  ].flat();
}

/** The command's result and exit code for a remote run that ended, stopped or detached. */
export function reportRemoteOutcome(
  command: Command,
  io: CliIo,
  cwd: string,
  outcome: RemoteOutcome,
  forwarded?: NonNullable<RunResult["remote"]>,
): void {
  const remote = forwarded === undefined ? {} : { remote: forwarded };
  if (
    outcome.detached === true ||
    outcome.result === undefined ||
    typeof outcome.result !== "object"
  ) {
    const detached = outcome.detached === true;
    const failed: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      runId: outcome.runId,
      warnings: [],
      ...remote,
      error: detached
        ? {
            code: "HUMANISH_REMOTE_DETACHED",
            message: `The terminal closed, so run ${outcome.runId} goes on in its runner without this machine. Follow it and copy it back with humanish observe --run ${outcome.runId}, or stop it and its sandboxes with humanish reclaim --run ${outcome.runId}.`,
          }
        : {
            code: "HUMANISH_REMOTE_FAILED",
            message: `Run ${outcome.runId} ${outcome.error ?? "ended without a result"}.`,
          },
    };
    writeResult(command, io, failed, formatRunHuman);
    // A detached run exits as a hung-up local command does; it is not finished, so not 0.
    io.setExitCode(detached ? 129 : outcome.exitCode === 0 ? 2 : outcome.exitCode);
    return;
  }
  const result: RunResult = { ...(outcome.result as RunResult), cwd, ...remote };
  if (outcome.error !== undefined) result.warnings = [...(result.warnings ?? []), outcome.error];
  if (wantsJson(command)) io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (outcome.error !== undefined) io.writeErr(`warning: ${outcome.error}\n`);
    io.writeErr(
      `Run ${outcome.runId} ${result.ok && outcome.exitCode === 0 ? "passed" : "did not pass"}; its evidence (${outcome.files ?? 0} files) is in .humanish/runs/${outcome.runId}. Next: humanish review --run ${outcome.runId}\n`,
    );
  }
  io.setExitCode(outcome.exitCode);
}
