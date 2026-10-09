import type { StudyRoute } from "../study/plan.js";
import { CODEX_ANALYSIS_MODEL, codexAnalysisIdentity } from "./codex-config.js";
import {
  DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS,
  MAX_ANALYSIS_OUTPUT_TOKENS,
  analysisCostRange,
  isSupportedAnalysisModel,
} from "./execute.js";
import { admissionRule } from "./admission.js";
import { analysisRequestCount, EVIDENCE_LIMITS } from "./analysis-limits.js";
import { plural } from "../run/text.js";
import { containsSensitive } from "../evidence/redaction.js";
import type { AnalysisConfig } from "./types.js";

export const DEFAULT_ANALYSIS_TIMEOUT_MS = 600_000;
const MAX_ANALYSIS_TIMEOUT_MS = 600_000;
export const DEFAULT_ANALYSIS_MODEL = "gpt-6-astra";

interface StudyAnalysisSettings {
  model?: string;
  question?: string;
  timeoutMs?: number;
}
/** The study's review.analysis: a provider selection for a separate review after a live run. */
export type StudyAnalysis = StudyAnalysisSettings &
  (
    | { provider?: "openai"; maxCostUsd: number; maxOutputTokens?: number }
    | { provider: "codex"; maxCostUsd?: null; maxOutputTokens?: null }
  );

const FIELDS = new Set([
  "provider",
  "maxCostUsd",
  "model",
  "question",
  "timeoutMs",
  "maxOutputTokens",
]);

const validTimeout = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_ANALYSIS_TIMEOUT_MS;
/** An absent question is valid; a present one must be a string of at most 4000 characters. */
const validQuestion = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && value.length <= 4000);
const SENSITIVE_QUESTION = {
  ok: false,
  message: "review.analysis.question contains sensitive text and cannot be sent for analysis.",
} as const;

/** The spend cap on an analysis the study did not declare. */
export const DEFAULT_ANALYSIS_MAX_COST_USD = 3;

/** Called for parsed manifests and direct library configs, before participant execution. */
export function resolveAutomaticAnalysis(
  raw: unknown,
):
  | { ok: true; config: AnalysisConfig | undefined; preferLargerOutput?: boolean }
  | { ok: false; message: string } {
  if (raw === false) return { ok: true, config: undefined };
  if (raw === undefined) raw = { maxCostUsd: DEFAULT_ANALYSIS_MAX_COST_USD };
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !FIELDS.has(key))
  ) {
    return {
      ok: false,
      message:
        "review.analysis must be false or a mapping containing only provider, maxCostUsd, model, question, timeoutMs and maxOutputTokens.",
    };
  }
  const value = raw as Record<string, unknown>;
  if (value.provider !== undefined && value.provider !== "openai" && value.provider !== "codex") {
    return { ok: false, message: "review.analysis.provider must be openai or codex." };
  }
  if (value.provider === "codex") {
    const model = value.model === undefined ? CODEX_ANALYSIS_MODEL : value.model;
    const timeoutMs = value.timeoutMs === undefined ? DEFAULT_ANALYSIS_TIMEOUT_MS : value.timeoutMs;
    const question = value.question === undefined ? null : value.question;
    if (
      model !== CODEX_ANALYSIS_MODEL ||
      (value.maxCostUsd !== undefined && value.maxCostUsd !== null) ||
      (value.maxOutputTokens !== undefined && value.maxOutputTokens !== null) ||
      !validTimeout(timeoutMs) ||
      !validQuestion(value.question)
    ) {
      return {
        ok: false,
        message: `Codex analysis requires the qualified ${CODEX_ANALYSIS_MODEL} model and timeoutMs 1–${MAX_ANALYSIS_TIMEOUT_MS}. Dollar and output-token caps are unavailable; omit them. The optional question is limited to 4000 characters.`,
      };
    }
    if (question !== null && containsSensitive(question as string)) return SENSITIVE_QUESTION;
    return {
      ok: true,
      config: {
        provider: "codex",
        model,
        question: question as string | null,
        timeoutMs,
        maxCostUsd: null,
        maxOutputTokens: null,
        identity: codexAnalysisIdentity(model),
      },
    };
  }
  const { maxCostUsd } = value;
  const model = value.model === undefined ? DEFAULT_ANALYSIS_MODEL : value.model;
  const question = value.question === undefined ? null : value.question;
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_ANALYSIS_TIMEOUT_MS : value.timeoutMs;
  const maxOutputTokens =
    value.maxOutputTokens === undefined
      ? DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS
      : value.maxOutputTokens;
  if (
    typeof maxCostUsd !== "number" ||
    !Number.isFinite(maxCostUsd) ||
    maxCostUsd <= 0 ||
    maxCostUsd > 1000 ||
    typeof model !== "string" ||
    !isSupportedAnalysisModel(model) ||
    !validTimeout(timeoutMs) ||
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 256 ||
    maxOutputTokens > MAX_ANALYSIS_OUTPUT_TOKENS ||
    !validQuestion(value.question)
  ) {
    return {
      ok: false,
      message: `review.analysis requires a positive maxCostUsd up to 1000, a supported analysis model, timeoutMs 1–${MAX_ANALYSIS_TIMEOUT_MS}, maxOutputTokens 256–${MAX_ANALYSIS_OUTPUT_TOKENS}, and an optional question of at most 4000 characters.`,
    };
  }
  if (question !== null && containsSensitive(question as string)) return SENSITIVE_QUESTION;
  return {
    ok: true,
    config: {
      ...(value.provider === undefined ? {} : { provider: "openai" as const }),
      model,
      maxCostUsd,
      timeoutMs,
      maxOutputTokens,
      question: question as string | null,
    },
    ...(value.maxOutputTokens === undefined ? { preferLargerOutput: true } : {}),
  };
}

export interface AutomaticAnalysisBudget {
  provider?: "openai" | "codex";
  billing?: "api-estimate" | "account-unknown";
  model: string;
  maxCostUsd: number | null;
  trigger: "default" | "explicit";
  /** The participants the expected cost range is for. */
  participants?: number;
  /**
   * The expected cost of the analysis admission would start, from a run that keeps no evidence to
   * one that keeps the most evidence admission admits, at most the evidence limits.
   */
  expectedCostUsd?: { low: number; high: number };
  /** In place of the range when admission refuses even a run that keeps no evidence: its cost. */
  refusedFromUsd?: number;
}

/** Metadata only: resolving the future live-run budget never reads keys or dispatches. With a
 * participant count it also gives the expected cost range for that many participants. */
export function automaticAnalysisBudget(
  raw: unknown,
  route: StudyRoute,
  participants?: number,
): AutomaticAnalysisBudget | undefined {
  // The synthetic preview has no participants, so nothing is analyzed after it.
  if (route === "preview") return undefined;
  const resolved = resolveAutomaticAnalysis(raw);
  if (!resolved.ok || !resolved.config) return undefined;
  const { config } = resolved;
  const range =
    participants === undefined
      ? undefined
      : analysisCostRange(config, participants, resolved.preferLargerOutput === true);
  return {
    ...(config.provider === "codex"
      ? { provider: "codex" as const, billing: "account-unknown" as const }
      : {}),
    model: config.model,
    maxCostUsd: config.maxCostUsd,
    trigger: raw === undefined ? "default" : "explicit",
    ...(range === undefined || participants === undefined ? {} : { participants, ...range }),
  };
}

/**
 * An analysis's requests in words, from their count: undefined for one request. The plan's
 * analysis line and the dry run's worst case both say it.
 */
export function analysisRequestsText(requests: number): string | undefined {
  return requests <= 1
    ? undefined
    : `${requests - 1} cohort requests of at most ${EVIDENCE_LIMITS.cohortParticipants} participants and one merge request`;
}

export function formatAutomaticAnalysisBudget(budget: AutomaticAnalysisBudget): string {
  if (budget.provider === "codex")
    return `After live runs: Codex account analysis · ${budget.model} · separate restricted analyst with remote inference. Account limits apply; dollar cost and output-token ceiling are unknown. Set review.analysis: false to disable.`;
  const rule = admissionRule(`$${budget.maxCostUsd}`);
  // The participants, and the requests that analyse them when there is more than one.
  const requests = analysisRequestsText(
    analysisRequestCount(Math.min(budget.participants ?? 0, EVIDENCE_LIMITS.participants)),
  );
  const who =
    budget.participants === undefined
      ? undefined
      : `${plural(budget.participants, "participant")}${requests === undefined ? "" : ` in ${requests}`}`;
  const range =
    budget.expectedCostUsd === undefined || who === undefined
      ? ""
      : ` · expected $${budget.expectedCostUsd.low.toFixed(2)} to $${budget.expectedCostUsd.high.toFixed(2)} for ${who}, depending on how much evidence the run keeps`;
  const refused =
    budget.refusedFromUsd === undefined || who === undefined
      ? `refused before it starts if ${rule}`
      : `refused before it starts for ${who} even with no evidence (expected $${budget.refusedFromUsd.toFixed(2)}), since ${rule}`;
  return `After live runs: ${budget.trigger} analysis · ${budget.model}${range} · ${refused}; this is not a billing cap. Set review.analysis: false to disable.`;
}
