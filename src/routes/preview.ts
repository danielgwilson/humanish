// The preview route: a lab whose subject is this repo runs the synthetic dry run. planLab decides
// the sim count and refuses what a synthetic run would ignore; runPreviewPlan does the rest.

import type { AdmittedPlan, RunLabOptions } from "../run-lab.js";
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

/** runLab's step for a preview plan: it has no local checks and takes no scorer, so it returns its run. */
export function admitPreviewPlan(
  plan: PreviewPlan,
  input: Pick<RunLabOptions, "cwd" | "runId" | "open">,
): AdmittedPlan<"preview"> {
  return {
    ok: true,
    run: async () => ({
      route: "preview",
      result: await runPreviewPlan(plan, input),
    }),
  };
}

/** Run a preview plan: the synthetic dry run with the planned sim count. */
function runPreviewPlan(
  plan: PreviewPlan,
  input: Pick<RunLabOptions, "cwd" | "runId" | "open">,
): Promise<RunResult> {
  return runDryRun({
    ...(plan.lab === undefined ? {} : { lab: plan.lab }),
    cwd: input.cwd,
    dryRun: true,
    participantCount: plan.participantCount,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.open === undefined ? {} : { observer: { open: input.open } }),
  });
}
