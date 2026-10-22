// The models each API analyst runs, and the reasoning efforts each model accepts. Config parsing,
// admission, the CLI help and the wire formats all read this one table.

import type { ReasoningEffort } from "../actors/reasoning-effort.js";
import type { AnalysisApiVendor } from "./provider.js";
import type { AnalysisConfig } from "./types.js";

/**
 * `reasoning.effort` values from each model's page under developers.openai.com/api/docs/models
 * (read 2026-10-21). None of them lists `minimal`; gpt-6-astra and gpt-6.1-sol also refuse `none`.
 */
const OPENAI_MODELS = {
  "gpt-6-astra": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
  "gpt-6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.6": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
} as const satisfies Record<string, readonly ReasoningEffort[]>;

/**
 * Gemini models that completed a live analysis, with the `thinkingLevel` values the thinking guide
 * lists for each (ai.google.dev/gemini-api/docs/generate-content/thinking, read 2026-10-21):
 * gemini-3.8-flash answers `minimal` with an error. Each model's page under
 * ai.google.dev/gemini-api/docs/models also lists image input and JSON-schema output for
 * gemini-3.5-flash-lite, gemini-3-flash-preview and gemini-4-argon; they join this table once a
 * live analysis on each completes.
 */
const GEMINI_MODELS = {
  "gemini-3.8-flash": ["low", "medium", "high"],
} as const satisfies Record<string, readonly ReasoningEffort[]>;

const MODELS: Readonly<
  Record<AnalysisApiVendor, Readonly<Record<string, readonly ReasoningEffort[]>>>
> = { openai: OPENAI_MODELS, gemini: GEMINI_MODELS };

export const SUPPORTED_ANALYSIS_MODELS = Object.freeze(Object.keys(OPENAI_MODELS));
export const GEMINI_ANALYSIS_MODELS = Object.freeze(Object.keys(GEMINI_MODELS));

/** Whether the API analyst `provider` (omitted is OpenAI) analyzes with `model`. */
export const isSupportedAnalysisModel = (
  model: string,
  provider: AnalysisApiVendor = "openai",
): boolean => Object.hasOwn(MODELS[provider], model);

/** The reasoning efforts `model` accepts from `provider`, least first; empty for an unknown model. */
export const analysisEfforts = (
  model: string,
  provider: AnalysisApiVendor = "openai",
): readonly ReasoningEffort[] =>
  Object.hasOwn(MODELS[provider], model) ? MODELS[provider][model]! : [];

/**
 * The effort an API analysis runs at when its configuration declares none. Every saved analysis
 * without `reasoningEffort` ran at this effort, so it stays high: a different default must be
 * written into the configuration it resolves, where it also changes the configuration's hash.
 */
const UNDECLARED_EFFORT = "high" satisfies ReasoningEffort;

/** The effort an analysis runs at: the declared one, high for an API analysis that declares none,
 * and the Codex account's fixed effort. */
export function analysisEffort(config: AnalysisConfig): ReasoningEffort {
  if (config.provider === "codex") return config.identity.reasoningEffort;
  return config.reasoningEffort ?? UNDECLARED_EFFORT;
}
