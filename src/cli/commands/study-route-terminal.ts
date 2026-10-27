import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import type { StudyConfig } from "../../study/types.js";
import { cliRunEventOptions } from "./analysis-signals.js";
import { type CliIo, type StudyCommandOptions, wantsJson } from "../io.js";
import { writeResultFile, writeRunResult } from "../run-findings.js";
import { showObserver } from "../observer-follow.js";
import { formatTerminalStudyHuman } from "./study-format.js";
import { observerOpen, resolveRouteShouldOpen, watchFinishedPlan } from "./study-route-open.js";
import type { RouteRun } from "./study-route-run.js";

interface TerminalRouteArgs {
  command: Command;
  io: CliIo;
  config: StudyConfig;
  mode: "run" | "watch";
  options: StudyCommandOptions;
}

/**
 * The terminal route's CLI setup: its open semantics and runStudyWith options, and how it presents the
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
      ...cliRunEventOptions(args.io, { json: wantsJson(args.command) }),
      cwd: args.options.cwd,
      open: observerOpen(args.mode, finishedPlan, shouldOpen),
      ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
      ...(args.options.ownerKey === undefined ? {} : { ownerKey: args.options.ownerKey }),
    },
    present: async (outcome) => {
      if (outcome.route !== "terminal") {
        throw new Error(`Expected the terminal route, got ${outcome.route}.`);
      }
      const result = outcome.result;
      await writeRunResult(
        args.command,
        args.io,
        args.options.cwd,
        result,
        formatTerminalStudyHuman,
      );
      const exitCode = result.ok && automaticAnalysisSucceeded(result) ? 0 : 2;
      args.io.setExitCode(exitCode);
      // A remote run's launcher waits for this file, while this process may go on serving.
      if (args.options.resultFile !== undefined)
        await writeResultFile(args.options.resultFile, { exitCode, result });

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
