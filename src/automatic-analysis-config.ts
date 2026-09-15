import { SUPPORTED_STUDY_ANALYSIS_MODELS } from "./study-analysis-engine.js";
import { containsSensitive } from "./redaction.js";
import type { StudyAnalysisConfig } from "./study-analysis.js";

/** A separately budgeted review after a live participant study. */
export interface LabAnalysis {
  maxCostUsd: number;
  model?: string;
  question?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

const MODELS = new Set<string>(SUPPORTED_STUDY_ANALYSIS_MODELS);
const FIELDS = new Set(["maxCostUsd", "model", "question", "timeoutMs", "maxOutputTokens"]);

/** Called for parsed manifests AND direct library configs, before participant execution. */
export function resolveAutomaticAnalysis(raw: unknown):
  | { ok: true; config: StudyAnalysisConfig | undefined }
  | { ok: false; message: string } {
  if (raw === false) return { ok: true, config: undefined };
  if (raw === undefined) raw = { maxCostUsd: 3 };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).some(key => !FIELDS.has(key))) {
    return { ok: false, message: "review.analysis must be false or a mapping containing only maxCostUsd, model, question, timeoutMs and maxOutputTokens." };
  }
  const value = raw as Record<string, unknown>;
  const { maxCostUsd } = value;
  const model = value.model === undefined ? "gpt-6-astra" : value.model;
  const question = value.question === undefined ? null : value.question;
  const timeoutMs = value.timeoutMs === undefined ? 300_000 : value.timeoutMs;
  const maxOutputTokens = value.maxOutputTokens === undefined ? 16_384 : value.maxOutputTokens;
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
  return { ok: true, config: { model, maxCostUsd, timeoutMs, maxOutputTokens, question: question as string | null } };
}

export interface AutomaticAnalysisBudget {
  model: string;
  maxCostUsd: number;
  trigger: "default" | "explicit";
}

/** Metadata only: resolving the future live-run budget never reads keys or dispatches. */
export function automaticAnalysisBudget(raw: unknown, backend: string): AutomaticAnalysisBudget | undefined {
  if (!["cua", "scripted", "terminal", "shared-world", "concurrent-shared-world"].includes(backend)) return undefined;
  const resolved = resolveAutomaticAnalysis(raw);
  return resolved.ok && resolved.config ? { model: resolved.config.model, maxCostUsd: resolved.config.maxCostUsd,
    trigger: raw === undefined ? "default" : "explicit" } : undefined;
}

export function formatAutomaticAnalysisBudget(budget: AutomaticAnalysisBudget): string {
  return `After live runs: ${budget.trigger} analysis · ${budget.model} · separate $${budget.maxCostUsd} admission estimate limit (not a provider billing cap). Set review.analysis: false to disable.`;
}
