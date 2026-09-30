// The route decision. A lab's route follows from its composition (subject.source,
// execution.target, the first actor's registered lane, subject.topology), never from a declared
// kind. This is the only function that decides it; selectLabBackend maps its answer to the older
// backend names.

import { resolveAutomaticAnalysis } from "../analysis/automatic-config.js";
import { planComputerUseLab } from "../routes/computer-use/plan.js";
import { planScriptedLab } from "../routes/scripted-browser/plan.js";
import { planTerminalLab } from "../routes/terminal/plan.js";
import { localBrowserDefaults } from "../substrates/local/runtime-config.js";
import type { LabBackend, RunLabOptions } from "./engine.js";
import {
  type Base,
  brainOf,
  type Built,
  capsOf,
  desktopRequirements,
  isNonEmpty,
  planBase,
  provisionedSubject,
} from "./plan-base.js";
import { sharedWorldSeats } from "./plan-participants.js";
import type {
  AtLeastTwo,
  LabBindings,
  LabPlan,
  PlanRefusal,
  PlanResult,
  SharedWorldPlane,
  SharedWorldPlan,
} from "./plan-types.js";
import {
  actorResolvesToComputerUse,
  routesToComputerUse,
  routesToScriptedBrowser,
  routesToSharedWorld,
  routesToTerminalProduct,
} from "./routing.js";
import type { LabConfig } from "./types.js";
import { automaticAnalysisRouteReason, taskProtocolValidationReason } from "./validation.js";

/** The five execution paths a lab can take. */
export type LabRoute = "preview" | "computer-use" | "shared-world" | "terminal" | "scripted";

const BACKENDS: Record<LabRoute, LabBackend> = {
  preview: "synthetic",
  "computer-use": "cua",
  "shared-world": "concurrent-shared-world",
  terminal: "terminal",
  scripted: "scripted",
};

/** The backend name older callers and wire fields use for a route. */
export function backendOf(route: LabRoute): LabBackend {
  return BACKENDS[route];
}

/**
 * The route a config takes. It never refuses: a config no route can run still gets the route
 * whose own checks refuse it with the most precise reason.
 */
export function routeOf(config: LabConfig): LabRoute {
  const source = config.subject.source;
  // A scripted-browser actor on a loopback app or a provisioned clone replays committed steps.
  if (routesToScriptedBrowser(config)) return "scripted";
  // A terminal-product subject goes to the terminal route even with an unregistered actor, so that
  // route refuses the actor instead of another route running something else.
  if (routesToTerminalProduct(config) || source === "terminal-product") return "terminal";
  // Checked before computer use: the same composition without the topology declaration runs as
  // independent lanes.
  if (routesToSharedWorld(config)) return "shared-world";
  // A CLI studied at a desktop is a computer-use study whose subject is a terminal window.
  if (source === "desktop-cli") return "computer-use";
  // Every other app-url, clone, local-app or local-tree config goes to computer use, including
  // ones with an unknown actor: that route refuses the actor, where the preview route would run
  // no participant at all.
  if (
    routesToComputerUse(config) ||
    source === "app-url" ||
    source === "clone" ||
    source === "local-app" ||
    source === "local-tree"
  )
    return "computer-use";
  // this-repo runs the synthetic preview.
  return "preview";
}

/** Resolve dry-run: explicit override wins, else the scenario mode, else the given fallback. */
export function resolveLabDryRun(
  config: LabConfig,
  override: boolean | undefined,
  fallback: boolean | undefined,
): boolean | undefined {
  if (override !== undefined) {
    return override;
  }
  if (config.scenario?.mode === "live") {
    return false;
  }
  if (config.scenario?.mode === "dry-run") {
    return true;
  }
  return fallback;
}

function planSharedWorld(config: LabConfig, base: Base): Built<SharedWorldPlan> {
  const seats = sharedWorldSeats(config);
  const actor = config.actors[0];
  const brain = brainOf(config, false);
  if (brain.kind === "caller" || !actorResolvesToComputerUse(actor?.type))
    return "unsupported-composition";
  let plane: SharedWorldPlane;
  if (seats.plane === "external-public") {
    const [first, second, ...rest] = seats.seats;
    const owner = config.subject.publicTarget?.owner;
    if (first === undefined || second === undefined || owner === undefined)
      return "unsupported-composition";
    plane = {
      kind: "external-public",
      appUrl: config.subject.appUrl ?? "",
      owner,
      participants: [first, second, ...rest],
    };
  } else {
    const [first, second, ...rest] = seats.seats;
    const subject = provisionedSubject(config);
    const checkpoint = subject?.state?.checkpoint ?? [];
    if (
      first === undefined ||
      second === undefined ||
      subject === undefined ||
      subject.state === undefined ||
      !isNonEmpty(checkpoint)
    )
      return "unsupported-composition";
    const participants: AtLeastTwo<(typeof seats.seats)[number]> = [first, second, ...rest];
    plane = {
      kind: "provisioned",
      subject: { ...subject, state: { ...subject.state, checkpoint } },
      participants,
    };
  }
  return {
    ...base,
    route: "shared-world",
    plane,
    concurrency: config.execution?.concurrency ?? plane.participants.length,
    brain,
    caps: capsOf(config),
    requirements: base.dryRun
      ? []
      : desktopRequirements(config, {
          e2b: true,
          brain,
          localVm: false,
          externalCatch: plane.kind === "external-public",
        }),
  };
}

/**
 * The preview route's refusals before a run starts, in its order: real email receiving, then
 * analysis, then tasks. Each would otherwise be silently ignored by a synthetic run.
 */
function previewRefusal(config: LabConfig): PlanRefusal | undefined {
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  const analysisReason = analysis.ok ? automaticAnalysisRouteReason(config) : analysis.message;
  if (String(config.comms?.email?.kind) === "real")
    return {
      route: "preview",
      code: "HUMANISH_LAB_COMMS_UNSUPPORTED",
      message:
        "Real email receiving is unsupported on this backend. Use a supported hosted computer-use study.",
    };
  if (analysisReason)
    return {
      route: "preview",
      code: analysis.ok ? "HUMANISH_LAB_ANALYSIS_UNSUPPORTED" : "HUMANISH_LAB_ANALYSIS_INVALID",
      message: analysisReason,
    };
  const tasksReason = taskProtocolValidationReason(config);
  if (tasksReason)
    return { route: "preview", code: "HUMANISH_LAB_TASKS_UNSUPPORTED", message: tasksReason };
  return undefined;
}

/**
 * The plan a lab runs under, built without reading files, env or the network. A combination the
 * plan types cannot hold comes back as the gap a route refuses today. Nothing dispatches on the
 * plan yet: each route adopts it in its own change, and the parser's composition rules still run
 * first.
 */
export function planLab(config: LabConfig, options: RunLabOptions): PlanResult {
  const route = routeOf(config);
  const lab = localBrowserDefaults(config);
  const dryRun = resolveLabDryRun(lab, options.dryRun, true) ?? true;
  const provenance = options.lab === undefined ? {} : { lab: options.lab };
  // An adopted route's planner makes every refusal that route makes, in the route's order, so it
  // runs before the checks planLab still makes for the other routes.
  if (route === "terminal") {
    const terminal = planTerminalLab(lab, {
      dryRun,
      ...provenance,
      ...(options.terminalHooks === undefined ? {} : { hooks: options.terminalHooks }),
    });
    return terminal.ok ? planned(terminal.plan, options) : { ok: false, refusal: terminal.refusal };
  }
  if (route === "computer-use") {
    const computerUse = planComputerUseLab(lab, {
      dryRun,
      ...provenance,
      ...(options.cuaHooks === undefined ? {} : { hooks: options.cuaHooks }),
      ...(options.count === undefined ? {} : { countOverride: options.count }),
      ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
    });
    return computerUse.ok
      ? planned(computerUse.plan, options)
      : { ok: false, refusal: computerUse.refusal };
  }
  if (route === "scripted") {
    const scripted = planScriptedLab(lab, {
      dryRun,
      ...provenance,
      ...(options.scriptedHooks === undefined ? {} : { hooks: options.scriptedHooks }),
    });
    return scripted.ok ? planned(scripted.plan, options) : { ok: false, refusal: scripted.refusal };
  }
  if (route === "preview") {
    const refusal = previewRefusal(lab);
    if (refusal) return { ok: false, refusal };
  }
  const analysis = resolveAutomaticAnalysis(lab.review?.analysis);
  if (!analysis.ok) return { ok: false, refusal: { route, gap: "analysis-invalid" } };
  const base: Base = planBase(lab, { dryRun, ...provenance, analysis });
  let plan: Built<LabPlan>;
  switch (route) {
    case "preview":
      plan = { ...base, route, simCount: options.count ?? lab.actors[0]?.count ?? 4 };
      break;
    case "shared-world":
      plan = planSharedWorld(lab, base);
      break;
  }
  if (typeof plan === "string") return { ok: false, refusal: { route, gap: plan } };
  return planned(plan, options);
}

/** The plan with the hook bags planLab read. */
function planned(plan: LabPlan, options: RunLabOptions): PlanResult {
  const bindings: LabBindings = {
    ...(options.cuaHooks === undefined ? {} : { cuaHooks: options.cuaHooks }),
    ...(options.scriptedHooks === undefined ? {} : { scriptedHooks: options.scriptedHooks }),
    ...(options.terminalHooks === undefined ? {} : { terminalHooks: options.terminalHooks }),
    ...(options.sharedWorldHooks === undefined
      ? {}
      : { sharedWorldHooks: options.sharedWorldHooks }),
  };
  return { ok: true, planned: { plan, bindings } };
}
