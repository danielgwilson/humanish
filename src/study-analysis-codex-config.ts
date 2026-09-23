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

/** Reader profiles are append-only. A new launch qualification must not invalidate a saved report. */
const storedProfiles = [{ cliVersion: "0.154.0", toolPolicy: "restricted-codex-v1", model: "gpt-6-astra", reasoningEffort: "low" }] as const;

function matchesProfile(config: StudyAnalysisConfig, expected: CodexAnalysisIdentity): boolean {
  if (config.provider !== "codex") return false;
  return Object.keys(config).every(key => ["provider", "model", "question", "maxCostUsd", "timeoutMs", "maxOutputTokens", "identity"].includes(key))
    && config.model === expected.requestedModel && config.maxCostUsd === null && config.maxOutputTokens === null
    && config.identity !== undefined && config.identity !== null && typeof config.identity === "object" && Object.keys(config.identity).length === Object.keys(expected).length
    && Object.entries(expected).every(([key, value]) => config.identity[key as keyof CodexAnalysisIdentity] === value);
}

/** Execution admission uses only the currently qualified launcher profile. */
export function validCodexAnalysisConfig(config: StudyAnalysisConfig): boolean {
  return config.model === CODEX_ANALYSIS_MODEL && matchesProfile(config, codexAnalysisIdentity(config.model));
}

/** Reading historical artifacts never inserts defaults or selects a launch policy. */
export function validStoredCodexAnalysisConfig(config: StudyAnalysisConfig): boolean {
  return storedProfiles.some(profile => matchesProfile(config, {
    transport: "codex-app-server", authentication: "chatgpt-account", billing: "account-unknown",
    requestedModel: profile.model, resolvedModel: profile.model, reasoningEffort: profile.reasoningEffort,
    toolPolicy: profile.toolPolicy, cliVersion: profile.cliVersion
  }));
}
