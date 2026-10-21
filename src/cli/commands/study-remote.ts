// `--remote` on run and watch: plan here, refuse what cannot run remotely, then launch and follow
// the run in a runner sandbox (src/remote/launch.ts). The result and exit code are the run's own.
import path from "node:path";

import type { Command } from "commander";

import { launchRemoteRun } from "../../remote/launch.js";
import { planRemoteRun } from "../../remote/plan.js";
import type { RunResult } from "../../run/results.js";
import { planStudy } from "../../study/plan.js";
import type { StudyConfig } from "../../study/types.js";
import { concurrentSandboxes, sandboxCeiling } from "../../substrates/e2b/lifetime.js";
import { MODAL_MAX_SANDBOX_MS } from "../../substrates/modal/sdk.js";
import {
  type CliIo,
  formatRunHuman,
  parseObserverPort,
  type StudyCommandOptions,
  wantsJson,
  writeResult,
} from "../io.js";

type RemoteErrorCode = "HUMANISH_REMOTE_REFUSED" | "HUMANISH_REMOTE_FAILED";

export async function runRemoteStudy(args: {
  command: Command;
  io: CliIo;
  options: StudyCommandOptions;
  config: StudyConfig;
  studyPath: string;
}): Promise<void> {
  const { io, options, config } = args;
  const cwd = path.resolve(options.cwd);
  const refuse = (code: RemoteErrorCode, message: string, runId?: string): void => {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd,
      ...(runId === undefined ? {} : { runId }),
      warnings: [],
      error: { code, message },
    };
    writeResult(args.command, io, result, formatRunHuman);
    io.setExitCode(2);
  };
  if (options.dryRun === true) {
    refuse("HUMANISH_REMOTE_REFUSED", "--remote runs live studies; a dry run needs no runner.");
    return;
  }
  const local = localOnlyFlags(options);
  if (local.length > 0) {
    refuse(
      "HUMANISH_REMOTE_REFUSED",
      `${local.join(", ")} ${local.length === 1 ? "does" : "do"} not run remotely yet; run without --remote to use ${local.length === 1 ? "it" : "them"}.`,
    );
    return;
  }
  const planned = planStudy(config, { cwd, dryRun: false });
  if (!planned.ok) {
    refuse("HUMANISH_REMOTE_REFUSED", planned.refusal.message);
    return;
  }
  const plan = planned.planned.plan;
  const e2bCeiling = sandboxCeiling(process.env);
  const provider =
    plan.route === "computer-use" && plan.runner.desktop === "e2b-desktop"
      ? plan.runner.provider
      : "e2b";
  const ceilingMs = provider === "modal" ? MODAL_MAX_SANDBOX_MS : e2bCeiling.ok ? e2bCeiling.ms : 0;
  const sandboxes = concurrentSandboxes(process.env);
  const remote = planRemoteRun({
    config,
    plan,
    cwd,
    studyPath: args.studyPath,
    ceilingMs,
    concurrentSandboxes: sandboxes.ok ? sandboxes.count : 1,
  });
  if (!remote.ok) {
    refuse("HUMANISH_REMOTE_REFUSED", `This study cannot run remotely: ${remote.reason}`);
    return;
  }
  const port = parseObserverPort(options.port ?? "0");
  if (port === null) {
    refuse("HUMANISH_REMOTE_REFUSED", "--port must be an integer between 0 and 65535.");
    return;
  }

  let outcome;
  try {
    outcome = await launchRemoteRun({
      cwd,
      study: path.relative(cwd, path.resolve(cwd, args.studyPath)).split(path.sep).join("/"),
      remote: remote.plan,
      env: process.env,
      port,
      say: (line) => io.writeErr(`${line}\n`),
    });
  } catch (error) {
    refuse("HUMANISH_REMOTE_FAILED", error instanceof Error ? error.message : String(error));
    return;
  }
  if (outcome.detached === true) {
    io.writeErr(
      `The terminal closed, so run ${outcome.runId} goes on in its runner without this machine. Stop it and its sandboxes with: humanish reclaim --run ${outcome.runId}\n`,
    );
    return;
  }
  if (outcome.result === undefined || typeof outcome.result !== "object") {
    refuse(
      "HUMANISH_REMOTE_FAILED",
      `Run ${outcome.runId} ${outcome.error ?? "ended without a result"}.`,
      outcome.runId,
    );
    io.setExitCode(outcome.exitCode === 0 ? 2 : outcome.exitCode);
    return;
  }
  const result = { ...(outcome.result as RunResult), cwd };
  if (outcome.error !== undefined) result.warnings = [...(result.warnings ?? []), outcome.error];
  if (wantsJson(args.command)) io.writeOut(`${JSON.stringify(result, null, 2)}\n`);
  else {
    if (outcome.error !== undefined) io.writeErr(`warning: ${outcome.error}\n`);
    io.writeErr(
      `Run ${outcome.runId} ${result.ok && outcome.exitCode === 0 ? "passed" : "did not pass"}; its evidence (${outcome.files ?? 0} files) is in .humanish/runs/${outcome.runId}. Next: humanish review --run ${outcome.runId}\n`,
    );
  }
  io.setExitCode(outcome.exitCode);
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
