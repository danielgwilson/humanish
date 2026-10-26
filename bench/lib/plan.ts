// What a benchmark invocation will run and what it may spend. Pure functions, so the budget rules
// are testable without a provider.

import { DEFAULT_ANALYSIS_EFFORT, DEFAULT_ANALYSIS_MODEL } from "../../src/analysis/automatic-config.js";
import { isReasoningEffort, reasoningEffortNames, type ReasoningEffort } from "../../src/actors/reasoning-effort.js";
import { actorParticipantModel, participantEffortReason } from "../../src/actors/computer-use/models.js";
import { MODEL_RATES, type ModelRate } from "../../src/run/pricing.js";
import type { Arm } from "../taskly/answer-key.js";

export type BrainId =
  | "openai-computer-use"
  | "computer-use"
  | "local-agent-claude"
  | "local-agent-codex";

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
  // Any listed participant model, on the vendor the participant model table names. The typical
  // spend is gpt-5.6-sol's, the highest recorded, until a benchmark records another.
  "computer-use": {
    id: "computer-use",
    actor: { type: "computer-use", maxOutputTokens: 8192 },
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

/** The participant model settings one benchmark invocation sends, beside the brain's own actor block. */
export interface ParticipantSettings {
  model: string;
  reasoningEffort?: ReasoningEffort;
  serviceTier?: "fast";
}

/** Parse `--participant <model[@effort]>` and `--service-tier`; throws on a value the CLI would refuse. */
export function parseParticipant(spec: string, serviceTier?: string): ParticipantSettings {
  const [model, effort, extra] = spec.trim().split("@");
  if (model === undefined || model === "" || extra !== undefined)
    throw new Error(`--participant takes model or model@effort, got ${spec}.`);
  if (effort !== undefined && !isReasoningEffort(effort))
    throw new Error(`--participant effort must be one of: ${reasoningEffortNames()}, got ${effort}.`);
  if (serviceTier !== undefined && serviceTier !== "fast")
    throw new Error(`--service-tier takes fast, got ${serviceTier}.`);
  return {
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  };
}

/**
 * The brain with the participant settings in its actor block. Only the API brains send them, and
 * a model or effort the study would refuse at parse is refused here, before any run.
 */
export function withParticipant(brain: Brain, settings: ParticipantSettings): Brain {
  const type = String(brain.actor.type);
  const resolved = actorParticipantModel({ type, model: settings.model });
  if (resolved === undefined)
    throw new Error(
      `--participant applies to the openai-computer-use and computer-use brains, not ${brain.id}.`,
    );
  if (!resolved.ok) throw new Error(resolved.reason);
  const effort = participantEffortReason(resolved, settings.reasoningEffort, "The --participant effort");
  if (effort !== undefined) throw new Error(effort);
  return { ...brain, actor: { ...brain.actor, ...settings } };
}

/** E2B desktop compute at the observed 8 CPU / 8 GiB allocation (src/run/pricing.ts rates). */
export const DESKTOP_USD_PER_MINUTE = 0.000148 * 60;
/** Observed desktop spend per Taskly run: 1.5 to 2 minutes. */
export const TYPICAL_DESKTOP_USD = 0.02;
/**
 * Typical single-participant analysis spend with gpt-6-astra at high effort: $0.50 to $0.84 over
 * the four runs in docs/evidence/benchmark/2026-10-04-0.110.0-neutral-openai-computer-use.json.
 */
export const TYPICAL_ANALYSIS_USD = 0.7;
/**
 * Typical analysis worst case: the mean of the `worstCaseCostUsd` `humanish analyze --dry-run`
 * reports for the six 0.114.0 benchmark runs with the benchmark's 16,384-token output allowance,
 * $1.21 to $1.35 (tests/fixtures/bench/analyze-dry-run/README.md).
 */
export const TYPICAL_ANALYSIS_WORST_CASE_USD = 1.26;

/** Mean tokens billed by the six 2026-10-04 gpt-6-astra analyses in tests/fixtures/bench/taskly/analyses. */
const TYPICAL_ANALYSIS_TOKENS = { input: 40_060, output: 7_613 };
/**
 * Mean input tokens admission counted for the six 0.114.0 runs: each worst case less 16,384
 * output tokens at $50 per million, divided by the $12.50 cache-write rate it prices input at.
 */
const TYPICAL_ADMISSION_INPUT_TOKENS = 35_531;
const BENCH_OUTPUT_ALLOWANCE = 16_384;

export interface AnalysisCost {
  typicalUsd: number;
  worstCaseUsd: number;
}

/**
 * Typical Taskly analysis spend recorded for an analyst at an effort other than gpt-6-astra at
 * high. gpt-6.1-sol at medium: $0.059 mean over 24 analyses in
 * docs/evidence/benchmark/2026-10-22-analysis-models-effort.json.
 */
const RECORDED_TYPICAL_USD: Readonly<Record<string, number>> = { "gpt-6.1-sol@medium": 0.06 };

/**
 * One Taskly analysis by `model` at `reasoningEffort`, for the dry-run projection: the recorded
 * typical spend where there is one, otherwise gpt-6-astra's at high effort scaled by what the same
 * tokens cost at the model's rates. A lower effort writes fewer output tokens, so the scaled
 * figure is high for it. The worst case is gpt-6-astra's scaled the same way, with input priced at
 * the highest input rate the model bills, as admission prices it; effort does not change it. Null
 * when this checkout has no rate for the model.
 */
export function analysisCostFor(model: string, reasoningEffort = "high"): AnalysisCost | null {
  const rate = MODEL_RATES[model];
  const astra = MODEL_RATES["gpt-6-astra"];
  if (rate === undefined || astra === undefined) return null;
  const typical = (r: ModelRate): number =>
    TYPICAL_ANALYSIS_TOKENS.input * r.inputUsdPerToken + TYPICAL_ANALYSIS_TOKENS.output * r.outputUsdPerToken;
  const worst = (r: ModelRate): number =>
    TYPICAL_ADMISSION_INPUT_TOKENS * Math.max(r.inputUsdPerToken, r.cacheWriteUsdPerToken ?? 0) +
    BENCH_OUTPUT_ALLOWANCE * r.outputUsdPerToken;
  return {
    typicalUsd:
      RECORDED_TYPICAL_USD[`${model}@${reasoningEffort}`] ??
      round((TYPICAL_ANALYSIS_USD * typical(rate)) / typical(astra)),
    worstCaseUsd: round((TYPICAL_ANALYSIS_WORST_CASE_USD * worst(rate)) / worst(astra)),
  };
}

/** The analysis a run gets when the benchmark names no analysis model: the CLI's default. */
const DEFAULT_ANALYSIS_COST = analysisCostFor(DEFAULT_ANALYSIS_MODEL, DEFAULT_ANALYSIS_EFFORT)!;

export interface AnalysisProjection {
  analyses: number;
  /** Analyses that start under the cap at typical spend, and that spend. */
  fit: number;
  typicalUsd: number;
  /** Analyses that start if each one bills its worst case, and that spend. */
  worstCaseFit: number;
  worstCaseUsd: number;
  /** The smallest cap, in steps of $0.50, at which every analysis starts at typical spend. */
  capThatFits: number;
}

/** One analysis model's planned analyses under its cap, in order, with the live loop's start rule. */
export function projectAnalyses(costs: readonly AnalysisCost[], capUsd: number): AnalysisProjection {
  const replay = (charge: (cost: AnalysisCost) => number): { fit: number; spent: number } => {
    let spent = 0;
    let fit = 0;
    for (const cost of costs) {
      if (spent + cost.worstCaseUsd > capUsd) continue;
      spent += charge(cost);
      fit++;
    }
    return { fit, spent: round(spent) };
  };
  const typical = replay((cost) => cost.typicalUsd);
  const worst = replay((cost) => cost.worstCaseUsd);
  let before = 0;
  let needed = 0;
  for (const cost of costs) {
    needed = Math.max(needed, before + cost.worstCaseUsd);
    before += cost.typicalUsd;
  }
  return {
    analyses: costs.length,
    fit: typical.fit,
    typicalUsd: typical.spent,
    worstCaseFit: worst.fit,
    worstCaseUsd: worst.spent,
    capThatFits: Math.ceil(round(needed) * 2) / 2,
  };
}

export interface BudgetSettings {
  maxUsdPerBrain: number;
  /** The study's `caps.maxUsd`: participant model spend, checked between turns. */
  participantCapUsd: number;
  /** Fixed `humanish analyze --max-cost`, or the upper limit when analysisAutoCap is enabled. */
  analysisMaxUsd: number;
  /** Derive each run's cap from admission, within analysisMaxUsd and the remaining budget. */
  analysisAutoCap?: boolean;
  /** `humanish analyze --max-output-tokens`. Unset keeps 16384 under analysisAutoCap and the CLI's
   * own default under a fixed cap. */
  analysisMaxOutputTokens?: number;
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
    if (canStartAnalysis(spent, settings, DEFAULT_ANALYSIS_COST.worstCaseUsd)) {
      spent += DEFAULT_ANALYSIS_COST.typicalUsd;
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

/** The smallest cap, in steps of $0.50, at which every planned run and analysis starts at typical spend. */
export function capThatFits(brain: Brain, runs: number, settings: BudgetSettings): number {
  for (let cap = Math.ceil(settings.maxUsdPerBrain * 2) / 2; ; cap += 0.5) {
    const projection = projectBrain(brain, runs, { ...settings, maxUsdPerBrain: cap });
    const analyses = settings.analysis ? runs : 0;
    if (projection.participantsFit === runs && projection.analysesFit >= analyses) return cap;
  }
}

/** A participant run starts only when its worst case still fits under the cap. */
export function canStartParticipant(spentUsd: number, brain: Brain, settings: BudgetSettings): boolean {
  return spentUsd + participantBoundUsd(brain, settings) <= settings.maxUsdPerBrain;
}

/**
 * An analysis starts only when its worst case still fits under the cap. The worst case is the
 * `worstCaseCostUsd` that `humanish analyze --dry-run` reports for that run: the cost if the
 * analyst writes its whole output allowance. `--max-cost` does not bound it, since admission
 * compares the expected cost plus 10% with `--max-cost`.
 */
export function canStartAnalysis(
  spentUsd: number,
  settings: BudgetSettings,
  worstCaseUsd: number,
): boolean {
  return settings.analysis && spentUsd + worstCaseUsd <= settings.maxUsdPerBrain;
}

export function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * One cap shared by analyses that run at the same time. Each analysis reserves its worst case
 * before it starts and settles to its charge when it ends, so the analyses in flight can never
 * together bill more than the cap. A request that fits only once an analysis in flight settles
 * waits for it; one that does not fit the settled spend is refused, the same answer one analysis
 * at a time would give. Requests are decided in the order they arrive.
 */
export class SpendLedger {
  spentUsd: number;
  private reservedUsd = 0;
  private readonly queue: { worstCaseUsd: number; decide: (started: boolean) => void }[] = [];

  constructor(
    private readonly settings: BudgetSettings,
    spentUsd = 0,
  ) {
    this.spentUsd = spentUsd;
  }

  /** True when the analysis may start; its worst case then counts against the cap until `settle`. */
  reserve(worstCaseUsd: number): Promise<boolean> {
    return new Promise((decide) => {
      this.queue.push({ worstCaseUsd, decide });
      this.decide();
    });
  }

  /** Release a started analysis's reservation and count what it was charged. */
  settle(worstCaseUsd: number, chargeUsd: number): void {
    this.reservedUsd = round(this.reservedUsd - worstCaseUsd);
    this.spentUsd = round(this.spentUsd + chargeUsd);
    this.decide();
  }

  private decide(): void {
    for (let next = this.queue[0]; next !== undefined; next = this.queue[0]) {
      if (!canStartAnalysis(this.spentUsd, this.settings, next.worstCaseUsd)) {
        next.decide(false);
      } else if (canStartAnalysis(this.spentUsd + this.reservedUsd, this.settings, next.worstCaseUsd)) {
        this.reservedUsd = round(this.reservedUsd + next.worstCaseUsd);
        next.decide(true);
      } else {
        return;
      }
      this.queue.shift();
    }
  }
}
