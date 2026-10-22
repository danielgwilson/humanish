import type { StudyRoute } from "../study/plan.js";
import { CODEX_ANALYSIS_MODEL, codexAnalysisIdentity } from "./codex-config.js";
import {
  DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS,
  MAX_ANALYSIS_OUTPUT_TOKENS,
  analysisCostRange,
} from "./execute.js";
import { analysisEffort, analysisEfforts, isSupportedAnalysisModel } from "./models.js";
import { isReasoningEffort, type ReasoningEffort } from "../actors/reasoning-effort.js";
import { admissionRule } from "./admission.js";
import { analysisRequestCount, EVIDENCE_LIMITS } from "./analysis-limits.js";
import { plural } from "../run/text.js";
import { scanEncodedText } from "../evidence/encoded-text.js";
import type { AnalysisConfig } from "./types.js";

export const DEFAULT_ANALYSIS_TIMEOUT_MS = 600_000;
const MAX_ANALYSIS_TIMEOUT_MS = 600_000;
/** The OpenAI analyst a study or command gets when it names no model. */
export const DEFAULT_ANALYSIS_MODEL = "gpt-6.1-sol";
/**
 * The effort the default OpenAI analyst runs at when no effort is declared. A named model without
 * an effort runs at high (models.ts), so a study that names its model keeps its configuration hash.
 */
export const DEFAULT_ANALYSIS_EFFORT = "medium" satisfies ReasoningEffort;
/** The model a Gemini analysis uses when the study or command names none: Google's current
 * stable Flash model. */
export const DEFAULT_GEMINI_ANALYSIS_MODEL = "gemini-3.8-flash";

interface StudyAnalysisSettings {
  model?: string;
  question?: string;
  timeoutMs?: number;
}
/** The study's review.analysis: a provider selection for a separate review after a live run. */
export type StudyAnalysis = StudyAnalysisSettings &
  (
    | {
        provider?: "openai" | "gemini";
        maxCostUsd: number;
        maxOutputTokens?: number;
        reasoningEffort?: ReasoningEffort;
      }
    | { provider: "codex"; maxCostUsd?: null; maxOutputTokens?: null; reasoningEffort?: never }
  );

const FIELDS = new Set([
  "provider",
  "maxCostUsd",
  "model",
  "question",
  "timeoutMs",
  "maxOutputTokens",
  "reasoningEffort",
]);

const validTimeout = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_ANALYSIS_TIMEOUT_MS;
/** An absent question is valid; a present one must be a string of at most 4000 characters. */
const validQuestion = (value: unknown): boolean =>
  value === undefined || (typeof value === "string" && value.length <= 4000);
// The provider receives the question and analysis.json keeps it. verify reads that file as written
// and decoded, so the question is refused when scanEncodedText reads a secret in it.
const SENSITIVE_QUESTION = {
  ok: false,
  message: "review.analysis.question contains sensitive text and cannot be sent for analysis.",
} as const;

/** The spend cap on an OpenAI analysis the study did not declare. */
export const DEFAULT_ANALYSIS_MAX_COST_USD = 10;

/** The study's participant, which picks the analyst when the study declares none. */
export interface AnalysisParticipant {
  readonly type?: string;
  readonly localAgent?: "codex" | "claude";
}

/**
 * The analysis a study gets when it declares none. A Codex local-agent participant signs in with a
 * ChatGPT account and needs no API key, so its run is analyzed by the same account; every other
 * participant gets the OpenAI analyst under the default cap. A Claude participant stays on OpenAI:
 * moving it to the Codex account because OPENAI_API_KEY is missing would bill an account the study
 * never named.
 */
function undeclaredAnalysis(participant: AnalysisParticipant | undefined): StudyAnalysis {
  return participant?.type === "local-agent" && (participant.localAgent ?? "codex") === "codex"
    ? { provider: "codex" }
    : { maxCostUsd: DEFAULT_ANALYSIS_MAX_COST_USD };
}

/**
 * Called for parsed manifests and direct library configs, before participant execution. An
 * undefined `raw` is the study's default, chosen by its participant (the study's `actor`).
 */
export function resolveAutomaticAnalysis(
  raw: unknown,
  participant?: AnalysisParticipant,
):
  | { ok: true; config: AnalysisConfig | undefined; preferLargerOutput?: boolean }
  | { ok: false; message: string } {
  if (raw === false) return { ok: true, config: undefined };
  if (raw === undefined) raw = undeclaredAnalysis(participant);
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !FIELDS.has(key))
  ) {
    return {
      ok: false,
      message:
        "review.analysis must be false or a mapping containing only provider, maxCostUsd, model, question, timeoutMs, maxOutputTokens and reasoningEffort.",
    };
  }
  const value = raw as Record<string, unknown>;
  if (
    value.provider !== undefined &&
    value.provider !== "openai" &&
    value.provider !== "gemini" &&
    value.provider !== "codex"
  ) {
    return { ok: false, message: "review.analysis.provider must be openai, gemini or codex." };
  }
  if (value.provider === "codex") {
    if (value.reasoningEffort !== undefined)
      return {
        ok: false,
        message:
          "Codex account analysis runs at its fixed low reasoning effort, so it takes no reasoningEffort. Omit it, or choose provider openai or gemini to set one.",
      };
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
    if (question !== null && scanEncodedText(question as string).sensitive)
      return SENSITIVE_QUESTION;
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
  const vendor = value.provider === "gemini" ? "gemini" : "openai";
  const model =
    value.model !== undefined
      ? value.model
      : vendor === "gemini"
        ? DEFAULT_GEMINI_ANALYSIS_MODEL
        : DEFAULT_ANALYSIS_MODEL;
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
    !isSupportedAnalysisModel(model, vendor) ||
    !validTimeout(timeoutMs) ||
    typeof maxOutputTokens !== "number" ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens < 256 ||
    maxOutputTokens > MAX_ANALYSIS_OUTPUT_TOKENS ||
    !validQuestion(value.question)
  ) {
    return {
      ok: false,
      message: `review.analysis requires a positive maxCostUsd up to 1000, a supported ${vendor === "gemini" ? "Gemini" : "OpenAI"} analysis model, timeoutMs 1–${MAX_ANALYSIS_TIMEOUT_MS}, maxOutputTokens 256–${MAX_ANALYSIS_OUTPUT_TOKENS}, and an optional question of at most 4000 characters.`,
    };
  }
  // Only the default model gets the default effort, written out because an omitted effort is high.
  const reasoningEffort =
    value.reasoningEffort === undefined && value.model === undefined && vendor === "openai"
      ? DEFAULT_ANALYSIS_EFFORT
      : value.reasoningEffort;
  const efforts = analysisEfforts(model, vendor);
  if (
    reasoningEffort !== undefined &&
    (!isReasoningEffort(reasoningEffort) || !efforts.includes(reasoningEffort))
  )
    return {
      ok: false,
      message: `review.analysis.reasoningEffort for ${model} must be ${efforts.slice(0, -1).join(", ")} or ${efforts.at(-1)}, the efforts its provider documents for it.`,
    };
  if (question !== null && scanEncodedText(question as string).sensitive) return SENSITIVE_QUESTION;
  return {
    ok: true,
    config: {
      // An omitted provider, or an omitted effort on a named model, stays omitted, so the
      // configuration keeps the hash it had before the field existed. An omitted provider is the
      // OpenAI contract.
      ...(value.provider === undefined ? {} : { provider: vendor }),
      model,
      maxCostUsd,
      timeoutMs,
      maxOutputTokens,
      question: question as string | null,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
    ...(value.maxOutputTokens === undefined ? { preferLargerOutput: true } : {}),
  };
}

export interface AutomaticAnalysisBudget {
  provider?: "openai" | "gemini" | "codex";
  billing?: "api-estimate" | "account-unknown";
  model: string;
  /** The reasoning effort the analysis runs at. */
  effort: ReasoningEffort;
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
 * participant count it also gives the expected cost range for that many participants, and with the
 * study's participant it resolves an undeclared analysis the way the run will. */
export function automaticAnalysisBudget(
  raw: unknown,
  route: StudyRoute,
  participants?: number,
  participant?: AnalysisParticipant,
): AutomaticAnalysisBudget | undefined {
  // The synthetic preview has no participants, so nothing is analyzed after it.
  if (route === "preview") return undefined;
  const resolved = resolveAutomaticAnalysis(raw, participant);
  if (!resolved.ok || !resolved.config) return undefined;
  const { config } = resolved;
  const range =
    participants === undefined
      ? undefined
      : analysisCostRange(config, participants, resolved.preferLargerOutput === true);
  return {
    ...(config.provider === "codex"
      ? { provider: "codex" as const, billing: "account-unknown" as const }
      : config.provider === "gemini"
        ? { provider: "gemini" as const }
        : {}),
    model: config.model,
    effort: analysisEffort(config),
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
    return `After live runs: ${budget.trigger === "default" ? "default " : ""}Codex account analysis · ${budget.model} at ${budget.effort} effort · separate restricted analyst with remote inference. Account limits apply; dollar cost and output-token ceiling are unknown. Set review.analysis: false to disable.`;
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
  const where =
    budget.provider === "gemini" ? " on Gemini, which sends the evidence to Google" : "";
  return `After live runs: ${budget.trigger} analysis${where} · ${budget.model} at ${budget.effort} effort${range} · ${refused}; this is not a billing cap. Set review.analysis: false to disable.`;
}
