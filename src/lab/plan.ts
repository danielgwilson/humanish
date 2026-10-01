// The route decision. A lab's route follows from its composition (subject.source,
// execution.target, the first actor's registered lane, subject.topology), never from a declared
// kind. This is the only function that decides it; backendOf maps its answer to the older
// backend names.

import { resolveAutomaticAnalysis } from "../analysis/automatic-config.js";
import { planComputerUseLab } from "../routes/computer-use/plan.js";
import { planScriptedLab } from "../routes/scripted-browser/plan.js";
import { planSharedWorldLab } from "../routes/shared-world/plan.js";
import { planTerminalLab } from "../routes/terminal/plan.js";
import type { RunLabProvenance } from "../run/status.js";
import { localBrowserDefaults } from "../substrates/local/runtime-config.js";
import type { RunLabOptions } from "../run-lab.js";
import { planBase } from "./plan-base.js";
import type { LabPlan, PlanRefusal, PlanResult, PreviewRefusalCode } from "./plan-types.js";
import {
  isComputerUseComposition,
  isScriptedBrowserComposition,
  isSharedWorldComposition,
  isTerminalProductComposition,
} from "./routing.js";
import type { LabConfig } from "./types.js";
import { automaticAnalysisRouteReason, taskProtocolValidationReason } from "./validation.js";

/** The five execution paths a lab can take. */
export type LabRoute = "preview" | "computer-use" | "shared-world" | "terminal" | "scripted";

/** A route's older name, kept in `LabOutcome.backend` and the preflight result's `backend`. */
export type LabBackend = "synthetic" | "cua" | "scripted" | "terminal" | "concurrent-shared-world";

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
 * The backend a config runs on: `routeOf`, under its older name.
 * @deprecated Use `routeOf`, and `backendOf` for the older backend name. This goes in the next minor.
 */
export function selectLabBackend(config: LabConfig): LabBackend {
  return backendOf(routeOf(config));
}

/**
 * The route a config takes. It never refuses: a config no route can run still gets the route
 * whose own checks refuse it with the most precise reason.
 */
export function routeOf(config: LabConfig): LabRoute {
  const source = config.subject.source;
  // A scripted-browser actor on a loopback app or a provisioned clone replays committed steps.
  if (isScriptedBrowserComposition(config)) return "scripted";
  // A terminal-product subject goes to the terminal route even with an unregistered actor, so that
  // route refuses the actor instead of another route running something else.
  if (isTerminalProductComposition(config) || source === "terminal-product") return "terminal";
  // Checked before computer use: the same composition without the topology declaration runs as
  // independent lanes.
  if (isSharedWorldComposition(config)) return "shared-world";
  // A CLI studied at a desktop is a computer-use study whose subject is a terminal window.
  if (source === "desktop-cli") return "computer-use";
  // Every other app-url, clone, local-app or local-tree config goes to computer use, including
  // ones with an unknown actor: that route refuses the actor, where the preview route would run
  // no participant at all.
  if (
    isComputerUseComposition(config) ||
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

/**
 * The preview route's refusals before a run starts, in its order: real email receiving, then
 * analysis, then tasks. Each would otherwise be silently ignored by a synthetic run.
 */
function planPreview(
  config: LabConfig,
  options: RunLabOptions,
  input: { readonly dryRun: boolean; readonly lab?: RunLabProvenance },
): RoutePlanResult {
  const refuse = (code: PreviewRefusalCode, message: string): RoutePlanResult => ({
    ok: false,
    refusal: { route: "preview", code, message },
  });
  if (String(config.comms?.email?.kind) === "real")
    return refuse(
      "HUMANISH_LAB_COMMS_UNSUPPORTED",
      "Real email receiving is unsupported on the preview route. Use a supported hosted computer-use study.",
    );
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return refuse("HUMANISH_LAB_ANALYSIS_INVALID", analysis.message);
  const unsupported = automaticAnalysisRouteReason(config);
  if (unsupported) return refuse("HUMANISH_LAB_ANALYSIS_UNSUPPORTED", unsupported);
  const tasksReason = taskProtocolValidationReason(config);
  if (tasksReason) return refuse("HUMANISH_LAB_TASKS_UNSUPPORTED", tasksReason);
  return {
    ok: true,
    plan: {
      ...planBase(config, { ...input, analysis }),
      route: "preview",
      simCount: options.count ?? config.actors[0]?.count ?? 4,
    },
  };
}

type RoutePlanResult =
  | { readonly ok: true; readonly plan: LabPlan }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * The plan a lab runs under, built without reading files, env or the network. Each route's planner
 * makes every refusal that route makes, in the route's order and with its codes and messages; the
 * route's exported runner calls the same planner.
 */
export function planLab(config: LabConfig, options: RunLabOptions): PlanResult {
  const lab = localBrowserDefaults(config);
  const input = {
    dryRun: resolveLabDryRun(lab, options.dryRun, true) ?? true,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
  };
  const result = planRoute(routeOf(config), lab, options, input);
  if (!result.ok) return result;
  return { ok: true, planned: { plan: result.plan } };
}

function planRoute(
  route: LabRoute,
  lab: LabConfig,
  options: RunLabOptions,
  input: { readonly dryRun: boolean; readonly lab?: RunLabProvenance },
): RoutePlanResult {
  switch (route) {
    case "preview":
      return planPreview(lab, options, input);
    case "computer-use":
      return planComputerUseLab(lab, {
        ...input,
        ...(options.cuaHooks === undefined ? {} : { hooks: options.cuaHooks }),
        ...(options.count === undefined ? {} : { countOverride: options.count }),
        ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
      });
    case "shared-world":
      return planSharedWorldLab(lab, {
        ...input,
        ...(options.sharedWorldHooks === undefined ? {} : { hooks: options.sharedWorldHooks }),
      });
    case "terminal":
      return planTerminalLab(lab, {
        ...input,
        ...(options.terminalHooks === undefined ? {} : { hooks: options.terminalHooks }),
      });
    case "scripted":
      return planScriptedLab(lab, {
        ...input,
        ...(options.scriptedHooks === undefined ? {} : { hooks: options.scriptedHooks }),
      });
  }
}
