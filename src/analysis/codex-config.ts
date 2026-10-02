import { isRecordedCodexCliVersion } from "../actors/contract.js";
import {
  admitsCodexCliVersion,
  defaultCodexCliVersion,
  supportsIsolatedCodex,
} from "../actors/codex/codex-admission.js";
import {
  RESTRICTED_CODEX_ANALYSIS_IDENTITY,
  RESTRICTED_CODEX_ANALYSIS_MODELS,
} from "../actors/codex/restricted-policy.js";
import type { CodexAnalysisIdentity, AnalysisConfig } from "./types.js";

/** This account route runs the releases codex-admission.ts admits, one model and one tool policy. */
const CODEX_ANALYSIS_TOOL_POLICY = RESTRICTED_CODEX_ANALYSIS_IDENTITY.toolPolicy;
export const CODEX_ANALYSIS_MODEL = RESTRICTED_CODEX_ANALYSIS_MODELS[0];
const CODEX_ANALYSIS_EFFORT = RESTRICTED_CODEX_ANALYSIS_IDENTITY.reasoningEffort;

function identityFor(profile: {
  model: string;
  reasoningEffort: CodexAnalysisIdentity["reasoningEffort"];
  toolPolicy: CodexAnalysisIdentity["toolPolicy"];
  cliVersion: string;
}): CodexAnalysisIdentity {
  return {
    transport: "codex-app-server",
    authentication: "chatgpt-account",
    billing: "account-unknown",
    requestedModel: profile.model,
    resolvedModel: profile.model,
    reasoningEffort: profile.reasoningEffort,
    toolPolicy: profile.toolPolicy,
    cliVersion: profile.cliVersion,
  };
}

/** Before dispatch, analysis replaces the default release with the detected one. */
export function codexAnalysisIdentity(
  model: string,
  cliVersion: string = defaultCodexCliVersion(),
): CodexAnalysisIdentity {
  return identityFor({
    model,
    reasoningEffort: CODEX_ANALYSIS_EFFORT,
    toolPolicy: CODEX_ANALYSIS_TOOL_POLICY,
    cliVersion,
  });
}

function matchesProfile(config: AnalysisConfig, expected: CodexAnalysisIdentity): boolean {
  if (config.provider !== "codex") return false;
  return (
    Object.keys(config).every((key) =>
      [
        "provider",
        "model",
        "question",
        "maxCostUsd",
        "timeoutMs",
        "maxOutputTokens",
        "identity",
      ].includes(key),
    ) &&
    config.model === expected.requestedModel &&
    config.maxCostUsd === null &&
    config.maxOutputTokens === null &&
    config.identity !== undefined &&
    config.identity !== null &&
    typeof config.identity === "object" &&
    Object.keys(config.identity).length === Object.keys(expected).length &&
    Object.entries(expected).every(
      ([key, value]) => config.identity[key as keyof CodexAnalysisIdentity] === value,
    )
  );
}

/** Execution admission: an isolated-mode host, and an identity naming a release the launcher starts. */
export function validCodexAnalysisConfig(
  config: AnalysisConfig,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  if (config.provider !== "codex") return false;
  const cliVersion = config.identity?.cliVersion;
  return (
    config.model === CODEX_ANALYSIS_MODEL &&
    supportsIsolatedCodex(platform, arch) &&
    typeof cliVersion === "string" &&
    admitsCodexCliVersion(cliVersion) &&
    matchesProfile(config, codexAnalysisIdentity(config.model, cliVersion))
  );
}

/**
 * Reading historical artifacts never inserts defaults or selects a launch policy: the restricted
 * analyst's fixed identity, from any recordable release, so a change to launch admission never
 * invalidates a saved report.
 */
export function validStoredCodexAnalysisConfig(config: AnalysisConfig): boolean {
  if (config.provider !== "codex") return false;
  const cliVersion = config.identity?.cliVersion;
  return (
    isRecordedCodexCliVersion(cliVersion) &&
    matchesProfile(
      config,
      identityFor({
        cliVersion,
        toolPolicy: "restricted-codex-v1",
        model: "gpt-6-astra",
        reasoningEffort: "low",
      }),
    )
  );
}
