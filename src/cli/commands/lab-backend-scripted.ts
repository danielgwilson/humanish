import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import { runLab } from "../../lab/engine.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { LabConfig } from "../../lab/types.js";
import { cliAnalysisOptions } from "./lab-hooks.js";
import { type CliIo, type LabCommandOptions, wantsJson, writeResult } from "../io.js";
import { showObserver } from "../observer-follow.js";
import { formatScriptedLabHuman } from "./lab-format.js";
import { observerOpen, resolveBackendShouldOpen, watchFinishedPlan } from "./lab-backend-open.js";

// Mirror of runCuaBackend: open semantics from defaults.open/--no-open/watch-mode, writeResult
// with the scripted human formatter, exit code result.ok ? 0 : 2, watch-mode Observer follow.
export async function runScriptedBackend(args: {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}): Promise<void> {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine,
  });
  const finishedPlan = watchFinishedPlan(args, wantsMachine, shouldOpen);
  if (finishedPlan === null) return;

  const outcome = await runLab(args.config, {
    ...cliAnalysisOptions(args.io),
    cwd: args.options.cwd,
    ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
    open: observerOpen(args.mode, finishedPlan, shouldOpen),
    ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
    ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
  });
  if (outcome.backend !== "scripted") {
    throw new Error(`Expected scripted backend, got ${outcome.backend}.`);
  }
  const result = outcome.result;
  writeResult(args.command, args.io, result, formatScriptedLabHuman);
  args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

  // Watch mode serves the Observer the route rendered through its finished run.
  if (finishedPlan !== undefined && result.ok && result.observer !== undefined) {
    await showObserver({
      command: args.command,
      io: args.io,
      plan: finishedPlan,
      rendered: result.observer,
    });
  }
}
