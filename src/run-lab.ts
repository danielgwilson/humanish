// runLab runs one lab. It normalizes the caller's options, binds a local browser study's desktop
// and provider, and plans the lab once with planLab. A refused plan returns the route's own result
// envelope before anything starts. One switch on plan.route then calls the route's admit function,
// which runs the route's local checks that need no scorer (today the terminal route's keys) and
// returns the route's run. prepareLab is the same path in two steps, so the CLI can present either
// refusal before it loads a declared review scorer.

import type { AutomaticAnalysisHooks } from "./analysis/automatic-completion.js";
import {
  computerUseInput,
  scriptedInput,
  sharedWorldInput,
  terminalInput,
} from "./lab/route-inputs.js";
import { planLab, resolveLabDryRun, routeOf, type LabBackend, type LabRoute } from "./lab/plan.js";
import type { LabPlan, PlanRefusal } from "./lab/plan-types.js";
import {
  normalizeRunLabOptions,
  optionRefusalOutcome,
  type RunLabDriving,
  type RunLabHomes,
} from "./lab/run-lab-options.js";
import { type LabConfig } from "./lab/types.js";
import type { ObserverResult } from "./observer/render.js";
import { admitComputerUsePlan, computerUseLabRefusal } from "./routes/computer-use/route.js";
import { participantDesktopOf } from "./routes/computer-use/participant-desktop.js";
import { type CuaActorLabHooks, type CuaActorLabResult } from "./routes/computer-use/types.js";
import { admitPreviewPlan, previewLabRefusal } from "./routes/preview.js";
import { admitScriptedPlan, scriptedLabRefusal } from "./routes/scripted/route.js";
import {
  type ScriptedBrowserLabHooks,
  type ScriptedBrowserLabResult,
} from "./routes/scripted/types.js";
import { admitSharedWorldPlan, sharedWorldLabRefusal } from "./routes/shared-world/route.js";
import {
  type ConcurrentSharedWorldLabResult,
  type SharedWorldLabHooks,
} from "./routes/shared-world/types.js";
import { admitTerminalPlan, terminalLabRefusal } from "./routes/terminal/route.js";
import {
  type TerminalProductLabHooks,
  type TerminalProductLabResult,
} from "./routes/terminal/types.js";
import { type RunScorerProvenance } from "./run/bundle.js";
import { type RunResult } from "./run/results.js";
import { type RunLabProvenance } from "./run/status.js";
import { isLocalBrowserLab, localBrowserDefaults } from "./substrates/local/runtime-config.js";

/**
 * Runs a lab on its route. The options are checked against the route and mapped into the route's
 * hook bags before anything runs. Each route closes the run it started on every exit through its
 * own run scope (`src/run/run.ts`).
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
      ? (await import("./routes/computer-use/local-vm.js")).prepareLocalVmStudy
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
  const admitted = await admitPlan(lab, planning, planned.planned.plan);
  if (!admitted.ok) {
    await study?.close();
    admitted.outcome.result.warnings.push(...normalized.warnings);
    return { ok: false, outcome: admitted.outcome };
  }
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
        const outcome = await admitted.run(study?.options ?? running.options);
        outcome.result.warnings.push(...running.warnings);
        return outcome;
      } finally {
        await study?.close();
      }
    },
  };
}

/** The route's admit function for a plan: its refusal, or its run with the run's options. */
async function admitPlan(
  config: LabConfig,
  options: RunLabOptions,
  plan: LabPlan,
): Promise<AdmittedPlan> {
  switch (plan.route) {
    case "preview":
      return admitPreviewPlan(plan);
    case "computer-use":
      return admitComputerUsePlan(plan, config);
    case "scripted":
      return admitScriptedPlan(plan);
    case "terminal":
      return admitTerminalPlan(plan, terminalInput(options));
    case "shared-world":
      return admitSharedWorldPlan(plan, config);
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
      return {
        route: "preview",
        backend: "synthetic",
        result: previewLabRefusal(options.cwd, refusal),
      };
    case "computer-use":
      return {
        route: "computer-use",
        backend: "cua",
        result: await computerUseLabRefusal(
          { ...computerUseInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
    case "scripted":
      return {
        route: "scripted",
        backend: "scripted",
        result: await scriptedLabRefusal(
          { ...scriptedInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
    case "terminal":
      return {
        route: "terminal",
        backend: "terminal",
        result: await terminalLabRefusal(
          { ...terminalInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
    case "shared-world":
      return {
        route: "shared-world",
        backend: "concurrent-shared-world",
        result: await sharedWorldLabRefusal(
          { ...sharedWorldInput(options), ...lab, config, dryRun },
          refusal,
        ),
      };
  }
}

/**
 * Runtime overrides from CLI flags, the typed homes (`RunLabHomes`, `RunLabDriving`) and the older
 * route hook bags they replace. Each wins over the config when provided.
 */
export type RunLabOptions = RunLabBase & RunLabHomes & RunLabDriving;

interface RunLabBase {
  automaticAnalysis?: AutomaticAnalysisHooks;
  cwd: string;
  runId?: string;
  /** Which manifest this run came from (#455): threaded to the route so the run's own
   *  status record and bundle can say which lab produced it. Absent for library callers who
   *  hand a LabConfig directly — the run is then honestly lab-less rather than guessed. */
  lab?: RunLabProvenance;
  dryRun?: boolean;
  open?: boolean;
  /** Participant count override: preview participants or computer-use desktops. */
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

/** A run's result and the route it ran on. */
interface RouteOutcome<R extends LabRoute, B extends LabBackend, T> {
  route: R;
  /** @deprecated The route's older name. Use `route`; this field goes in the next minor. */
  backend: B;
  result: T;
}

export type LabOutcome =
  | RouteOutcome<"preview", "synthetic", RunResult>
  | RouteOutcome<"computer-use", "cua", CuaActorLabResult>
  | RouteOutcome<"scripted", "scripted", ScriptedBrowserLabResult>
  | RouteOutcome<"terminal", "terminal", TerminalProductLabResult>
  | RouteOutcome<"shared-world", "concurrent-shared-world", ConcurrentSharedWorldLabResult>;

/**
 * A plan past its route's local checks that need no scorer: the refusal they returned, or the
 * route's run, which takes the run's options once a declared scorer has joined them.
 */
export type AdmittedPlan<R extends LabRoute = LabRoute> =
  | { readonly ok: false; readonly outcome: Extract<LabOutcome, { route: R }> }
  | {
      readonly ok: true;
      run(options: RunLabOptions): Promise<Extract<LabOutcome, { route: R }>>;
    };

/** The result of a run on route `R`, the `result` of that route's `LabOutcome`. */
export type LabResult<R extends LabRoute = LabRoute> = {
  preview: RunResult;
  "computer-use": CuaActorLabResult;
  scripted: ScriptedBrowserLabResult;
  terminal: TerminalProductLabResult;
  "shared-world": ConcurrentSharedWorldLabResult;
}[R];
