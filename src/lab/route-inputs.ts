// What each route's run takes from runLab's options: the shared run settings, the route's own
// hook bag, the automatic-analysis hooks and the declared scorer's provenance.

import type { RunLabOptions } from "../run-lab.js";
import type { RunScorerProvenance } from "../run/bundle.js";
import { HOOK_MEMBERS, withHookOverrides } from "./bag-overrides.js";
import { scorerHooks } from "./run-lab-options.js";
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

/** A scorer the CLI loads after the route's local checks, and the provenance it stamps on the run. */
export type LateScorer = Pick<RunLabOptions, "scorer" | "scorerProvenance">;

/** The computer-use input with a scorer loaded after admission (see withLateScorer). */
export function computerUseInputWithScorer(
  input: ComputerUseRunInput,
  late: LateScorer | undefined,
): ComputerUseRunInput {
  const hooks = late?.scorer === undefined ? undefined : scorerHooks(late.scorer);
  return withLateScorer(input, HOOK_MEMBERS.cua, hooks, late);
}

/** The shared-world input with a scorer loaded after admission (see withLateScorer). */
export function sharedWorldInputWithScorer(
  input: SharedWorldRunInput,
  late: LateScorer | undefined,
): SharedWorldRunInput {
  const hooks = late?.scorer === undefined ? undefined : scorerHooks(late.scorer);
  return withLateScorer(input, HOOK_MEMBERS.sharedWorld, hooks, late);
}

/** The terminal input with a scorer loaded after admission. Terminal runs take no deriveArtifacts. */
export function terminalInputWithScorer(
  input: TerminalRunInput,
  late: LateScorer | undefined,
): TerminalRunInput {
  const scorer = late?.scorer;
  const hooks =
    scorer === undefined
      ? undefined
      : {
          ...(scorer.score === undefined ? {} : { score: scorer.score }),
          ...(scorer.deriveFeedback === undefined ? {} : { deriveFeedback: scorer.deriveFeedback }),
        };
  return withLateScorer(input, HOOK_MEMBERS.terminal, hooks, late);
}

/**
 * `input` with the scorer's hooks over its hook bag, as normalizeRunLabOptions maps a scorer the
 * caller passes up front, and the scorer's provenance. The bag is wrapped, never rebuilt, so the
 * members the route's checks already read stay the same objects.
 */
function withLateScorer<I extends { hooks?: object; scorerProvenance?: RunScorerProvenance }>(
  input: I,
  declared: readonly string[],
  hooks: Partial<NonNullable<I["hooks"]>> | undefined,
  late: LateScorer | undefined,
): I {
  if (late === undefined) return input;
  return {
    ...input,
    ...(hooks === undefined
      ? {}
      : { hooks: withHookOverrides<NonNullable<I["hooks"]>>(input.hooks, declared, hooks) }),
    ...(late.scorerProvenance === undefined ? {} : { scorerProvenance: late.scorerProvenance }),
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
