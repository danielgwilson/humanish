// What each route's run takes from runLab's options: the shared run settings, the route's own
// hook bag, the automatic-analysis hooks and the declared scorer's provenance.

import type { RunLabOptions } from "../run-lab.js";
import type { ComputerUseRunInput } from "../routes/computer-use/types.js";
import type { ScriptedRunInput } from "../routes/scripted/types.js";
import type { SharedWorldRunInput } from "../routes/shared-world/types.js";
import type { TerminalRunInput } from "../routes/terminal/types.js";

export function computerUseInput(options: RunLabOptions): ComputerUseRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    // CLI --count overrides the homogeneous fan-out lane count (a declared roster's length wins).
    ...(options.count === undefined ? {} : { countOverride: options.count }),
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.onObserverReady === undefined ? {} : { onObserverReady: options.onObserverReady }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
    ...(options.cuaHooks === undefined ? {} : { hooks: options.cuaHooks }),
    ...scorerOf(options),
  };
}

export function scriptedInput(options: RunLabOptions): ScriptedRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.scriptedHooks === undefined ? {} : { hooks: options.scriptedHooks }),
  };
}

export function terminalInput(options: RunLabOptions): TerminalRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.terminalHooks === undefined ? {} : { hooks: options.terminalHooks }),
    ...scorerOf(options),
  };
}

export function sharedWorldInput(options: RunLabOptions): SharedWorldRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.onObserverReady === undefined ? {} : { onObserverReady: options.onObserverReady }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.sharedWorldHooks === undefined ? {} : { hooks: options.sharedWorldHooks }),
    ...scorerOf(options),
  };
}

function analysisOf(options: RunLabOptions) {
  return options.automaticAnalysis === undefined
    ? {}
    : { automaticAnalysis: options.automaticAnalysis };
}

function scorerOf(options: RunLabOptions) {
  return options.scorerProvenance === undefined
    ? {}
    : { scorerProvenance: options.scorerProvenance };
}
