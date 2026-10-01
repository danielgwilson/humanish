// The preview route: a lab whose subject is this repo runs the synthetic dry run. planLab decides
// the sim count and refuses what a synthetic run would ignore; runPreviewPlan does the rest.

import type { RunLabOptions } from "../lab/engine.js";
import type { LabPlan, PlanRefusal } from "../lab/plan-types.js";
import type { RunResult } from "../run/results.js";
import { runDryRun } from "../run/dry-run.js";
import path from "node:path";

type PreviewPlan = Extract<LabPlan, { readonly route: "preview" }>;

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
