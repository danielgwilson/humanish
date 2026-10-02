// What each route's run takes from runLab's options: the shared run settings, the typed options
// the route reads, the automatic-analysis hooks and the declared scorer's provenance.

import type { InternalRunLabOptions } from "../run-lab.js";
import type { RunScorerProvenance } from "../run/bundle.js";
import {
  browserRouteScorer,
  terminalRouteScorer,
  type AdapterScorerModule,
} from "./adapter-scorer-loader.js";
import type { LabDeps } from "./lab-deps.js";
import type { LabEvent } from "./run-lab-events.js";
import type { ComputerUseRunInput } from "../routes/computer-use/types.js";
import type { ScriptedRunInput } from "../routes/scripted/types.js";
import type { SharedWorldRunInput } from "../routes/shared-world/types.js";
import type { TerminalRunInput } from "../routes/terminal/types.js";

export function computerUseInput(
  options: InternalRunLabOptions,
  deps: LabDeps,
  emit: LabEmit | undefined,
): ComputerUseRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    // CLI --count overrides the homogeneous fan-out participant count (a declared roster's length wins).
    ...(options.count === undefined ? {} : { countOverride: options.count }),
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.onObserverReady === undefined ? {} : { onObserverReady: options.onObserverReady }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.prepareDesktop === undefined ? {} : { prepareDesktop: options.prepareDesktop }),
    ...(options.createProvider === undefined ? {} : { createProvider: options.createProvider }),
    ...(options.inProcess === undefined ? {} : { inProcess: options.inProcess }),
    ...(options.localVm === undefined ? {} : { localVm: options.localVm }),
    ...observersOf(options, emit),
    deps,
    ...scorerOf(options, browserRouteScorer),
  };
}

export function scriptedInput(options: InternalRunLabOptions, deps: LabDeps): ScriptedRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.prepareDesktop === undefined ? {} : { prepareDesktop: options.prepareDesktop }),
    deps,
  };
}

export function terminalInput(options: InternalRunLabOptions, deps: LabDeps): TerminalRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.env === undefined ? {} : { env: options.env }),
    deps,
    ...scorerOf(options, terminalRouteScorer),
  };
}

export function sharedWorldInput(
  options: InternalRunLabOptions,
  deps: LabDeps,
  emit: LabEmit | undefined,
): SharedWorldRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.onObserverReady === undefined ? {} : { onObserverReady: options.onObserverReady }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.prepareDesktop === undefined ? {} : { prepareDesktop: options.prepareDesktop }),
    ...observersOf(options, emit),
    deps,
    ...scorerOf(options, browserRouteScorer),
  };
}

/** A scorer the CLI loads after the route's local checks, and the provenance it stamps on the run. */
export type LateScorer = Pick<InternalRunLabOptions, "scorer" | "scorerProvenance">;

/** Narrows RunLabOptions.scorer to the context the route passes (adapter-scorer-loader.ts). */
type NarrowScorer<S> = (scorer: AdapterScorerModule) => S;

/**
 * A route's input with a scorer loaded after admission, and the scorer's provenance, as if the
 * caller had passed them up front. The rest of the input is the one the route's checks admitted.
 */
export function withLateScorer<S, I extends { scorer?: S; scorerProvenance?: RunScorerProvenance }>(
  input: I,
  late: LateScorer | undefined,
  narrow: NarrowScorer<S>,
): I {
  if (late === undefined) return input;
  return {
    ...input,
    ...(late.scorer === undefined ? {} : { scorer: narrow(late.scorer) }),
    ...(late.scorerProvenance === undefined ? {} : { scorerProvenance: late.scorerProvenance }),
  };
}

/** Reports a LabEvent to onEvent without waiting (normalizeRunLabOptions builds it). */
type LabEmit = (event: LabEvent) => void;

/** The caller's stream callback and the run's event emitter, for the routes that report them. */
function observersOf(options: InternalRunLabOptions, emit: LabEmit | undefined) {
  return {
    ...(options.onStream === undefined ? {} : { onStream: options.onStream }),
    ...(emit === undefined ? {} : { emit }),
  };
}

function analysisOf(options: InternalRunLabOptions) {
  return options.automaticAnalysis === undefined
    ? {}
    : { automaticAnalysis: options.automaticAnalysis };
}

function scorerOf<S>(options: InternalRunLabOptions, narrow: NarrowScorer<S>) {
  return {
    ...(options.scorer === undefined ? {} : { scorer: narrow(options.scorer) }),
    ...(options.scorerProvenance === undefined
      ? {}
      : { scorerProvenance: options.scorerProvenance }),
  };
}
