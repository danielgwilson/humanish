// The preview route: a lab whose subject is this repo runs the synthetic dry run. planLab decides
// the sim count and refuses what a synthetic run would ignore; runDryRun does the rest.

import type { RunLabOptions } from "../lab/engine.js";
import { planLab } from "../lab/plan.js";
import type { LabConfig } from "../lab/types.js";
import type { RunResult } from "../run/results.js";
import { runDryRun } from "../run/dry-run.js";
import path from "node:path";

export async function runPreviewLab(config: LabConfig, options: RunLabOptions): Promise<RunResult> {
  const planned = planLab(config, options);
  if (!planned.ok) {
    const { refusal } = planned;
    if (refusal.route !== "preview")
      throw new Error(`a preview lab was refused on the ${refusal.route} route`);
    return {
      schema: "humanish.run-result.v1",
      ok: false,
      cwd: path.resolve(options.cwd),
      warnings: [],
      error: { code: refusal.code, message: refusal.message },
    };
  }
  const { plan } = planned.planned;
  if (plan.route !== "preview") throw new Error(`preview lab planned the ${plan.route} route`);
  return runDryRun({
    ...(plan.lab === undefined ? {} : { lab: plan.lab }),
    cwd: options.cwd,
    dryRun: plan.dryRun,
    simCount: plan.simCount,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
    ...(options.open === undefined ? {} : { observer: { open: options.open } }),
  });
}
