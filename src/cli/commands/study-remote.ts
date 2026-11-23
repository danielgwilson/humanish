// `--remote` on run and watch: plan here, refuse what cannot run remotely, then launch and follow
// the run in a runner sandbox (src/remote/launch.ts). The result and exit code are the run's own.
import path from "node:path";
import { pathToFileURL } from "node:url";

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
import type { CuaActorStudyResult } from "../../routes/computer-use/types.js";
import type { TerminalProductStudyResult } from "../../routes/terminal/types.js";
import { RUN_BUNDLE_FILE } from "../../run/bundle.js";
import { openContainedRegularFile } from "../../run/contained-output.js";
import { bindExistingRunArtifactPaths } from "../../run/paths.js";
import type { RunResult } from "../../run/results.js";
import type { RunStudyProvenance } from "../../run/study-provenance.js";
import { plural } from "../../run/text.js";
import { isRecord } from "../../run/type-guards.js";
import { planStudy, resolveStudyDryRun } from "../../study/plan.js";
import type { StudyConfig, StudySubject } from "../../study/types.js";
import { concurrentSandboxes, sandboxCeiling } from "../../substrates/e2b/lifetime.js";
import { importE2BDesktop } from "../../substrates/e2b/sdk.js";
import { loadModalModule, MODAL_MAX_SANDBOX_MS } from "../../substrates/modal/sdk.js";
import {
  analysisOutcomeText,
  type CliIo,
  formatRunHuman,
  type HumanOutput,
  markInvocationEnvelopeWritten,
  parseObserverPort,
  type ResultOptions,
  type StudyCommandOptions,
  wantsJson,
  writeResult,
} from "../io.js";
import { cli } from "../invocation.js";
import { OBSERVER_SERVER_WARNING } from "../observer-follow.js";
import { cwdFlag } from "../findings.js";
import { readRunReport, type RunReport, writeRunReport } from "../run-findings.js";
import { formatCuaStudyHuman, formatTerminalStudyHuman } from "./study-format.js";
import { LIVE_SERVER_WARNING } from "./study-route-computer-use.js";

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
  /** Which study the run comes from, as a local run records it in its status record. */
  study: RunStudyProvenance;
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
      provenance: args.study,
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
  await reportRemoteOutcome(args.command, io, cwd, outcome, forwarded);
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

/**
 * The command's result and exit code for a remote run that ended, stopped or detached. A run that
 * ended is written as a local run of its route writes it.
 */
export async function reportRemoteOutcome(
  command: Command,
  io: CliIo,
  cwd: string,
  outcome: RemoteOutcome,
  forwarded?: NonNullable<RunResult["remote"]>,
  options: ResultOptions = {},
): Promise<void> {
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
  if (!readableRunResult(outcome.result, outcome.runId)) {
    reportUnreadResult(command, io, cwd, outcome, remote);
    io.setExitCode(outcome.exitCode);
    return;
  }
  const copied = outcome.files !== undefined;
  const result: RouteResult = { ...onThisMachine(outcome.result, cwd, copied), ...remote };
  if (outcome.error !== undefined) result.warnings = [...result.warnings, outcome.error];
  if (!copied && outcome.error !== undefined)
    writeRunReport(
      command,
      io,
      result,
      formatRouteResult,
      unfinishedCopyReport(result, cwd),
      options,
    );
  else if (await publishedHere(cwd, result.runId))
    // The run directory was copied here, so the findings are read from this machine's copy.
    writeRunReport(
      command,
      io,
      result,
      formatRouteResult,
      await readRunReport(cwd, result),
      options,
    );
  // A run the runner refused, or one that ended before it published, has nothing here to analyze,
  // so it ends as a local run refused before it was created does: on its own lines and error.
  else writeResult(command, io, result, formatRouteResult, [], options);
  // The route's lines say how the run ended and the analysis lines what to run next; only where
  // its evidence landed is left to say. A copy that failed counted no files, and its warning says so.
  if (!wantsJson(command) && copied)
    io.writeErr(
      `Run ${outcome.runId}'s evidence (${plural(outcome.files ?? 0, "file")}) is in .humanish/runs/${outcome.runId}.\n`,
    );
  io.setExitCode(outcome.exitCode);
}

/**
 * The subject the computer-use lines name when a result has no app URL. Only an app-url study runs
 * remotely on that route (planRemoteRun), and its result carries the URL from admission on, so
 * this needs no study file, which `observe --run` does not have.
 */
const REMOTE_SUBJECT: StudySubject = { source: "app-url" };

/** A runner's result in its route's own lines, as a local run of that route prints them. */
function formatRouteResult(result: RouteResult): HumanOutput {
  return result.route === "terminal"
    ? formatTerminalStudyHuman(result)
    : formatCuaStudyHuman(result, REMOTE_SUBJECT);
}

/**
 * The end of the output for a run whose copy back failed: what arrived may lack the analysis or
 * the files it cites, so none of it is read, and the command that finishes the copy comes next.
 * The launcher reclaims the runner after such a copy, so that command also says what was lost.
 */
function unfinishedCopyReport(result: RouteResult, cwd: string): RunReport {
  const next = cli(`observe --run ${result.runId}${cwdFlag(cwd)}`);
  const message = `The run's evidence did not all arrive here, so what its analysis left is not read. ${next} finishes the copy while the runner is still there, and records what was lost when it is not.`;
  const analysis = result.automaticAnalysis;
  return {
    message,
    nextCommand: next,
    lines: [
      ...(analysis === undefined
        ? []
        : [`analysis: ${analysisOutcomeText(analysis)}`, `analysis: ${message}`]),
      `next: ${next}`,
    ],
  };
}

/** Whether this machine's copy of run `runId` holds the run.json a run writes as it publishes. */
async function publishedHere(cwd: string, runId: string): Promise<boolean> {
  const paths = await bindExistingRunArtifactPaths(cwd, runId).catch(() => undefined);
  const bundle =
    paths === undefined
      ? null
      : await openContainedRegularFile(paths, RUN_BUNDLE_FILE).catch(() => null);
  await bundle?.close();
  return bundle !== null;
}

/** The result a runner's route wrote: only the computer-use and terminal routes run remotely. */
type RouteResult = (CuaActorStudyResult | TerminalProductStudyResult) & {
  remote?: NonNullable<RunResult["remote"]>;
};

/**
 * Whether a runner's result is run `runId`'s route result, with the fields the run writer and the
 * route's lines read typed as this humanish writes them. The file crosses a process and can come
 * from another humanish version, such as a run followed again after an upgrade.
 */
function readableRunResult(value: unknown, runId: string): value is RouteResult {
  if (!isRecord(value)) return false;
  const { observer, automaticAnalysis: analysis } = value;
  const absentOr = (field: unknown, readable: (field: unknown) => boolean) =>
    field === undefined || readable(field);
  return (
    (value.route === "computer-use" || value.route === "terminal") &&
    value.runId === runId &&
    typeof value.studyId === "string" &&
    typeof value.ok === "boolean" &&
    Array.isArray(value.warnings) &&
    // The participant list, by the result's contract spelling.
    absentOr(value["lanes"], Array.isArray) &&
    absentOr(
      observer,
      () =>
        isRecord(observer) &&
        Array.isArray(observer.warnings) &&
        absentOr(observer.observerPath, (path) => typeof path === "string"),
    ) &&
    absentOr(
      analysis,
      () =>
        isRecord(analysis) &&
        typeof analysis.state === "string" &&
        absentOr(
          analysis.result,
          (result) => isRecord(result) && absentOr(result.warnings, Array.isArray),
        ),
    )
  );
}

/**
 * A runner's result that readableRunResult refuses, printed as the runner wrote it, with this
 * machine's directory and a warning that says why it has no findings or route lines.
 */
function reportUnreadResult(
  command: Command,
  io: CliIo,
  cwd: string,
  outcome: RemoteOutcome,
  remote: { remote?: NonNullable<RunResult["remote"]> },
): void {
  const unread = `The runner's result for run ${outcome.runId} could not be read as a run result, so it is shown as the runner wrote it.`;
  const written = isRecord(outcome.result) ? outcome.result : {};
  const document: Record<string, unknown> = { ...written, cwd, ...remote };
  document.warnings = [
    ...(Array.isArray(written.warnings) ? written.warnings : []),
    ...(outcome.error === undefined ? [] : [outcome.error]),
    unread,
  ];
  if (wantsJson(command)) io.writeOut(`${JSON.stringify(document, null, 2)}\n`);
  else {
    for (const warning of [unread, ...(outcome.error === undefined ? [] : [outcome.error])])
      io.writeErr(`warning: ${warning}\n`);
    io.writeErr(
      `Run ${outcome.runId} ${written.ok === true && outcome.exitCode === 0 ? "passed" : "did not pass"}; its evidence (${plural(outcome.files ?? 0, "file")}) is in .humanish/runs/${outcome.runId}. Next: ${cli(`review --run ${outcome.runId}`)}\n`,
    );
  }
  markInvocationEnvelopeWritten(command);
}

/**
 * The runner's result as it reads for this machine's copy of the run. The run directory arrives
 * here under the same project-relative path, so the relative paths hold. The runner's project
 * directory does not, nor the Observer address it gave: a file URL on the runner's disk, or the
 * server a computer-use run serves there, which stopped with the runner. So the address names this
 * machine's copy of the page once the copy finished, and the two warnings about that server go.
 * A rejected analysis output is kept outside the run directory, so it is not copied and goes with
 * the runner.
 */
function onThisMachine(result: RouteResult, cwd: string, copied: boolean): RouteResult {
  const here: RouteResult = {
    ...result,
    cwd,
    warnings: result.warnings.filter((warning) => warning !== LIVE_SERVER_WARNING),
  };
  const analysis = result.automaticAnalysis;
  if (analysis?.result?.rejectedOutputPath !== undefined) {
    const { rejectedOutputPath: _notCopied, ...analyzed } = analysis.result;
    here.automaticAnalysis = { ...analysis, result: analyzed };
  }
  if (result.observer !== undefined) {
    const { serverUrl: _stopped, ...observer } = result.observer;
    here.observer = {
      ...observer,
      cwd,
      warnings: observer.warnings.filter((warning) => warning !== OBSERVER_SERVER_WARNING),
    };
    // Before the copy finished, the page may not be here.
    if (copied && observer.observerPath !== undefined)
      here.observer.observerUrl = pathToFileURL(path.join(cwd, observer.observerPath)).href;
    else delete here.observer.observerUrl;
  }
  return here;
}
