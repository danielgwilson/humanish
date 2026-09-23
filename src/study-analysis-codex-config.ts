import { RESTRICTED_CODEX_ANALYSIS_IDENTITY, RESTRICTED_CODEX_ANALYSIS_MODELS } from "./restricted-codex-policy.js";
import type { CodexAnalysisIdentity, StudyAnalysisConfig } from "./study-analysis.js";

/** This account route is qualified against one CLI, model and enforced tool policy. */
export const CODEX_ANALYSIS_CLI_VERSION = RESTRICTED_CODEX_ANALYSIS_IDENTITY.cliVersion;
export const CODEX_ANALYSIS_TOOL_POLICY = RESTRICTED_CODEX_ANALYSIS_IDENTITY.toolPolicy;
export const CODEX_ANALYSIS_MODEL = RESTRICTED_CODEX_ANALYSIS_MODELS[0];
export const CODEX_ANALYSIS_EFFORT = RESTRICTED_CODEX_ANALYSIS_IDENTITY.reasoningEffort;

export function codexAnalysisIdentity(model: string): CodexAnalysisIdentity {
  return { transport: "codex-app-server", authentication: "chatgpt-account", billing: "account-unknown",
    requestedModel: model, resolvedModel: model, reasoningEffort: CODEX_ANALYSIS_EFFORT,
    toolPolicy: CODEX_ANALYSIS_TOOL_POLICY, cliVersion: CODEX_ANALYSIS_CLI_VERSION };
}

/** No defaults are inserted when reading historical API artifacts. */
export function validCodexAnalysisConfig(config: StudyAnalysisConfig): boolean {
  if (config.provider !== "codex") return false;
  const expected = codexAnalysisIdentity(config.model);
  return Object.keys(config).every(key => ["provider", "model", "question", "maxCostUsd", "timeoutMs", "maxOutputTokens", "identity"].includes(key))
    && config.model === CODEX_ANALYSIS_MODEL && config.maxCostUsd === null && config.maxOutputTokens === null
    && config.identity !== undefined && config.identity !== null && typeof config.identity === "object" && Object.keys(config.identity).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => config.identity[key as keyof CodexAnalysisIdentity] === value);
}
