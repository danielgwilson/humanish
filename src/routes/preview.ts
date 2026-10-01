// The preview route: a lab whose subject is this repo runs the synthetic dry run. planLab decides
// the sim count and refuses what a synthetic run would ignore; runDryRun does the rest.

import type { RunLabOptions } from "../lab/engine.js";
import { planLab } from "../lab/plan.js";
import type { LabPlan, PlanRefusal } from "../lab/plan-types.js";
import type { LabConfig } from "../lab/types.js";
import type { RunResult } from "../run/results.js";
import { runDryRun } from "../run/dry-run.js";
import path from "node:path";

type PreviewPlan = Extract<LabPlan, { readonly route: "preview" }>;

export async function runPreviewLab(config: LabConfig, options: RunLabOptions): Promise<RunResult> {
  const planned = planLab(config, options);
  if (!planned.ok) {
    const { refusal } = planned;
    if (refusal.route !== "preview")
      throw new Error(`a preview lab was refused on the ${refusal.route} route`);
    return previewLabRefusal(options.cwd, refusal);
  }
  const { plan } = planned.planned;
  if (plan.route !== "preview") throw new Error(`preview lab planned the ${plan.route} route`);
  return runPreviewPlan(plan, options);
}

/** A refused preview's result. */
export function previewLabRefusal(
  cwd: string,
  refusal: Extract<PlanRefusal, { readonly route: "preview" }>,
): RunResult {
  return {
    schema: "humanish.run-result.v1",
    ok: false,
    cwd: path.resolve(cwd),
    warnings: [],
    error: { code: refusal.code, message: refusal.message },
  };
}

/** Run a preview plan: the synthetic dry run with the planned sim count. */
export function runPreviewPlan(
  plan: PreviewPlan,
  input: Pick<RunLabOptions, "cwd" | "runId" | "open">,
): Promise<RunResult> {
  return runDryRun({
    ...(plan.lab === undefined ? {} : { lab: plan.lab }),
    cwd: input.cwd,
    dryRun: plan.dryRun,
    simCount: plan.simCount,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.open === undefined ? {} : { observer: { open: input.open } }),
  });
}
