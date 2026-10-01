// The exports this minor deprecates and the next minor removes (docs/contracts/schemas.md,
// "Library options"). Each function warns once per process and then runs unchanged. Each type is
// an alias of the type it always was, and each constant has the value it always had. Internal code
// calls the original functions, so only a package caller sees a warning.

import {
  runCuaActorSession as cuaActorSession,
  type CuaActorSessionOptions,
} from "./actors/computer-use/actor.js";
import type { CuaLoopResult } from "./actors/computer-use/loop.js";
import type { AutomaticAnalysisHooks as AnalysisHooks } from "./analysis/automatic-completion.js";
import type { BrowserLabAdapterHooks as BrowserAdapterHooks } from "./lab/adapter-extension.js";
import { resolveLabDryRun as labDryRun, type LabBackend as Backend } from "./lab/plan.js";
import {
  actorResolvesToTerminal as resolvesToTerminal,
  cuaLaneCount as laneCount,
  MAX_CUA_LANES as laneCap,
  resolveSeatUrl as seatUrl,
} from "./lab/routing.js";
import type { LabConfig } from "./lab/types.js";
import {
  concurrentSharedWorldValidationReason as concurrentSharedWorldReason,
  cuaLaneValidationReason as laneRosterReason,
  externalPublicSharedWorldValidationReason as externalPublicSharedWorldReason,
  sharedWorldValidationReason as sharedWorldReason,
} from "./lab/validation.js";
import { runCuaActorLab as cuaActorLab } from "./routes/computer-use/route.js";
import type {
  CuaActorLabHooks as CuaHooks,
  CuaActorLabResult as CuaResult,
  RunCuaActorLabOptions as CuaOptions,
} from "./routes/computer-use/types.js";
import { runScriptedBrowserLab as scriptedBrowserLab } from "./routes/scripted/route.js";
import type {
  RunScriptedBrowserLabOptions as ScriptedOptions,
  ScriptedBrowserLabHooks as ScriptedHooks,
  ScriptedBrowserLabResult as ScriptedResult,
} from "./routes/scripted/types.js";
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

const PARSE_REASON = "parseLabConfig, which returns the same reason";

/** @deprecated Use `routeOf(config)` on the lab. This goes in the next minor. */
export function actorResolvesToTerminal(type: string | undefined): boolean {
  deprecated("actorResolvesToTerminal", "routeOf(config) on the lab");
  return resolvesToTerminal(type);
}

/**
 * @deprecated Use the `plan` `LabEvent` from `RunLabOptions.onEvent`, which lists every
 * participant. This goes in the next minor.
 */
export function cuaLaneCount(config: LabConfig): number {
  deprecated(
    "cuaLaneCount",
    "the plan LabEvent from RunLabOptions.onEvent, which lists every participant",
  );
  return laneCount(config);
}

/**
 * @deprecated Use `parseLabConfig`, which refuses a seat entry that is not same-origin loopback.
 * This goes in the next minor.
 */
export function resolveSeatUrl(serveUrl: string, entry: string | undefined): string | null {
  deprecated(
    "resolveSeatUrl",
    "parseLabConfig, which refuses a participant entry that is not same-origin loopback",
  );
  return seatUrl(serveUrl, entry);
}

/** @deprecated Use `parseLabConfig`, which returns the same reason. This goes in the next minor. */
export function cuaLaneValidationReason(config: LabConfig): string | null {
  deprecated("cuaLaneValidationReason", PARSE_REASON);
  return laneRosterReason(config);
}

/** @deprecated Use `parseLabConfig`, which returns the same reason. This goes in the next minor. */
export function sharedWorldValidationReason(config: LabConfig): string | null {
  deprecated("sharedWorldValidationReason", PARSE_REASON);
  return sharedWorldReason(config);
}

/** @deprecated Use `parseLabConfig`, which returns the same reason. This goes in the next minor. */
export function concurrentSharedWorldValidationReason(config: LabConfig): string | null {
  deprecated("concurrentSharedWorldValidationReason", PARSE_REASON);
  return concurrentSharedWorldReason(config);
}

/** @deprecated Use `parseLabConfig`, which returns the same reason. This goes in the next minor. */
export function externalPublicSharedWorldValidationReason(config: LabConfig): string | null {
  deprecated("externalPublicSharedWorldValidationReason", PARSE_REASON);
  return externalPublicSharedWorldReason(config);
}

/**
 * @deprecated Use `RunLabOptions.dryRun`; without it, `scenario.mode` decides. This goes in the
 * next minor.
 */
export function resolveLabDryRun(
  config: LabConfig,
  override: boolean | undefined,
  fallback: boolean | undefined,
): boolean | undefined {
  deprecated("resolveLabDryRun", "RunLabOptions.dryRun; without it, scenario.mode decides");
  return labDryRun(config, override, fallback);
}

/** @deprecated `parseLabConfig` refuses a roster larger than this. This goes in the next minor. */
export const MAX_CUA_LANES = laneCap;

/** @deprecated Use `LabRoute`. `LabOutcome.backend` and this type go in the next minor. */
export type LabBackend = Backend;

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
