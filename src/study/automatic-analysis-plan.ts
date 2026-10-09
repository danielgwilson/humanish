// What automatic analysis does for a study of N participants. One analysis reads at most
// EVIDENCE_LIMITS.participants of them (the analysis module owns that number). A study with more
// runs every participant and records its analysis as skipped for that reason, where the analysis
// would otherwise cover the first participants and drop the rest. The plan line, the run's
// analysis record and the CLI's exit code all read the skip from here. Once the analysis covers
// every participant a study may have, the skip never applies and this module can go.

import {
  automaticAnalysisSucceeded,
  type AutomaticAnalysisResult,
} from "../analysis/automatic-completion.js";
import {
  automaticAnalysisBudget,
  formatAutomaticAnalysisBudget,
  type AutomaticAnalysisBudget,
} from "../analysis/automatic-config.js";
import { EVIDENCE_LIMITS } from "../analysis/evidence.js";
import type { StudyRoute } from "./routing.js";

/** The reason a run records for an analysis its study has too many participants for. */
export const PARTICIPANT_LIMIT_SKIP = "AUTOMATIC_ANALYSIS_PARTICIPANT_LIMIT";

/** The CLI's words for that reason, after "analysis: ". */
export const PARTICIPANT_LIMIT_SKIP_TEXT = `not run, because the study has more than ${EVIDENCE_LIMITS.participants} participants and automatic analysis reads at most ${EVIDENCE_LIMITS.participants}`;

/** The skip a study of `participants` gets, or undefined when its analysis runs. */
export function analysisSkipFor(participants: number): typeof PARTICIPANT_LIMIT_SKIP | undefined {
  return participants > EVIDENCE_LIMITS.participants ? PARTICIPANT_LIMIT_SKIP : undefined;
}

/** The analysis budget the plan line shows, and the skip when the analysis will not run. */
export type StudyAnalysisBudget = AutomaticAnalysisBudget & {
  readonly skip?: typeof PARTICIPANT_LIMIT_SKIP;
};

/**
 * The budget of a study's automatic analysis after a live run of `participants`, or undefined
 * when none is planned. A skipped analysis carries no expected cost, since it spends nothing.
 */
export function studyAnalysisBudget(
  raw: unknown,
  route: StudyRoute,
  participants: number,
): StudyAnalysisBudget | undefined {
  const skip = analysisSkipFor(participants);
  if (skip === undefined) return automaticAnalysisBudget(raw, route, participants);
  const budget = automaticAnalysisBudget(raw, route);
  return budget && { ...budget, participants, skip };
}

/** The line `run` and `study check` print about the analysis after a live run. */
export function formatStudyAnalysisBudget(budget: StudyAnalysisBudget): string {
  if (budget.skip === undefined) return formatAutomaticAnalysisBudget(budget);
  const next =
    budget.trigger === "default"
      ? "Set review.analysis: false to leave it out of this plan."
      : "The analysis this study asks for will be recorded as skipped and the run will exit 2; set review.analysis: false or run fewer participants.";
  return `After live runs: automatic analysis will not run. This study has ${budget.participants ?? "more"} participants, and automatic analysis reads at most ${EVIDENCE_LIMITS.participants}. ${next}`;
}

/** A run's result with its analysis recorded as skipped for its participant count. */
export function withParticipantLimitSkip<T>(
  result: T,
  trigger: "default" | "explicit",
): T & AutomaticAnalysisResult {
  return {
    ...result,
    ...(trigger === "default" ? { automaticAnalysisTrigger: trigger } : {}),
    automaticAnalysis: { state: "skipped", reason: PARTICIPANT_LIMIT_SKIP },
  };
}

/**
 * Whether a run's automatic analysis lets the command exit 0. A participant-count skip of the
 * analysis a study did not ask for passes, like the default analysis's missing-key skip; a skip of
 * an explicit request fails, like that request's missing key.
 */
export function studyAnalysisSucceeded(result: AutomaticAnalysisResult): boolean {
  const value = result.automaticAnalysis;
  return (
    automaticAnalysisSucceeded(result) ||
    (result.automaticAnalysisTrigger === "default" &&
      value?.state === "skipped" &&
      value.reason === PARTICIPANT_LIMIT_SKIP)
  );
}
