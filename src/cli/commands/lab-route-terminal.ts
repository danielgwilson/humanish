import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import type { RunLabProvenance } from "../../run/status.js";
import type { LabConfig } from "../../lab/types.js";
import { cliAnalysisOptions } from "./lab-hooks.js";
import { type CliIo, type LabCommandOptions, wantsJson, writeResult } from "../io.js";
import { showObserver } from "../observer-follow.js";
import { formatTerminalLabHuman } from "./lab-format.js";
import { observerOpen, resolveRouteShouldOpen, watchFinishedPlan } from "./lab-route-open.js";
import type { RouteRun } from "./lab-route-run.js";

interface TerminalRouteArgs {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
}

/**
 * The terminal route's CLI setup: its open semantics and runLab options, and how it presents the
 * outcome. Undefined when watch-mode setup has already written its own result.
 */
export function terminalRouteRun(args: TerminalRouteArgs): RouteRun | undefined {
  const wantsMachine = wantsJson(args.command);
  const shouldOpen = resolveRouteShouldOpen({
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
      if (outcome.backend !== "terminal") {
        throw new Error(`Expected terminal backend, got ${outcome.backend}.`);
      }
      const result = outcome.result;
      writeResult(args.command, args.io, result, formatTerminalLabHuman);
      args.io.setExitCode(result.ok && automaticAnalysisSucceeded(result) ? 0 : 2);

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
