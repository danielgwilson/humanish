// runLab runs one lab. It normalizes the caller's options, binds a local browser study's desktop
// and provider, and plans the lab once with planLab. A refused plan returns the route's own result
// envelope before anything starts. One switch on plan.route then calls the route's admit function,
// which runs the route's local checks that need no scorer (keys, subject env, the local agent) and
// returns the route's run. prepareLab is the same path in two steps, so the CLI can present either
// refusal before it loads a declared review scorer.

import type { LocalVmInput } from "./routes/computer-use/types.js";
import {
  computerUseInput,
  type LateScorer,
  scriptedInput,
  sharedWorldInput,
  terminalInput,
} from "./lab/route-inputs.js";
import { planLab, resolveLabDryRun, routeOf, type LabRoute } from "./lab/plan.js";
import type { LabPlan, PlanRefusal } from "./lab/plan-types.js";
import type { LabDeps } from "./lab/lab-deps.js";
import type { LabEvent } from "./lab/run-lab-events.js";
import {
  normalizeRunLabOptions,
  optionRefusalOutcome,
  removedOptionRefusal,
} from "./lab/run-lab-options.js";
import type { RunLabDriving, RunLabHomes } from "./lab/run-lab-homes.js";
import { type LabConfig } from "./lab/types.js";
import type { ObserverResult } from "./observer/render.js";
import { admitComputerUsePlan, computerUseLabRefusal } from "./routes/computer-use/route.js";
import { type CuaActorLabResult } from "./routes/computer-use/types.js";
import { admitPreviewPlan, previewLabRefusal, type PreviewStudyResult } from "./routes/preview.js";
import { admitScriptedPlan, scriptedLabRefusal } from "./routes/scripted/route.js";
import { type ScriptedBrowserLabResult } from "./routes/scripted/types.js";
import { admitSharedWorldPlan, sharedWorldLabRefusal } from "./routes/shared-world/route.js";
import { type ConcurrentSharedWorldLabResult } from "./routes/shared-world/types.js";
import { admitTerminalPlan, terminalLabRefusal } from "./routes/terminal/route.js";
import { type TerminalProductLabResult } from "./routes/terminal/types.js";
import { type RunScorerProvenance } from "./run/bundle.js";
import type { RunStudyProvenance } from "./run/study-provenance.js";
import { isLocalBrowserLab, localBrowserDefaults } from "./substrates/local/runtime-config.js";

/**
 * Runs a lab on its route. The options are checked against the route and mapped into the route's
 * hook bags before anything runs. Each route closes the run it started on every exit through its
 * own run scope (`src/run/run.ts`).
 */
export async function runLab(
  config: LabConfig,
  options: InternalRunLabOptions,
  deps: LabDeps = {},
): Promise<LabOutcome> {
  const prepared = await prepareLab(config, options, deps);
  return prepared.ok ? prepared.run() : prepared.outcome;
}

/**
 * runLab as the package exports it (`src/index.ts`): the public options only. A JavaScript caller
 * that passes a field RunLabOptions no longer has is refused in the route's own result envelope
 * before anything runs.
 */
export async function runPackageLab(
  config: LabConfig,
  options: RunLabOptions,
): Promise<LabOutcome> {
  const removed = removedOptionRefusal(options);
  if (removed === undefined) return runLab(config, options);
  const lab = localBrowserDefaults(config);
  return optionRefusalOutcome(lab, routeOf(lab), options, removed);
}

/** A lab planned once: the route's refusal, or the run of its plan. */
export type PreparedLab =
  | { readonly ok: false; readonly outcome: LabOutcome }
  | {
      readonly ok: true;
      /** Runs the plan. A scorer loaded after planning joins the run's hooks; it changes no plan. */
      run(scorer?: LateScorer): Promise<LabOutcome>;
    };

/**
 * Normalizes the options and plans the lab once, so a caller can present a refusal before it loads
 * anything the run needs. A local browser study's provider is bound first, so the plan is made with
 * it, and its desktop goes to the computer-use run as `localVm`; with inProcess the caller drives
 * the app in process and needs no desktop.
 */
export async function prepareLab(
  config: LabConfig,
  options: InternalRunLabOptions,
  deps: LabDeps = {},
): Promise<PreparedLab> {
  const lab = localBrowserDefaults(config);
  const route = routeOf(lab);
  const normalized = normalizeRunLabOptions(lab, route, options);
  if (!normalized.ok)
    return { ok: false, outcome: optionRefusalOutcome(lab, route, options, normalized) };
  // An in-process executor needs no desktop, and a caller that already prepared the study passes
  // its localVm, which a second study would replace.
  const prepareLocalVm =
    isLocalBrowserLab(lab) && options.inProcess === undefined && options.localVm === undefined
      ? (await import("./routes/computer-use/local-vm.js")).prepareLocalVmRun
      : undefined;
  const vm = prepareLocalVm?.({ ...normalized.options, config: lab });
  const planning: InternalRunLabOptions =
    vm === undefined ? normalized.options : { ...vm.options, localVm: vm.localVm };
  const planned = planLab(lab, planning, deps);
  if (!planned.ok) {
    await vm?.close();
    const outcome = await refusalOutcome(lab, planning, planned.refusal, deps, normalized.emit);
    outcome.result.warnings.push(...normalized.warnings);
    return { ok: false, outcome };
  }
  const admitted = await admitPlan(lab, planning, planned.planned.plan, deps, normalized.emit);
  if (!admitted.ok) {
    await vm?.close();
    admitted.outcome.result.warnings.push(...normalized.warnings);
    return { ok: false, outcome: admitted.outcome };
  }
  return {
    ok: true,
    async run(scorer) {
      // The admitted hooks report onEvent failures into normalized.warnings, so every exit from
      // the run carries that one array.
      try {
        if (scorer !== undefined) {
          // Checks the scorer against the route and the caller's options, as if passed up front.
          // Only its refusal is used; its options and warnings array are not.
          const withScorer = normalizeRunLabOptions(lab, route, { ...options, ...scorer });
          if (!withScorer.ok) {
            const outcome = optionRefusalOutcome(lab, route, options, withScorer);
            outcome.result.warnings.push(...normalized.warnings);
            return outcome;
          }
        }
        // The route layers the scorer over the inputs it admitted, and the local study is not
        // rebuilt for it. The admitted runSession, provider and participant desktop belong to this
        // study, so a rebuilt one would leave the participants they start for no finally to close.
        const outcome = await admitted.run(scorer);
        outcome.result.warnings.push(...normalized.warnings);
        return outcome;
      } finally {
        await vm?.close();
      }
    },
  };
}

/** The route's admit function for a plan, with the route's input from the run's options. */
async function admitPlan(
  config: LabConfig,
  options: InternalRunLabOptions,
  plan: LabPlan,
  deps: LabDeps,
  emit: ((event: LabEvent) => void) | undefined,
): Promise<AdmittedPlan> {
  switch (plan.route) {
    case "preview":
      return admitPreviewPlan(plan, options);
    case "computer-use":
      return admitComputerUsePlan(plan, computerUseInput(options, deps, emit), config);
    case "scripted":
      return admitScriptedPlan(plan, scriptedInput(options, deps, emit));
    case "terminal":
      return admitTerminalPlan(plan, terminalInput(options, deps, emit));
    case "shared-world":
      return admitSharedWorldPlan(plan, sharedWorldInput(options, deps, emit), config);
  }
}

/** The refused route's own result, with the envelope and analysis record its runner returns. */
async function refusalOutcome(
  config: LabConfig,
  options: InternalRunLabOptions,
  refusal: PlanRefusal,
  deps: LabDeps,
  emit: ((event: LabEvent) => void) | undefined,
): Promise<LabOutcome> {
  // Spend-safe default: a lab goes live only when the config (or CLI) says so.
  const dryRun = resolveLabDryRun(config, options.dryRun, true) ?? true;
  switch (refusal.route) {
    case "preview":
      return {
        route: "preview",
        result: previewLabRefusal(options.cwd, config.id, refusal),
      };
    case "computer-use":
      return {
        route: "computer-use",
        result: await computerUseLabRefusal(
          { ...computerUseInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
    case "scripted":
      return {
        route: "scripted",
        result: await scriptedLabRefusal(
          { ...scriptedInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
    case "terminal":
      return {
        route: "terminal",
        result: await terminalLabRefusal(
          { ...terminalInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
    case "shared-world":
      return {
        route: "shared-world",
        result: await sharedWorldLabRefusal(
          { ...sharedWorldInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
  }
}

/**
 * What a package caller passes to runLab: the run's settings and the typed homes (`RunLabHomes`,
 * `RunLabDriving`). Each wins over the config when provided.
 */
export type RunLabOptions = RunLabBase & RunLabHomes & RunLabDriving;

interface RunLabBase {
  cwd: string;
  runId?: string;
  dryRun?: boolean;
  open?: boolean;
  /** Participant count override: preview participants or computer-use desktops. */
  count?: number;
  /** CUA fan-out only: create a new run for failed/selected participants from a prior run. */
  rerun?: {
    sourceRunId: string;
    participantIds?: string[];
  };
  onObserverReady?: (observer: ObserverResult & { ok: true }) => Promise<void> | void;
}

/** runLab's options inside the package: the public ones plus what only the CLI and tests set. */
export type InternalRunLabOptions = RunLabOptions & RunLabInternals;

interface RunLabInternals {
  /**
   * Which manifest this run came from. planLab puts it on the plan, and the route reads
   * plan.lab for the run's status record and bundle. Absent for a library caller that passes a
   * LabConfig directly; that run records no lab.
   */
  lab?: RunStudyProvenance;
  /**
   * Config-declared scorer provenance, forwarded alongside the
   * loaded scorer. Its presence is the "declared" marker the terminal route reads to flip a
   * status:"fail" verdict; the browser routes stamp it as evidence (they already flip). Core-computed
   * (path + digest), never adopter-supplied; absent for library callers.
   */
  scorerProvenance?: RunScorerProvenance;
  /** The local VM study's desktop, analysis gate and signal, for a local browser lab. */
  localVm?: LocalVmInput;
}

/** A run's result and the route it ran on. */
interface RouteOutcome<R extends LabRoute, T> {
  route: R;
  result: T;
}

export type LabOutcome =
  | RouteOutcome<"preview", PreviewStudyResult>
  | RouteOutcome<"computer-use", CuaActorLabResult>
  | RouteOutcome<"scripted", ScriptedBrowserLabResult>
  | RouteOutcome<"terminal", TerminalProductLabResult>
  | RouteOutcome<"shared-world", ConcurrentSharedWorldLabResult>;

/**
 * A plan past its route's local checks that need no scorer: the refusal they returned, or the
 * route's run, which takes a scorer loaded after them.
 */
export type AdmittedPlan<R extends LabRoute = LabRoute> =
  | { readonly ok: false; readonly outcome: Extract<LabOutcome, { route: R }> }
  | {
      readonly ok: true;
      run(scorer?: LateScorer): Promise<Extract<LabOutcome, { route: R }>>;
    };

/** The result of a run on route `R`, the `result` of that route's `LabOutcome`. */
export type LabResult<R extends LabRoute = LabRoute> = {
  preview: PreviewStudyResult;
  "computer-use": CuaActorLabResult;
  scripted: ScriptedBrowserLabResult;
  terminal: TerminalProductLabResult;
  "shared-world": ConcurrentSharedWorldLabResult;
}[R];
