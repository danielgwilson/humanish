// What a CLI backend's setup hands the lab command: the runLab options it chose and how it presents
// the outcome. The command makes the runLab call between the two.

import type { LabOutcome, RunLabOptions } from "../../lab/engine.js";

export interface BackendRun {
  readonly options: RunLabOptions;
  present(outcome: LabOutcome): Promise<void>;
  /** Handles an error runLab threw, and rethrows any it does not handle. */
  onRunError?(error: unknown): Promise<void>;
}
