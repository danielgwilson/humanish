import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import type { RunLabProvenance } from "../../run/status.js";
import type { LabConfig } from "../../lab/types.js";
import { cliAnalysisOptions } from "./lab-hooks.js";
import { type CliIo, type LabCommandOptions, wantsJson, writeResult } from "../io.js";
import { showObserver } from "../observer-follow.js";
import { formatScriptedLabHuman } from "./lab-format.js";
import { observerOpen, resolveBackendShouldOpen, watchFinishedPlan } from "./lab-backend-open.js";
import type { BackendRun } from "./lab-backend-run.js";

interface ScriptedBackendArgs {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}

/**
 * The scripted backend's setup: its open semantics and runLab options, and how it presents the
 * outcome. Undefined when watch-mode setup has already written its own result.
 */
export function scriptedBackendRun(args: ScriptedBackendArgs): BackendRun | undefined {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveBackendShouldOpen({
    optionOpen: args.options.open,
    defaultsOpen: args.config.defaults?.open,
    mode: args.mode,
    wantsMachine,
  });
  const finishedPlan = watchFinishedPlan(args, wantsMachine, shouldOpen);
  if (finishedPlan === null) return undefined;

  return {
    options: {
      ...cliAnalysisOptions(args.io),
      cwd: args.options.cwd,
      ...(args.labProvenance === undefined ? {} : { lab: args.labProvenance }),
      open: observerOpen(args.mode, finishedPlan, shouldOpen),
      ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    },
    present: async (outcome) => {
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
    },
  };
}
