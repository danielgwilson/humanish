import { isLocalBrowserLab, localBrowserDefaults } from "../substrates/local/runtime-config.js";
// The single lab engine. A lab is a config (humanish.lab.v2); runLab routes it to an execution
// backend by COMPOSITION — subject.source x execution.target — not by a hardcoded `kind`.
//
// Five backends ship: synthetic, computer-use, scripted-browser, terminal-product and shared
// world. runLab is the one entry
// that maps config -> backend options. Core contributors extend the closed first-party actor union
// and these selectors rather than adding a lab `kind`. On actor-backed routes, subject x execution
// selects the substrate while actors[0].type selects a registered first-party actor.

import type { AutomaticAnalysisHooks } from "../analysis/automatic-completion.js";
import { computerUseLabRefusal, runComputerUsePlan } from "../routes/computer-use/route.js";
import {
  type ComputerUseRunInput,
  type CuaActorLabHooks,
  type CuaActorLabResult,
} from "../routes/computer-use/types.js";
import { runScriptedPlan, scriptedLabRefusal } from "../routes/scripted-browser/route.js";
import {
  type ScriptedBrowserLabHooks,
  type ScriptedBrowserLabResult,
  type ScriptedRunInput,
} from "../routes/scripted-browser/types.js";
import { runTerminalPlan, terminalLabRefusal } from "../routes/terminal/route.js";
import {
  type TerminalProductLabHooks,
  type TerminalProductLabResult,
  type TerminalRunInput,
} from "../routes/terminal/types.js";
import { runSharedWorldPlan, sharedWorldLabRefusal } from "../routes/shared-world/route.js";
import {
  type ConcurrentSharedWorldLabResult,
  type SharedWorldLabHooks,
  type SharedWorldRunInput,
} from "../routes/shared-world/types.js";
import { type RunLabProvenance } from "../run/status.js";
import type { ObserverResult } from "../observer/render.js";
import { previewLabRefusal, runPreviewPlan } from "../routes/preview.js";
import { type RunScorerProvenance } from "../run/bundle.js";
import { type RunResult } from "../run/results.js";
import { backendOf, planLab, resolveLabDryRun, routeOf, type LabRoute } from "./plan.js";
import type { LabPlan, PlanRefusal } from "./plan-types.js";
import {
  normalizeRunLabOptions,
  optionRefusalOutcome,
  type RunLabDriving,
  type RunLabHomes,
} from "./run-lab-options.js";

export { resolveLabDryRun };
import { type LabConfig } from "./types.js";
import { participantDesktopOf } from "../routes/computer-use/participant-desktop.js";

export type LabBackend = "synthetic" | "cua" | "scripted" | "terminal" | "concurrent-shared-world";

/**
 * Runtime overrides from CLI flags, the typed homes (`RunLabHomes`, `RunLabDriving`) and the older
 * route hook bags they replace. Each wins over the config when provided.
 */
export type RunLabOptions = RunLabBase & RunLabHomes & RunLabDriving;

interface RunLabBase {
  automaticAnalysis?: AutomaticAnalysisHooks;
  cwd: string;
  runId?: string;
  /** Which manifest this run came from (#455): threaded to the backend so the run's own
   *  status record and bundle can say which lab produced it. Absent for library callers who
   *  hand a LabConfig directly — the run is then honestly lab-less rather than guessed. */
  lab?: RunLabProvenance;
  dryRun?: boolean;
  open?: boolean;
  /** Lane override: synthetic sims or computer-use desktop count. */
  count?: number;
  /** CUA fan-out only: create a new run for failed/selected lanes from a prior run. */
  rerun?: {
    sourceRunId: string;
    participantIds?: string[];
    /** @deprecated The older name of `participantIds`. */
    laneIds?: string[];
  };
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
  /** Computer-use route hooks: subject provisioning (library callers) + test DI seams. */
  cuaHooks?: CuaActorLabHooks;
  /** Scripted-browser route hooks: browser injection + test DI seams (mirror of cuaHooks). */
  scriptedHooks?: ScriptedBrowserLabHooks;
  /** Terminal-product route hooks: sandbox/runtime-auth DI seams (mirror of cuaHooks). */
  terminalHooks?: TerminalProductLabHooks;
  /** Shared-world route hooks: sandbox / runSession / checkpoint DI seams (mirror of cuaHooks). */
  sharedWorldHooks?: SharedWorldLabHooks;
  /**
   * CONFIG-DECLARED scorer provenance (#316), forwarded alongside whichever hooks bag carries the
   * loaded scorer. Its presence is the "declared" marker the terminal route reads to flip a
   * status:"fail" verdict; the browser routes stamp it as evidence (they already flip). Core-computed
   * (path + digest), never adopter-supplied; absent for library callers.
   */
  scorerProvenance?: RunScorerProvenance;
}

export type LabOutcome =
  | { backend: "synthetic"; result: RunResult }
  | { backend: "cua"; result: CuaActorLabResult }
  | { backend: "scripted"; result: ScriptedBrowserLabResult }
  | { backend: "terminal"; result: TerminalProductLabResult }
  | { backend: "concurrent-shared-world"; result: ConcurrentSharedWorldLabResult };

/** The result of a run on route `R`, the `result` of that route's `LabOutcome`. */
export type LabResult<R extends LabRoute = LabRoute> = {
  preview: RunResult;
  "computer-use": CuaActorLabResult;
  scripted: ScriptedBrowserLabResult;
  terminal: TerminalProductLabResult;
  "shared-world": ConcurrentSharedWorldLabResult;
}[R];

/**
 * The backend a config runs on: `routeOf` in plan.ts, under its older name.
 * @deprecated Use `routeOf`, and `backendOf` for the older backend name. This goes in the next minor.
 */
export function selectLabBackend(config: LabConfig): LabBackend {
  return backendOf(routeOf(config));
}

/**
 * The one seam every lab backend is dispatched through. The options are checked against the route
 * and mapped into the route's hook bags before anything runs. Each route closes the run it started
 * on every exit through its own run scope (`src/run/run.ts`).
 */
export async function runLab(config: LabConfig, options: RunLabOptions): Promise<LabOutcome> {
  const prepared = await prepareLab(config, options);
  return prepared.ok ? prepared.run() : prepared.outcome;
}

/** A lab planned once: the route's refusal, or the run of its plan. */
export type PreparedLab =
  | { readonly ok: false; readonly outcome: LabOutcome }
  | {
      readonly ok: true;
      /** Runs the plan. A scorer loaded after planning joins the run's hooks; it changes no plan. */
      run(scorer?: Pick<RunLabOptions, "scorer" | "scorerProvenance">): Promise<LabOutcome>;
    };

/**
 * Normalizes the options and plans the lab once, so a caller can present a refusal before it loads
 * anything the run needs. A local browser study's desktop lane and provider are bound first, so the
 * plan is made with them; with createDesktopLane the caller provides the desktop, and with
 * buildExecutor it drives the app in process and needs none.
 */
export async function prepareLab(config: LabConfig, options: RunLabOptions): Promise<PreparedLab> {
  const lab = localBrowserDefaults(config);
  const route = routeOf(lab);
  const normalized = normalizeRunLabOptions(lab, route, options);
  if (!normalized.ok)
    return { ok: false, outcome: optionRefusalOutcome(lab, route, options, normalized) };
  const hooks = normalized.options.cuaHooks;
  const localVm =
    isLocalBrowserLab(lab) &&
    (hooks === undefined || participantDesktopOf(hooks) === undefined) &&
    hooks?.buildExecutor === undefined
      ? (await import("../routes/computer-use/local-vm.js")).prepareLocalVmStudy
      : undefined;
  let study = localVm?.({ ...normalized.options, config: lab });
  const planning = study?.options ?? normalized.options;
  const planned = planLab(lab, planning);
  if (!planned.ok) {
    await study?.close();
    const outcome = await refusalOutcome(lab, planning, planned.refusal);
    outcome.result.warnings.push(...normalized.warnings);
    return { ok: false, outcome };
  }
  const { plan } = planned.planned;
  return {
    ok: true,
    async run(scorer) {
      let running = normalized;
      if (scorer !== undefined) {
        const withScorer = normalizeRunLabOptions(lab, route, { ...options, ...scorer });
        if (!withScorer.ok) return optionRefusalOutcome(lab, route, options, withScorer);
        running = withScorer;
        // The study's hooks wrap the caller's, so a scorer added after planning needs a new bag.
        await study?.close();
        study = localVm?.({ ...running.options, config: lab });
      }
      try {
        const outcome = await runPlan(lab, study?.options ?? running.options, plan);
        outcome.result.warnings.push(...running.warnings);
        return outcome;
      } finally {
        await study?.close();
      }
    },
  };
}

/** Runs a plan on its route with the run's options. */
async function runPlan(
  config: LabConfig,
  options: RunLabOptions,
  plan: LabPlan,
): Promise<LabOutcome> {
  switch (plan.route) {
    case "preview":
      return { backend: "synthetic", result: await runPreviewPlan(plan, options) };
    case "computer-use":
      return {
        backend: "cua",
        result: await runComputerUsePlan(plan, computerUseInput(options), config),
      };
    case "scripted":
      return { backend: "scripted", result: await runScriptedPlan(plan, scriptedInput(options)) };
    case "terminal":
      return { backend: "terminal", result: await runTerminalPlan(plan, terminalInput(options)) };
    case "shared-world":
      return {
        backend: "concurrent-shared-world",
        result: await runSharedWorldPlan(plan, sharedWorldInput(options), config),
      };
  }
}

/** The refused route's own result, with the envelope and analysis record its runner returns. */
async function refusalOutcome(
  config: LabConfig,
  options: RunLabOptions,
  refusal: PlanRefusal,
): Promise<LabOutcome> {
  // Spend-safe default: a lab goes live only when the config (or CLI) says so.
  const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
  const lab = options.lab === undefined ? {} : { lab: options.lab };
  switch (refusal.route) {
    case "preview":
      return { backend: "synthetic", result: previewLabRefusal(options.cwd, refusal) };
    case "computer-use":
      return {
        backend: "cua",
        result: await computerUseLabRefusal(
          { ...computerUseInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
    case "scripted":
      return {
        backend: "scripted",
        result: await scriptedLabRefusal(
          { ...scriptedInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
    case "terminal":
      return {
        backend: "terminal",
        result: await terminalLabRefusal(
          { ...terminalInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
    case "shared-world":
      return {
        backend: "concurrent-shared-world",
        result: await sharedWorldLabRefusal(
          { ...sharedWorldInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
  }
}

function computerUseInput(options: RunLabOptions): ComputerUseRunInput {
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

function scriptedInput(options: RunLabOptions): ScriptedRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.scriptedHooks === undefined ? {} : { hooks: options.scriptedHooks }),
  };
}

function terminalInput(options: RunLabOptions): TerminalRunInput {
  return {
    ...analysisOf(options),
    cwd: options.cwd,
    ...(options.open === undefined ? {} : { open: options.open }),
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.terminalHooks === undefined ? {} : { hooks: options.terminalHooks }),
    ...scorerOf(options),
  };
}

function sharedWorldInput(options: RunLabOptions): SharedWorldRunInput {
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
