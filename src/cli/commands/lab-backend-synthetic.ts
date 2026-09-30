import { Command } from "commander";
import { runLab } from "../../lab/engine.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { LabConfig } from "../../lab/types.js";
import type { RunResult } from "../../run/results.js";
import {
  type CliIo,
  formatRunHuman,
  type LabCommandOptions,
  parseLabCount,
  writeResult,
} from "../io.js";
import { planObserver, showObserver, staticObserverOpen } from "../observer-follow.js";

export async function runSyntheticBackend(args: {
  command: Command;
  io: CliIo;
  lab: string;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const simCount = parseLabCount(args.options.sims, args.config.actors[0]?.count ?? 4);
  if (simCount === null) {
    const result: RunResult = {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: args.options.cwd,
      warnings: [],
      error: {
        code: "HUMANISH_INVALID_SIM_COUNT",
        message: "--sims must be a positive integer.",
      },
    };
    writeResult(args.command, args.io, result, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  // `run` renders the Observer too, so `run` and `watch` write the same bundle and the first
  // `export` of a run bundle finds observer/index.html (#597). A render failure is a warning on the
  // result, never a failed run. The preview renders through its finished run, so the page shown is
  // the run just written, never a directory swapped in under its id.
  const openOverride = args.options.open ?? args.config.defaults?.open;
  const plan =
    args.mode === "watch"
      ? planObserver({
          command: args.command,
          cwd: args.options.cwd,
          io: args.io,
          port: args.options.port ?? "0",
          ...(args.options.detach === undefined ? {} : { detach: args.options.detach }),
          ...(openOverride === undefined ? {} : { open: openOverride }),
        })
      : undefined;
  if (plan === null) return;
  const outcome = await runLab(args.config, {
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    count: simCount,
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    open: plan === undefined ? false : staticObserverOpen(plan),
  });
  if (outcome.backend !== "synthetic") {
    throw new Error(`Expected synthetic backend, got ${outcome.backend}.`);
  }
  const runResult = outcome.result;

  if (plan === undefined) {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(runResult.ok ? 0 : 2);
    return;
  }

  if (!runResult.ok || runResult.observer === undefined) {
    writeResult(args.command, args.io, runResult, formatRunHuman);
    args.io.setExitCode(2);
    return;
  }

  await showObserver({ command: args.command, io: args.io, plan, rendered: runResult.observer });
}
