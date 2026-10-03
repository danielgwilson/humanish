// runStudyWith runs one study. It normalizes the caller's options, binds a local browser study's desktop
// and provider, and plans the study once with planStudy. A refused plan returns the route's own result
// envelope before anything starts. One switch on plan.route then calls the route's admit function,
// which runs the route's local checks that need no scorer (keys, subject env, the local agent) and
// returns the route's run. prepareStudy is the same path in two steps, so the CLI can present either
// refusal before it loads a declared review scorer.

import type { LocalVmInput } from "./routes/computer-use/types.js";
import {
  computerUseInput,
  type LateScorer,
  scriptedInput,
  sharedWorldInput,
  terminalInput,
} from "./study/route-inputs.js";
import { planStudy, resolveStudyDryRun, routeOf, type StudyRoute } from "./study/plan.js";
import type { StudyPlan, PlanRefusal } from "./study/plan-types.js";
import type { StudyDeps } from "./study/study-deps.js";
import type { StudyEvent } from "./study/run-study-events.js";
import {
  normalizeRunStudyOptions,
  optionRefusalOutcome,
  removedOptionRefusal,
} from "./study/run-study-options.js";
import type { RunStudyDriving, RunStudyHomes } from "./study/run-study-homes.js";
import { V2_SCHEMA, type StudyConfig } from "./study/types.js";
import { V2_UNSUPPORTED_MESSAGE } from "./study/config.js";
import type { ObserverResult } from "./observer/render.js";
import { admitComputerUsePlan, computerUseStudyRefusal } from "./routes/computer-use/route.js";
import { type CuaActorStudyResult } from "./routes/computer-use/types.js";
import {
  admitPreviewPlan,
  previewStudyRefusal,
  type PreviewStudyResult,
} from "./routes/preview.js";
import { admitScriptedPlan, scriptedStudyRefusal } from "./routes/scripted/route.js";
import { type ScriptedBrowserStudyResult } from "./routes/scripted/types.js";
import { admitSharedWorldPlan, sharedWorldStudyRefusal } from "./routes/shared-world/route.js";
import { type ConcurrentSharedWorldStudyResult } from "./routes/shared-world/types.js";
import { admitTerminalPlan, terminalStudyRefusal } from "./routes/terminal/route.js";
import { type TerminalProductStudyResult } from "./routes/terminal/types.js";
import { type RunScorerProvenance } from "./run/bundle.js";
import type { RunStudyProvenance } from "./run/study-provenance.js";
import { isLocalBrowserStudy, localBrowserDefaults } from "./substrates/local/runtime-config.js";

/**
 * Runs a study on its route. The options are checked against the route and mapped into the route's
 * hook bags before anything runs. Each route closes the run it started on every exit through its
 * own run scope (`src/run/run.ts`).
 */
export async function runStudyWith(
  config: StudyConfig,
  options: InternalRunStudyOptions,
  deps: StudyDeps = {},
): Promise<StudyOutcome> {
  const prepared = await prepareStudy(config, options, deps);
  return prepared.ok ? prepared.run() : prepared.outcome;
}

/**
 * The package's study runner (`src/index.ts`): runStudyWith with the public options only. A
 * JavaScript caller that passes a field RunStudyOptions no longer has, or a humanish.lab.v2 config,
 * is refused in the route's own result envelope before anything runs.
 */
export async function runStudy(
  config: StudyConfig,
  options: RunStudyOptions,
): Promise<StudyOutcome> {
  const refusal =
    config.schema === V2_SCHEMA
      ? ({
          ok: false,
          code: "HUMANISH_STUDY_V2_UNSUPPORTED",
          message: V2_UNSUPPORTED_MESSAGE,
        } as const)
      : removedOptionRefusal(options);
  if (refusal === undefined) return runStudyWith(config, options);
  const study = localBrowserDefaults(config);
  return optionRefusalOutcome(study, routeOf(study), options, refusal);
}

/** A study planned once: the route's refusal, or the run of its plan. */
export type PreparedStudy =
  | { readonly ok: false; readonly outcome: StudyOutcome }
  | {
      readonly ok: true;
      /** Runs the plan. A scorer loaded after planning joins the run's hooks; it changes no plan. */
      run(scorer?: LateScorer): Promise<StudyOutcome>;
    };

/**
 * Normalizes the options and plans the study once, so a caller can present a refusal before it loads
 * anything the run needs. A local browser study's provider is bound first, so the plan is made with
 * it, and its desktop goes to the computer-use run as `localVm`; with inProcess the caller drives
 * the app in process and needs no desktop.
 */
export async function prepareStudy(
  config: StudyConfig,
  options: InternalRunStudyOptions,
  deps: StudyDeps = {},
): Promise<PreparedStudy> {
  const study = localBrowserDefaults(config);
  const route = routeOf(study);
  const normalized = normalizeRunStudyOptions(study, route, options);
  if (!normalized.ok)
    return { ok: false, outcome: optionRefusalOutcome(study, route, options, normalized) };
  // An in-process executor needs no desktop, and a caller that already prepared the study passes
  // its localVm, which a second study would replace.
  const prepareLocalVm =
    isLocalBrowserStudy(study) && options.inProcess === undefined && options.localVm === undefined
      ? (await import("./routes/computer-use/local-vm.js")).prepareLocalVmRun
      : undefined;
  const vm = prepareLocalVm?.({ ...normalized.options, config: study });
  const planning: InternalRunStudyOptions =
    vm === undefined ? normalized.options : { ...vm.options, localVm: vm.localVm };
  const planned = planStudy(study, planning, deps);
  if (!planned.ok) {
    await vm?.close();
    const outcome = await refusalOutcome(study, planning, planned.refusal, deps, normalized.emit);
    outcome.result.warnings.push(...normalized.warnings);
    return { ok: false, outcome };
  }
  const admitted = await admitPlan(study, planning, planned.planned.plan, deps, normalized.emit);
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
          const withScorer = normalizeRunStudyOptions(study, route, { ...options, ...scorer });
          if (!withScorer.ok) {
            const outcome = optionRefusalOutcome(study, route, options, withScorer);
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
  config: StudyConfig,
  options: InternalRunStudyOptions,
  plan: StudyPlan,
  deps: StudyDeps,
  emit: ((event: StudyEvent) => void) | undefined,
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
  config: StudyConfig,
  options: InternalRunStudyOptions,
  refusal: PlanRefusal,
  deps: StudyDeps,
  emit: ((event: StudyEvent) => void) | undefined,
): Promise<StudyOutcome> {
  // Spend-safe default: a study goes live only when the config (or CLI) says so.
  const dryRun = resolveStudyDryRun(config, options.dryRun, true) ?? true;
  switch (refusal.route) {
    case "preview":
      return {
        route: "preview",
        result: previewStudyRefusal(options.cwd, config.id, refusal),
      };
    case "computer-use":
      return {
        route: "computer-use",
        result: await computerUseStudyRefusal(
          { ...computerUseInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
    case "scripted":
      return {
        route: "scripted",
        result: await scriptedStudyRefusal(
          { ...scriptedInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
    case "terminal":
      return {
        route: "terminal",
        result: await terminalStudyRefusal(
          { ...terminalInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
    case "shared-world":
      return {
        route: "shared-world",
        result: await sharedWorldStudyRefusal(
          { ...sharedWorldInput(options, deps, emit), config, dryRun },
          refusal,
        ),
      };
  }
}

/**
 * What a package caller passes to runStudy: the run's settings and the typed homes (`RunStudyHomes`,
 * `RunStudyDriving`). Each wins over the config when provided.
 */
export type RunStudyOptions = RunStudyBase & RunStudyHomes & RunStudyDriving;

interface RunStudyBase {
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

/** runStudyWith's options inside the package: the public ones plus what only the CLI and tests set. */
export type InternalRunStudyOptions = RunStudyOptions & RunStudyInternals;

interface RunStudyInternals {
  /**
   * Which manifest this run came from. planStudy puts it on the plan, and the route reads
   * plan.study for the run's status record and bundle. Absent for a library caller that passes a
   * StudyConfig directly; that run records no study.
   */
  study?: RunStudyProvenance;
  /**
   * Config-declared scorer provenance, forwarded alongside the
   * loaded scorer. Its presence is the "declared" marker the terminal route reads to flip a
   * status:"fail" verdict; the browser routes stamp it as evidence (they already flip). Core-computed
   * (path + digest), never adopter-supplied; absent for library callers.
   */
  scorerProvenance?: RunScorerProvenance;
  /** The local VM study's desktop, analysis gate and signal, for a local browser study. */
  localVm?: LocalVmInput;
}

/** A run's result and the route it ran on. */
interface RouteOutcome<R extends StudyRoute, T> {
  route: R;
  result: T;
}

export type StudyOutcome =
  | RouteOutcome<"preview", PreviewStudyResult>
  | RouteOutcome<"computer-use", CuaActorStudyResult>
  | RouteOutcome<"scripted", ScriptedBrowserStudyResult>
  | RouteOutcome<"terminal", TerminalProductStudyResult>
  | RouteOutcome<"shared-world", ConcurrentSharedWorldStudyResult>;

/**
 * A plan past its route's local checks that need no scorer: the refusal they returned, or the
 * route's run, which takes a scorer loaded after them.
 */
export type AdmittedPlan<R extends StudyRoute = StudyRoute> =
  | { readonly ok: false; readonly outcome: Extract<StudyOutcome, { route: R }> }
  | {
      readonly ok: true;
      run(scorer?: LateScorer): Promise<Extract<StudyOutcome, { route: R }>>;
    };

/** The result of a run on route `R`, the `result` of that route's `StudyOutcome`. */
export type StudyResult<R extends StudyRoute = StudyRoute> = {
  preview: PreviewStudyResult;
  "computer-use": CuaActorStudyResult;
  scripted: ScriptedBrowserStudyResult;
  terminal: TerminalProductStudyResult;
  "shared-world": ConcurrentSharedWorldStudyResult;
}[R];
