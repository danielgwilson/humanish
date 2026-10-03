// The route decision. A lab's route follows from its composition (subject.source,
// execution.target, the first actor's registered run kind, subject.topology), never from a
// declared kind. This is the only function that decides it.

import { resolveAutomaticAnalysis } from "../analysis/automatic-config.js";
import { callerDrivingOf, planComputerUseStudy } from "../routes/computer-use/plan.js";
import { injectedBrowser, planScriptedStudy } from "../routes/scripted/plan.js";
import { planSharedWorldStudy } from "../routes/shared-world/plan.js";
import { planTerminalStudy } from "../routes/terminal/plan.js";
import { localBrowserDefaults } from "../substrates/local/runtime-config.js";
import type { InternalRunStudyOptions } from "../run-study.js";
import type { StudyDeps } from "./study-deps.js";
import { THIS_REPO_DRY_RUN_ONLY } from "./composition-rules.js";
import { planBase } from "./plan-base.js";
import type { StudyPlan, PlanRefusal, PlanResult, PreviewRefusalCode } from "./plan-types.js";
import { routeOf, type StudyRoute } from "./routing.js";
import type { StudyConfig } from "./types.js";
import { automaticAnalysisRouteReason, taskProtocolValidationReason } from "./validation.js";

export { routeOf, type StudyRoute } from "./routing.js";

/** Resolve dry-run: explicit override wins, else the scenario mode, else the given fallback. */
export function resolveStudyDryRun(
  config: StudyConfig,
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
  config: StudyConfig,
  options: InternalRunStudyOptions,
  input: { readonly dryRun: boolean },
): RoutePlanResult {
  const refuse = (code: PreviewRefusalCode, message: string): RoutePlanResult => ({
    ok: false,
    refusal: { route: "preview", code, message },
  });
  if (String(config.comms?.email?.kind) === "real")
    return refuse(
      "HUMANISH_STUDY_COMMS_UNSUPPORTED",
      "Real email receiving is unsupported on the preview route. Use a supported hosted computer-use study.",
    );
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  if (!analysis.ok) return refuse("HUMANISH_STUDY_ANALYSIS_INVALID", analysis.message);
  const unsupported = automaticAnalysisRouteReason(config);
  if (unsupported) return refuse("HUMANISH_STUDY_ANALYSIS_UNSUPPORTED", unsupported);
  const tasksReason = taskProtocolValidationReason(config);
  if (tasksReason) return refuse("HUMANISH_STUDY_TASKS_UNSUPPORTED", tasksReason);
  const participantCount = options.count ?? config.actors[0]?.count ?? 4;
  if (!Number.isSafeInteger(participantCount) || participantCount < 1)
    return refuse("HUMANISH_INVALID_PARTICIPANT_COUNT", "count must be a positive integer.");
  if (!input.dryRun) return refuse("HUMANISH_LIVE_RUN_UNIMPLEMENTED", THIS_REPO_DRY_RUN_ONLY);
  return {
    ok: true,
    plan: {
      ...planBase(config, { ...input, analysis }),
      route: "preview",
      dryRun: true,
      participantCount,
    },
  };
}

type RoutePlanResult =
  | { readonly ok: true; readonly plan: StudyPlan }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/**
 * The plan a lab runs under, built without reading files, env or the network. Each route's planner
 * makes every refusal that route makes, in the route's order and with its codes and messages; the
 * route's exported runner calls the same planner.
 */
export function planStudy(
  config: StudyConfig,
  options: InternalRunStudyOptions,
  deps: StudyDeps = {},
): PlanResult {
  const lab = localBrowserDefaults(config);
  const input = { dryRun: resolveStudyDryRun(lab, options.dryRun, true) ?? true };
  const result = planRoute(routeOf(config), lab, options, input, deps);
  if (!result.ok) return result;
  // The manifest the CLI resolved enters the plan here and nowhere else; the routes read
  // plan.lab for the run's status record and bundle.
  const plan = options.lab === undefined ? result.plan : { ...result.plan, lab: options.lab };
  return { ok: true, planned: { plan } };
}

function planRoute(
  route: StudyRoute,
  lab: StudyConfig,
  options: InternalRunStudyOptions,
  input: { readonly dryRun: boolean },
  deps: StudyDeps,
): RoutePlanResult {
  switch (route) {
    case "preview":
      return planPreview(lab, options, input);
    case "computer-use":
      return planComputerUseStudy(lab, {
        ...input,
        hasRunSession: deps.runSession !== undefined,
        driving: callerDrivingOf(options),
        ...(options.count === undefined ? {} : { countOverride: options.count }),
        ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
      });
    case "shared-world":
      return planSharedWorldStudy(lab, {
        ...input,
        hasRunSession: deps.runSession !== undefined,
      });
    case "terminal":
      return planTerminalStudy(lab, { ...input, hasCostProbe: deps.costProbe !== undefined });
    case "scripted":
      return planScriptedStudy(lab, { ...input, injectedBrowser: injectedBrowser(deps) });
  }
}
