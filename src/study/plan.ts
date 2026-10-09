// The route decision. A study's route follows from its composition (subject.source,
// execution.target, the actor's registered run kind, `route: shared-world`), never from a
// declared kind. This is the only function that decides it.

import { resolveAutomaticAnalysis } from "../analysis/automatic-config.js";
import { callerDrivingOf, planComputerUseStudy } from "../routes/computer-use/plan.js";
import { injectedBrowser, planScriptedStudy } from "../routes/scripted/plan.js";
import { planSharedWorldStudy } from "../routes/shared-world/plan.js";
import { planTerminalStudy } from "../routes/terminal/plan.js";
import {
  concurrentSandboxes,
  sandboxCeiling,
  type ConcurrentSandboxes,
  type SandboxCeiling,
} from "../substrates/e2b/lifetime.js";
import { localBrowserDefaults } from "../substrates/local/runtime-config.js";
import type { InternalRunStudyOptions } from "../run-study.js";
import type { StudyDeps } from "./study-deps.js";
import { THIS_REPO_DRY_RUN_ONLY } from "./composition-rules.js";
import { planBase } from "./plan-base.js";
import type { StudyPlan, PlanRefusal, PlanResult, PreviewRefusalCode } from "./plan-types.js";
import { routeOf, type StudyRoute } from "./routing.js";
import type { StudyConfig } from "./types.js";
import { automaticAnalysisRouteReason, taskProtocolValidationReason } from "./validation.js";
import { declaredParticipantCount } from "./study-fields.js";
import { recordedStudyWarnings } from "./warnings.js";

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
  if (config.mode === "live") {
    return false;
  }
  if (config.mode === "dry-run") {
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
  const participantCount = options.count ?? declaredParticipantCount(config) ?? 4;
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
 * The plan a study runs under, built without reading files or the network. From the environment
 * (options.env, else process.env, as the routes read it) it reads the operator's E2B plan limits,
 * the sandbox ceiling and the concurrent sandboxes, which no study file can know. Each route's
 * planner makes every refusal that route makes, in the route's order and with its codes and
 * messages; the route's exported runner calls the same planner.
 */
export function planStudy(
  config: StudyConfig,
  options: InternalRunStudyOptions,
  deps: StudyDeps = {},
): PlanResult {
  const study = localBrowserDefaults(config);
  const input = { dryRun: resolveStudyDryRun(study, options.dryRun, true) ?? true };
  const env = options.env ?? process.env;
  const e2b = {
    sandboxCeiling: sandboxCeiling(env),
    concurrentSandboxes: concurrentSandboxes(env),
  };
  const result = planRoute(routeOf(config), study, options, input, deps, e2b);
  if (!result.ok) return result;
  // The manifest the CLI resolved enters the plan here and nowhere else; the routes read
  // plan.study for the run's status record and bundle, and plan.warnings for its bundle events.
  const warnings = [...recordedStudyWarnings(study), ...(result.plan.warnings ?? [])];
  const plan = {
    ...result.plan,
    ...(options.study === undefined ? {} : { study: options.study }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
  return { ok: true, planned: { plan } };
}

function planRoute(
  route: StudyRoute,
  study: StudyConfig,
  options: InternalRunStudyOptions,
  input: { readonly dryRun: boolean },
  deps: StudyDeps,
  e2b: {
    readonly sandboxCeiling: SandboxCeiling;
    readonly concurrentSandboxes: ConcurrentSandboxes;
  },
): RoutePlanResult {
  const { sandboxCeiling } = e2b;
  switch (route) {
    case "preview":
      return planPreview(study, options, input);
    case "computer-use":
      return planComputerUseStudy(study, {
        ...input,
        hasRunSession: deps.runSession !== undefined,
        driving: callerDrivingOf(options),
        ...(options.count === undefined ? {} : { countOverride: options.count }),
        ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
        ...e2b,
      });
    case "shared-world":
      return planSharedWorldStudy(study, {
        ...input,
        hasRunSession: deps.runSession !== undefined,
        ...e2b,
      });
    case "terminal":
      return planTerminalStudy(study, {
        ...input,
        hasCostProbe: deps.costProbe !== undefined,
        sandboxCeiling,
      });
    case "scripted":
      return planScriptedStudy(study, {
        ...input,
        injectedBrowser: injectedBrowser(deps),
        sandboxCeiling,
      });
  }
}
