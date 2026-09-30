import { automaticAnalysisSucceeded } from "../../analysis/automatic-completion.js";
import { Command } from "commander";
import { runLab } from "../../lab/engine.js";
import type { RunLabProvenance } from "../../run/status.js";
import type { LabConfig } from "../../lab/types.js";
import { cliAnalysisOptions, type LoadedAdapterScorer } from "./lab-hooks.js";
import { type CliIo, type LabCommandOptions, wantsJson, writeResult } from "../io.js";
import { showObserver } from "../observer-follow.js";
import { formatTerminalLabHuman } from "./lab-format.js";
import { observerOpen, resolveBackendShouldOpen, watchFinishedPlan } from "./lab-backend-open.js";
import type { BackendRun } from "./lab-backend-run.js";

interface TerminalBackendArgs {
  command: Command;
  io: CliIo;
  config: LabConfig;
  labProvenance?: RunLabProvenance;
  mode: "run" | "watch";
  options: LabCommandOptions;
  scorer?: LoadedAdapterScorer;
}

// Mirror of runCuaBackend/runScriptedBackend: open semantics from defaults.open/--no-open/watch,
// writeResult with the terminal human formatter, exit code result.ok ? 0 : 2, watch-mode follow.
export async function runTerminalBackend(args: TerminalBackendArgs): Promise<void> {
  const run = terminalBackendRun(args);
  if (run === undefined) return;
  await run.present(await runLab(args.config, run.options));
}

/**
 * The terminal backend's setup: its open semantics and runLab options, and how it presents the
 * outcome. Undefined when watch-mode setup has already written its own result.
 */
function terminalBackendRun(args: TerminalBackendArgs): BackendRun | undefined {
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
      ...(args.scorer
        ? {
            scorer: args.scorer.hooks,
            scorerProvenance: args.scorer.provenance,
          }
        : {}),
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
