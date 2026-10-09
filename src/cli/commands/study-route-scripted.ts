import { studyAnalysisSucceeded } from "../../study/automatic-analysis-plan.js";
import { Command } from "commander";
import type { StudyConfig } from "../../study/types.js";
import { cliAnalysisOptions } from "./analysis-signals.js";
import { type CliIo, type StudyCommandOptions, wantsJson, writeResult } from "../io.js";
import { writeRunFindings } from "../findings.js";
import { showObserver } from "../observer-follow.js";
import { formatScriptedStudyHuman } from "./study-format.js";
import { observerOpen, resolveRouteShouldOpen, watchFinishedPlan } from "./study-route-open.js";
import type { RouteRun } from "./study-route-run.js";

interface ScriptedRouteArgs {
  command: Command;
  io: CliIo;
  config: StudyConfig;
  mode: "run" | "watch";
  options: StudyCommandOptions;
}

/**
 * The scripted route's CLI setup: its open semantics and runStudyWith options, and how it presents the
 * outcome. Undefined when watch-mode setup has already written its own result.
 */
export function scriptedRouteRun(args: ScriptedRouteArgs): RouteRun | undefined {
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
      open: observerOpen(args.mode, finishedPlan, shouldOpen),
      ...(args.options.dryRun === undefined ? {} : { dryRun: args.options.dryRun }),
      ...(args.options.runId === undefined ? {} : { runId: args.options.runId }),
    },
    present: async (outcome) => {
      if (outcome.route !== "scripted") {
        throw new Error(`Expected the scripted route, got ${outcome.route}.`);
      }
      const result = outcome.result;
      writeResult(args.command, args.io, result, (value) =>
        formatScriptedStudyHuman(value, args.config.subject),
      );
      args.io.setExitCode(result.ok && studyAnalysisSucceeded(result) ? 0 : 2);
      await writeRunFindings(args.command, args.io, args.options.cwd, result);

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
