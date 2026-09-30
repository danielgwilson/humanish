// What a CLI backend's setup hands the lab command: the runLab options it chose and how it presents
// the outcome. runBackend makes the one runLab call between the two.

import { type LabOutcome, runLab, type RunLabOptions } from "../../lab/engine.js";
import type { LabConfig } from "../../lab/types.js";
import type { LoadedAdapterScorer } from "./lab-hooks.js";

export interface BackendRun {
  readonly options: RunLabOptions;
  present(outcome: LabOutcome): Promise<void>;
  /** Handles an error runLab threw, and rethrows any it does not handle. */
  onRunError?(error: unknown): Promise<void>;
}

/** Runs the lab with a backend's options and the loaded scorer, then presents the outcome. */
export async function runBackend(
  config: LabConfig,
  run: BackendRun,
  scorer?: LoadedAdapterScorer,
): Promise<void> {
  let outcome: LabOutcome;
  try {
    outcome = await runLab(config, {
      ...run.options,
      ...(scorer ? { scorer: scorer.hooks, scorerProvenance: scorer.provenance } : {}),
    });
  } catch (error) {
    if (run.onRunError === undefined) throw error;
    await run.onRunError(error);
    return;
  }
  await run.present(outcome);
}
