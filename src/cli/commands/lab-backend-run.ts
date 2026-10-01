// What a CLI backend's setup hands the lab command: the runLab options it chose and how it presents
// the outcome. runBackend plans the lab once and runs it between the two.

import { type LabOutcome, prepareLab, type RunLabOptions } from "../../lab/engine.js";
import type { LabConfig } from "../../lab/types.js";
import type { LoadedAdapterScorer } from "./lab-hooks.js";

export interface BackendRun {
  readonly options: RunLabOptions;
  present(outcome: LabOutcome): Promise<void>;
  /** Handles an error runLab threw, and rethrows any it does not handle. */
  onRunError?(error: unknown): Promise<void>;
}

/**
 * Plans the lab with a backend's options, then presents the refusal or the run. `beforeRun` runs
 * only for a plan that will run: it loads the scorer, or writes its own refusal and returns
 * undefined, so a refused lab never imports the scorer's host code.
 */
export async function runBackend(
  config: LabConfig,
  run: BackendRun,
  beforeRun: () => Promise<{ scorer?: LoadedAdapterScorer } | undefined> = () =>
    Promise.resolve({}),
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
    if (run.onRunError === undefined) throw error;
    await run.onRunError(error);
    return;
  }
  await run.present(outcome);
}
