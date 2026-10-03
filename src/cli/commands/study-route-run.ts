// What a route's CLI setup hands the run command: the runStudyWith options it chose and how it presents
// the outcome. runRoute plans the study once and runs it between the two.

import { type InternalRunStudyOptions, type StudyOutcome, prepareStudy } from "../../run-study.js";
import type { StudyConfig } from "../../study/types.js";
import type { LoadedAdapterScorer } from "./study-scorer.js";

export interface RouteRun {
  readonly options: InternalRunStudyOptions;
  present(outcome: StudyOutcome): Promise<void>;
  /** Handles an error runStudyWith threw, and rethrows any it does not handle. */
  onRunError?(error: unknown): Promise<void>;
}

/**
 * Plans the study with a route's options, then presents the refusal or the run. `beforeRun` runs
 * only for a plan that will run: it loads the scorer, or writes its own refusal and returns
 * undefined, so a refused study never imports the scorer's host code. `afterRun` runs once runStudyWith
 * has returned or thrown, before presentation, which may hold its own signal handlers (watch's
 * Observer and tunnel).
 */
export async function runRoute(
  config: StudyConfig,
  run: RouteRun,
  beforeRun: () => Promise<{ scorer?: LoadedAdapterScorer } | undefined> = () =>
    Promise.resolve({}),
  afterRun: () => void = () => undefined,
): Promise<void> {
  let outcome: StudyOutcome;
  try {
    const prepared = await prepareStudy(config, run.options);
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
