// What a benchmark invocation will run and what it may spend. Pure functions, so the budget rules
// are testable without a provider.

import type { Arm } from "../taskly/answer-key.js";

export type BrainId = "openai-computer-use" | "local-agent-claude" | "local-agent-codex";

export interface Brain {
  id: BrainId;
  /** The study's actor block, without persona and mission. */
  actor: Record<string, string | number>;
  /** False when the participant's model spend has no price (a signed-in local agent). */
  priced: boolean;
  /** Typical estimated participant model spend per run, for the dry-run projection only. */
  typicalParticipantUsd: number;
}

export const BRAINS: Record<BrainId, Brain> = {
  // gpt-5.6-sol participants cost $0.12 to $0.30 per run on the walked mission (bench/RESULTS-*.md).
  "openai-computer-use": {
    id: "openai-computer-use",
    actor: { type: "openai-computer-use", maxOutputTokens: 8192 },
    priced: true,
    typicalParticipantUsd: 0.25,
  },
  "local-agent-claude": {
    id: "local-agent-claude",
    actor: { type: "local-agent", localAgent: "claude" },
    priced: false,
    typicalParticipantUsd: 0,
  },
  "local-agent-codex": {
    id: "local-agent-codex",
    actor: { type: "local-agent", localAgent: "codex" },
    priced: false,
    typicalParticipantUsd: 0,
  },
};

export function isBrainId(value: string): value is BrainId {
  return Object.hasOwn(BRAINS, value);
}

/** E2B desktop compute at the observed 8 CPU / 8 GiB allocation (src/run/pricing.ts rates). */
export const DESKTOP_USD_PER_MINUTE = 0.000148 * 60;
/** Observed desktop spend per Taskly run: 1.5 to 2 minutes. */
export const TYPICAL_DESKTOP_USD = 0.02;
/**
 * Typical single-participant analysis spend with gpt-6-astra at high effort: two-participant
 * analyses of this app cost $1.22 and $1.28 on 2026-10-04, about $0.7 of it per participant.
 */
export const TYPICAL_ANALYSIS_USD = 0.7;
/** The admission estimate `humanish analyze --dry-run` gives a single-participant Taskly run. */
export const TYPICAL_ADMISSION_USD = 1.55;

export interface BudgetSettings {
  maxUsdPerBrain: number;
  /** The study's `caps.maxUsd`: participant model spend, checked between turns. */
  participantCapUsd: number;
  /** `humanish analyze --max-cost`: the analysis is refused when its admission estimate is higher. */
  analysisMaxUsd: number;
  /** Desktop minutes the CLI plans as its worst case for one run (`plan.worstCaseSandboxMinutes`). */
  worstCaseDesktopMinutes: number;
  analysis: boolean;
}

export interface PlannedRun {
  brain: BrainId;
  arm: Arm;
  index: number;
}

/** Interleaved planted and clean runs, so a budget stop leaves the arms within one run. */
export function planRuns(brains: readonly BrainId[], runsPerArm: number): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (const brain of brains) {
    for (let index = 1; index <= runsPerArm; index++) {
      runs.push({ brain, arm: "planted", index }, { brain, arm: "clean", index });
    }
  }
  return runs;
}

/** The most one participant run can add to the estimate before the next check. */
export function participantBoundUsd(brain: Brain, settings: BudgetSettings): number {
  const model = brain.priced ? settings.participantCapUsd : 0;
  return model + settings.worstCaseDesktopMinutes * DESKTOP_USD_PER_MINUTE;
}

export interface Projection {
  runs: number;
  /** Participant runs that start under the cap at typical spend. */
  participantsFit: number;
  /** Analyses that start under the cap at typical spend. */
  analysesFit: number;
  /** Estimated spend of the runs that fit, at typical spend. */
  typicalUsd: number;
  /** The plan's worst case if every run and analysis reached its limit. */
  boundUsd: number;
}

/**
 * The dry run's estimate for one brain: the live loop's budget checks, replayed with typical
 * spend from earlier runs of this app.
 */
export function projectBrain(brain: Brain, runs: number, settings: BudgetSettings): Projection {
  const typicalParticipant = brain.typicalParticipantUsd + TYPICAL_DESKTOP_USD;
  let spent = 0;
  let participantsFit = 0;
  let analysesFit = 0;
  for (let run = 0; run < runs; run++) {
    if (!canStartParticipant(spent, brain, settings)) break;
    spent += typicalParticipant;
    participantsFit++;
    if (canStartAnalysis(spent, settings, TYPICAL_ADMISSION_USD)) {
      spent += TYPICAL_ANALYSIS_USD;
      analysesFit++;
    }
  }
  const boundRun =
    participantBoundUsd(brain, settings) + (settings.analysis ? settings.analysisMaxUsd : 0);
  return {
    runs,
    participantsFit,
    analysesFit,
    typicalUsd: round(spent),
    boundUsd: round(boundRun * runs),
  };
}

/** A participant run starts only when its worst case still fits under the cap. */
export function canStartParticipant(spentUsd: number, brain: Brain, settings: BudgetSettings): boolean {
  return spentUsd + participantBoundUsd(brain, settings) <= settings.maxUsdPerBrain;
}

/**
 * An analysis starts only when its worst case still fits under the cap. The worst case is the
 * CLI's admission estimate for that run (`humanish analyze --dry-run`), which never exceeds
 * `--max-cost`, or `--max-cost` itself when no estimate is known.
 */
export function canStartAnalysis(
  spentUsd: number,
  settings: BudgetSettings,
  admissionUsd: number = settings.analysisMaxUsd,
): boolean {
  const bound = Math.min(admissionUsd, settings.analysisMaxUsd);
  return settings.analysis && spentUsd + bound <= settings.maxUsdPerBrain;
}

export function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}
