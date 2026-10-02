// What a route's CLI setup hands the lab command: the runLab options it chose and how it presents
// the outcome. runRoute plans the lab once and runs it between the two.

import { type InternalRunLabOptions, type LabOutcome, prepareLab } from "../../run-lab.js";
import type { LabConfig } from "../../lab/types.js";
import type { LoadedAdapterScorer } from "./lab-scorer.js";

export interface RouteRun {
  readonly options: InternalRunLabOptions;
  present(outcome: LabOutcome): Promise<void>;
  /** Handles an error runLab threw, and rethrows any it does not handle. */
  onRunError?(error: unknown): Promise<void>;
}

/**
 * Plans the lab with a route's options, then presents the refusal or the run. `beforeRun` runs
 * only for a plan that will run: it loads the scorer, or writes its own refusal and returns
 * undefined, so a refused lab never imports the scorer's host code. `afterRun` runs once runLab
 * has returned or thrown, before presentation, which may hold its own signal handlers (watch's
 * Observer and tunnel).
 */
export async function runRoute(
  config: LabConfig,
  run: RouteRun,
  beforeRun: () => Promise<{ scorer?: LoadedAdapterScorer } | undefined> = () =>
    Promise.resolve({}),
  afterRun: () => void = () => undefined,
): Promise<void> {
  let outcome: LabOutcome;
  try {
    const prepared = await prepareLab(config, run.options);
    if (prepared.ok) {
      const ready = await beforeRun();
      if (ready === undefined) return;
      const { scorer } = ready;
      outcome = await prepared.run(
        scorer ? { scorer: scorer.hooks, scorerProvenance: scorer.provenance } : undefined,
      );
    } else {
      outcome = prepared.outcome;
    }
  } catch (error) {
    afterRun();
    if (run.onRunError === undefined) throw error;
    await run.onRunError(error);
    return;
  }
  afterRun();
  await run.present(outcome);
}
