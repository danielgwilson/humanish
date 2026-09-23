import { CODEX_ANALYSIS_MODEL, codexAnalysisIdentity } from "./study-analysis-codex-config.js";
import { SUPPORTED_STUDY_ANALYSIS_MODELS } from "./study-analysis-engine.js";
import { containsSensitive } from "./redaction.js";
import type { StudyAnalysisConfig } from "./study-analysis.js";

export const DEFAULT_ANALYSIS_TIMEOUT_MS = 600_000;
export const DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS = 16_384;

/** An explicit provider selection for a separate review after a live participant study. */
interface LabAnalysisSettings {
  model?: string;
  question?: string;
  timeoutMs?: number;
}
export type LabAnalysis = LabAnalysisSettings & (
  | { provider?: "openai"; maxCostUsd: number; maxOutputTokens?: number }
  | { provider: "codex"; maxCostUsd?: null; maxOutputTokens?: null }
);

const MODELS = new Set<string>(SUPPORTED_STUDY_ANALYSIS_MODELS);
const FIELDS = new Set(["provider", "maxCostUsd", "model", "question", "timeoutMs", "maxOutputTokens"]);

/** Called for parsed manifests AND direct library configs, before participant execution. */
export function resolveAutomaticAnalysis(raw: unknown):
  | { ok: true; config: StudyAnalysisConfig | undefined; preferLargerOutput?: boolean }
  | { ok: false; message: string } {
  if (raw === false) return { ok: true, config: undefined };
  if (raw === undefined) raw = { maxCostUsd: 3 };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !FIELDS.has(key))) {
    return { ok: false, message: "review.analysis must be false or a mapping containing only provider, maxCostUsd, model, question, timeoutMs and maxOutputTokens." };
  }
  const value = raw as Record<string, unknown>;
  if (value.provider !== undefined && value.provider !== "openai" && value.provider !== "codex") {
    return { ok: false, message: "review.analysis.provider must be openai or codex." };
  }
  if (value.provider === "codex") {
    const model = value.model === undefined ? CODEX_ANALYSIS_MODEL : value.model;
    const timeoutMs = value.timeoutMs === undefined ? DEFAULT_ANALYSIS_TIMEOUT_MS : value.timeoutMs;
    const question = value.question === undefined ? null : value.question;
    if (model !== CODEX_ANALYSIS_MODEL || (value.maxCostUsd !== undefined && value.maxCostUsd !== null)
      || (value.maxOutputTokens !== undefined && value.maxOutputTokens !== null)
      || typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
      || (value.question !== undefined && (typeof question !== "string" || question.length > 4000))) {
      return { ok: false, message: "Codex analysis requires the qualified gpt-6-astra model and timeoutMs 1–600000. Dollar and output-token caps are unavailable; omit them. The optional question is limited to 4000 characters." };
    }
    if (question !== null && containsSensitive(question as string)) return { ok: false, message: "review.analysis.question contains sensitive text and cannot be sent for analysis." };
    return { ok: true, config: { provider: "codex", model, question: question as string | null, timeoutMs,
      maxCostUsd: null, maxOutputTokens: null, identity: codexAnalysisIdentity(model) } };
  }
  const { maxCostUsd } = value;
  const model = value.model === undefined ? "gpt-6-astra" : value.model;
  const question = value.question === undefined ? null : value.question;
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_ANALYSIS_TIMEOUT_MS : value.timeoutMs;
  const maxOutputTokens = value.maxOutputTokens === undefined ? DEFAULT_ANALYSIS_MAX_OUTPUT_TOKENS : value.maxOutputTokens;
  if (typeof maxCostUsd !== "number" || !Number.isFinite(maxCostUsd) || maxCostUsd <= 0 || maxCostUsd > 1000
    || typeof model !== "string" || !MODELS.has(model)
    || typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000
    || typeof maxOutputTokens !== "number" || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > 32_768
    || (value.question !== undefined && (typeof question !== "string" || question.length > 4000))) {
    return { ok: false, message: "review.analysis requires a positive maxCostUsd up to 1000, a supported analysis model, timeoutMs 1–600000, maxOutputTokens 256–32768, and an optional question of at most 4000 characters." };
  }
  if (question !== null && containsSensitive(question as string)) {
    return { ok: false, message: "review.analysis.question contains sensitive text and cannot be sent for analysis." };
  }
  return { ok: true, config: { ...(value.provider === undefined ? {} : { provider: "openai" as const }), model, maxCostUsd, timeoutMs, maxOutputTokens, question: question as string | null },
    ...(value.maxOutputTokens === undefined ? { preferLargerOutput: true } : {}) };
}

export interface AutomaticAnalysisBudget {
  provider?: "openai" | "codex";
  billing?: "api-estimate" | "account-unknown";
  model: string;
  maxCostUsd: number | null;
  trigger: "default" | "explicit";
}

/** Metadata only: resolving the future live-run budget never reads keys or dispatches. */
export function automaticAnalysisBudget(raw: unknown, backend: string): AutomaticAnalysisBudget | undefined {
  if (!["cua", "scripted", "terminal", "shared-world", "concurrent-shared-world"].includes(backend)) return undefined;
  const resolved = resolveAutomaticAnalysis(raw);
  return resolved.ok && resolved.config ? { ...(resolved.config.provider === "codex" ? { provider: "codex" as const, billing: "account-unknown" as const } : {}), model: resolved.config.model, maxCostUsd: resolved.config.maxCostUsd,
    trigger: raw === undefined ? "default" : "explicit" } : undefined;
}

export function formatAutomaticAnalysisBudget(budget: AutomaticAnalysisBudget): string {
  if (budget.provider === "codex") return `After live runs: Codex account analysis · ${budget.model} · separate restricted analyst with remote inference. Account limits apply; dollar cost and output-token ceiling are unknown. Set review.analysis: false to disable.`;
  return `After live runs: ${budget.trigger} analysis · ${budget.model} · separate $${budget.maxCostUsd} admission estimate limit (not a provider billing cap). Set review.analysis: false to disable.`;
}
