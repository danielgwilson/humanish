// The exports this minor deprecates and the next minor removes (docs/contracts/schemas.md,
// "Library options"). Each function warns once per process and then runs unchanged. Each type is
// an alias of the type it always was.

import {
  runCuaActorSession as cuaActorSession,
  type CuaActorSessionOptions,
} from "./actors/computer-use/actor.js";
import type { CuaLoopResult } from "./actors/computer-use/loop.js";
import type { AutomaticAnalysisHooks as AnalysisHooks } from "./analysis/automatic-completion.js";
import type { BrowserLabAdapterHooks as BrowserAdapterHooks } from "./lab/adapter-extension.js";
import { runCuaActorLab as cuaActorLab } from "./routes/computer-use/route.js";
import type {
  CuaActorLabHooks as CuaHooks,
  CuaActorLabResult as CuaResult,
  RunCuaActorLabOptions as CuaOptions,
} from "./routes/computer-use/types.js";
import { runScriptedBrowserLab as scriptedBrowserLab } from "./routes/scripted-browser/route.js";
import type {
  RunScriptedBrowserLabOptions as ScriptedOptions,
  ScriptedBrowserLabHooks as ScriptedHooks,
  ScriptedBrowserLabResult as ScriptedResult,
} from "./routes/scripted-browser/types.js";
import { runConcurrentSharedWorld as concurrentSharedWorld } from "./routes/shared-world/route.js";
import type {
  ConcurrentSharedWorldLabResult as SharedWorldResult,
  RunConcurrentSharedWorldLabOptions as SharedWorldOptions,
  SharedWorldLabHooks as SharedWorldHooks,
} from "./routes/shared-world/types.js";
import { runTerminalProductLab as terminalProductLab } from "./routes/terminal/route.js";
import type {
  RunTerminalProductLabOptions as TerminalOptions,
  TerminalProductLabHooks as TerminalHooks,
  TerminalProductLabResult as TerminalResult,
} from "./routes/terminal/types.js";
import { runDryRun as dryRun } from "./run/dry-run.js";
import type { RunOptions as PreviewOptions, RunResult as PreviewResult } from "./run/results.js";
import type { SubjectPhaseEvent as PhaseEvent } from "./subject/steps.js";

const warned = new Set<string>();

function deprecated(name: string, replacement: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  process.emitWarning(
    `${name} is deprecated and is removed in the next minor. Use ${replacement}.`,
    { type: "DeprecationWarning", code: "HUMANISH_DEPRECATED_EXPORT" },
  );
}

const RUN_LAB = "runLab(config, options); its result is LabResult<route>";

/**
 * @deprecated Use `runComputerUseLoop` with `createOpenAiResponsesProvider({ singleDispatch: true })`,
 * the strict-spend composition in docs/contracts/schemas.md.
 */
export function runCuaActorSession(options: CuaActorSessionOptions): Promise<CuaLoopResult> {
  deprecated(
    "runCuaActorSession",
    "runComputerUseLoop with createOpenAiResponsesProvider({ singleDispatch: true }) (the strict-spend composition in docs/contracts/schemas.md)",
  );
  return cuaActorSession(options);
}

/** @deprecated Use `runLab(config, options)`; its result is `LabResult<"computer-use">`. */
export function runCuaActorLab(options: CuaOptions): Promise<CuaResult> {
  deprecated("runCuaActorLab", RUN_LAB);
  return cuaActorLab(options);
}

/** @deprecated Use `runLab(config, options)`; its result is `LabResult<"scripted">`. */
export function runScriptedBrowserLab(options: ScriptedOptions): Promise<ScriptedResult> {
  deprecated("runScriptedBrowserLab", RUN_LAB);
  return scriptedBrowserLab(options);
}

/** @deprecated Use `runLab(config, options)`; its result is `LabResult<"terminal">`. */
export function runTerminalProductLab(options: TerminalOptions): Promise<TerminalResult> {
  deprecated("runTerminalProductLab", RUN_LAB);
  return terminalProductLab(options);
}

/** @deprecated Use `runLab(config, options)`; its result is `LabResult<"shared-world">`. */
export function runConcurrentSharedWorld(options: SharedWorldOptions): Promise<SharedWorldResult> {
  deprecated("runConcurrentSharedWorld", RUN_LAB);
  return concurrentSharedWorld(options);
}

/** @deprecated Use `runLab(config, options)` on a `this-repo` lab; its result is `LabResult<"preview">`. */
export function runDryRun(options: PreviewOptions): Promise<PreviewResult> {
  deprecated("runDryRun", RUN_LAB);
  return dryRun(options);
}

/** @deprecated Use `RunLabOptions` with `runLab`. */
export type RunCuaActorLabOptions = CuaOptions;
/** @deprecated Use `LabResult<"computer-use">`. */
export type CuaActorLabResult = CuaResult;
/** @deprecated Use `RunLabOptions` with `runLab`. */
export type RunScriptedBrowserLabOptions = ScriptedOptions;
/** @deprecated Use `LabResult<"scripted">`. */
export type ScriptedBrowserLabResult = ScriptedResult;
/** @deprecated Use `RunLabOptions` with `runLab`. */
export type RunTerminalProductLabOptions = TerminalOptions;
/** @deprecated Use `LabResult<"terminal">`. */
export type TerminalProductLabResult = TerminalResult;
/** @deprecated Use `RunLabOptions` with `runLab`. */
export type RunConcurrentSharedWorldLabOptions = SharedWorldOptions;
/** @deprecated Use `LabResult<"shared-world">`. */
export type ConcurrentSharedWorldLabResult = SharedWorldResult;
/** @deprecated Use `RunLabOptions` with `runLab`. */
export type RunOptions = PreviewOptions;
/** @deprecated Use `LabResult<"preview">`. */
export type RunResult = PreviewResult;

/** @deprecated Use the typed homes on `RunLabOptions` (`scorer`, `createProvider`, `inProcess`, `prepareDesktop`, `env`, `onEvent`, `onStream`). */
export type CuaActorLabHooks = CuaHooks;
/** @deprecated Use the typed homes on `RunLabOptions` (`prepareDesktop`, `env`). */
export type ScriptedBrowserLabHooks = ScriptedHooks;
/** @deprecated Use the typed homes on `RunLabOptions` (`scorer`, `env`). */
export type TerminalProductLabHooks = TerminalHooks;
/** @deprecated Use the typed homes on `RunLabOptions` (`scorer`, `prepareDesktop`, `env`, `onEvent`, `onStream`). */
export type SharedWorldLabHooks = SharedWorldHooks;
/** @deprecated Use `RunLabOptions.scorer`, an `AdapterScorerModule`. */
export type BrowserLabAdapterHooks = BrowserAdapterHooks;
/** @deprecated Use the `subject-phase` `LabEvent` through `RunLabOptions.onEvent`. */
export type SubjectPhaseEvent = PhaseEvent;
/** @deprecated Use `RunLabOptions.onEvent` (`analysis-started`, `analysis-finished`) and `analysisSignal`. */
export type AutomaticAnalysisHooks = AnalysisHooks;
