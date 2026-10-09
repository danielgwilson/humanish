// A route test's way into one route: the route's planner, then its refusal envelope or its admit
// function and the run that returns. This is prepareStudy's path without runStudyWith's option
// checks, a local study's desktop and the public sandbox view, so a test pins the route's own
// planner order and the result the route returns. Each takes the route's input with the config
// and the resolved dry run, and the fields planStudy adds to the plan (the study and its warnings).

import type { AdmittedPlan, StudyResult } from "../../src/run-study.js";
import type { RefusedStudy } from "../../src/run/route-shell.js";
import type { RunStudyProvenance } from "../../src/run/study-provenance.js";
import type { StudyRoute } from "../../src/study/routing.js";
import { callerDrivingOf, planComputerUseStudy } from "../../src/routes/computer-use/plan.js";
import {
  admitComputerUsePlan,
  computerUseStudyRefusal,
} from "../../src/routes/computer-use/route.js";
import type {
  ComputerUseRunInput,
  CuaActorStudyResult,
} from "../../src/routes/computer-use/types.js";
import { injectedBrowser, planScriptedStudy } from "../../src/routes/scripted/plan.js";
import { admitScriptedPlan, scriptedStudyRefusal } from "../../src/routes/scripted/route.js";
import type {
  ScriptedBrowserStudyResult,
  ScriptedRunInput,
} from "../../src/routes/scripted/types.js";
import { planSharedWorldStudy } from "../../src/routes/shared-world/plan.js";
import {
  admitSharedWorldPlan,
  sharedWorldStudyRefusal,
} from "../../src/routes/shared-world/route.js";
import type {
  ConcurrentSharedWorldStudyResult,
  SharedWorldRunInput,
} from "../../src/routes/shared-world/types.js";
import { planTerminalStudy } from "../../src/routes/terminal/plan.js";
import { admitTerminalPlan, terminalStudyRefusal } from "../../src/routes/terminal/route.js";
import type {
  TerminalProductStudyResult,
  TerminalRunInput,
} from "../../src/routes/terminal/types.js";
import { sandboxCeiling } from "../../src/substrates/e2b/lifetime.js";

/** What planStudy adds to a route's plan: the study the run came from and the study's warnings. */
type PlanFields = { readonly study?: RunStudyProvenance; readonly warnings?: readonly string[] };

/** The result of an admitted plan's run, or of the refusal its checks made. */
export async function runAdmitted<R extends StudyRoute>(
  admitting: Promise<AdmittedPlan<R>>,
): Promise<StudyResult<R>> {
  const admitted = await admitting;
  // Each route's outcome carries that route's result; TypeScript cannot follow R through the union.
  return (admitted.ok ? await admitted.run() : admitted.outcome).result as StudyResult<R>;
}

export async function runComputerUse(
  options: ComputerUseRunInput & RefusedStudy,
  fields: PlanFields = {},
): Promise<CuaActorStudyResult> {
  const { config, dryRun, ...input } = options;
  const planned = planComputerUseStudy(config, {
    dryRun,
    hasRunSession: input.deps?.runSession !== undefined,
    sandboxCeiling: sandboxCeiling(input.env ?? {}),
    driving: callerDrivingOf(input),
    ...(input.countOverride === undefined ? {} : { countOverride: input.countOverride }),
    ...(input.rerun === undefined ? {} : { rerun: input.rerun }),
  });
  if (!planned.ok) return computerUseStudyRefusal(options, planned.refusal);
  return runAdmitted(admitComputerUsePlan({ ...planned.plan, ...fields }, input, config));
}

export async function runTerminal(
  options: TerminalRunInput & RefusedStudy,
  fields: PlanFields = {},
): Promise<TerminalProductStudyResult> {
  const { config, dryRun, ...input } = options;
  const planned = planTerminalStudy(config, {
    dryRun,
    hasCostProbe: input.deps?.costProbe !== undefined,
    sandboxCeiling: sandboxCeiling(input.env ?? {}),
  });
  if (!planned.ok) return terminalStudyRefusal(options, planned.refusal);
  return runAdmitted(admitTerminalPlan({ ...planned.plan, ...fields }, input));
}

export async function runSharedWorld(
  options: SharedWorldRunInput & RefusedStudy,
  fields: PlanFields = {},
): Promise<ConcurrentSharedWorldStudyResult> {
  const { config, dryRun, ...input } = options;
  const planned = planSharedWorldStudy(config, {
    dryRun,
    hasRunSession: input.deps?.runSession !== undefined,
    sandboxCeiling: sandboxCeiling(input.env ?? {}),
  });
  if (!planned.ok) return sharedWorldStudyRefusal(options, planned.refusal);
  return runAdmitted(admitSharedWorldPlan({ ...planned.plan, ...fields }, input, config));
}

export async function runScripted(
  options: ScriptedRunInput & RefusedStudy,
  fields: PlanFields = {},
): Promise<ScriptedBrowserStudyResult> {
  const { config, dryRun, ...input } = options;
  const planned = planScriptedStudy(config, {
    dryRun,
    injectedBrowser: injectedBrowser(input.deps),
    sandboxCeiling: sandboxCeiling(input.env ?? {}),
  });
  if (!planned.ok) return scriptedStudyRefusal(options, planned.refusal);
  return runAdmitted(admitScriptedPlan({ ...planned.plan, ...fields }, input));
}
