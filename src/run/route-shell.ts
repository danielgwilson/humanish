// The shell the computer-use, scripted, terminal and shared-world routes share. A route supplies
// its local checks and the body it runs inside the run scope. admitRoute completes the automatic
// analysis of a refusal and of a run, and wraps the result as the route's outcome, so a change to
// either is made here once. The preview route records no run and has no shell.

import { completeAutomaticAnalysis, type AnalysisInput } from "../analysis/automatic-completion.js";
import type { AutomaticAnalysisDeps } from "../analysis/automatic.js";
import { resolveAutomaticAnalysis } from "../analysis/automatic-config.js";
import type { AdmittedPlan, StudyOutcome, StudyResult } from "../run-study.js";
import type { PlannedAnalysis } from "../study/plan-types.js";
import type { LateScorer } from "../study/route-inputs.js";
import type { StudyRoute } from "../study/routing.js";
import type { StudyConfig } from "../study/types.js";
import { type FinishedRun, runScope, type RunScope } from "./run.js";
import { withTransientCommsSecrets } from "./transient-comms-secrets.js";

type ShellRoute = Exclude<StudyRoute, "preview">;

/** A route's local checks: the refused result, or what its run continues from. */
export type RouteAdmission<R extends ShellRoute, A> =
  | { readonly ok: false; readonly result: StudyResult<R> }
  | { readonly ok: true; readonly admitted: A };

/** A route's own parts of its run. Everything around them is admitRoute's. */
export interface RouteShell<R extends ShellRoute, I extends AnalysisInput, A> {
  readonly route: R;
  /** The plan's automatic analysis, which both the refused result and the run complete. */
  readonly analysis: PlannedAnalysis | undefined;
  /** The route's input as the checks admitted it. */
  readonly input: I;
  /** The checks that need no scorer, made before any run scope opens. */
  admit(): Promise<RouteAdmission<R, A>> | RouteAdmission<R, A>;
  /** The run inside its run scope, with the input a late scorer joined. */
  runInScope(admitted: A, input: I, scope: RunScope): Promise<StudyResult<R>>;
  /** Layers a scorer the CLI loaded after the checks over the input. Scripted takes no scorer. */
  readonly withScorer?: (input: I, scorer: LateScorer | undefined) => I;
  /** Computer use's reason to skip analysis: a local VM study whose cleanup is unconfirmed. */
  readonly analysisRefusal?: AutomaticAnalysisDeps["refusal"];
  /**
   * Computer use and shared world receive email. The run and its analysis share one scope for the
   * secrets it registers. The other routes run outside any scope, where scrubbing changes nothing.
   */
  readonly commsSecrets?: boolean;
}

/**
 * Runs a route's checks and returns the refusal they made or the route's run. A refusal carries the
 * analysis record of a run that never started. The run opens its own run scope, so whichever exit
 * it takes closes the run it started, and only a run that published its final bundle is analyzed.
 */
export async function admitRoute<R extends ShellRoute, I extends AnalysisInput, A>(
  shell: RouteShell<R, I, A>,
): Promise<AdmittedPlan<R>> {
  const complete = (input: I, result: StudyResult<R>, finished: FinishedRun | undefined) =>
    completeAutomaticAnalysis(result, finished, shell.analysis?.config, input, {
      ...(shell.analysis === undefined ? {} : { trigger: shell.analysis.trigger }),
      preferLargerOutput: shell.analysis?.preferLargerOutput === true,
      ...(shell.analysisRefusal === undefined ? {} : { refusal: shell.analysisRefusal }),
    });
  const admission = await shell.admit();
  if (!admission.ok)
    return {
      ok: false,
      outcome: routeOutcome(shell.route, await complete(shell.input, admission.result, undefined)),
    };
  const { admitted } = admission;
  return {
    ok: true,
    run: async (scorer) => {
      // The scorer joins the input only; whatever the checks admitted stays what the run uses.
      const input = shell.withScorer?.(shell.input, scorer) ?? shell.input;
      const run = async () => {
        const { result, finished } = await runScope((scope) =>
          shell.runInScope(admitted, input, scope),
        );
        return complete(input, result, finished);
      };
      return routeOutcome(
        shell.route,
        await (shell.commsSecrets ? withTransientCommsSecrets(run) : run()),
      );
    },
  };
}

/**
 * A refused study's result with the analysis record a refusal gets: it starts no run, so a declared
 * or default analysis is recorded as skipped.
 */
export function completeRefusalAnalysis<T extends { cwd: string; runId: string; dryRun: boolean }>(
  refused: T,
  config: StudyConfig,
  input: AnalysisInput,
): Promise<T> {
  const analysis = resolveAutomaticAnalysis(config.review?.analysis);
  return completeAutomaticAnalysis(
    refused,
    undefined,
    analysis.ok ? analysis.config : undefined,
    input,
    { trigger: config.review?.analysis === undefined ? "default" : "explicit" },
  );
}

/** What a refused study's envelope reads besides the route's input. */
export interface RefusedStudy {
  readonly config: StudyConfig;
  /** The run's resolved dry run. */
  readonly dryRun: boolean;
}

/** A result as its route's outcome. StudyOutcome pairs each route with its result type. */
function routeOutcome<R extends ShellRoute>(route: R, result: StudyResult<R>) {
  return { route, result } as Extract<StudyOutcome, { route: R }>;
}
