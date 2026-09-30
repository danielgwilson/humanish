import { RECORDED_CODEX_CLI_VERSIONS } from "../actors/contract.js";
import {
  defaultCodexCliVersion,
  qualifiedCodexCliVersions,
} from "../actors/codex/qualified-versions.js";
import {
  RESTRICTED_CODEX_ANALYSIS_IDENTITY,
  RESTRICTED_CODEX_ANALYSIS_MODELS,
} from "../actors/codex/restricted-policy.js";
import type { CodexAnalysisIdentity, StudyAnalysisConfig } from "./study-analysis.js";

/** This account route is qualified against per-host CLI releases, one model and one tool policy. */
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

/** Reader profiles are append-only. A new launch qualification must not invalidate a saved report. */
const storedProfiles = RECORDED_CODEX_CLI_VERSIONS.map((cliVersion) => ({
  cliVersion,
  toolPolicy: "restricted-codex-v1",
  model: "gpt-6-astra",
  reasoningEffort: "low",
})) as readonly {
  cliVersion: string;
  toolPolicy: "restricted-codex-v1";
  model: "gpt-6-astra";
  reasoningEffort: "low";
}[];

function matchesProfile(config: StudyAnalysisConfig, expected: CodexAnalysisIdentity): boolean {
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

/** Execution admission: the identity must name a release qualified on this host. */
export function validCodexAnalysisConfig(
  config: StudyAnalysisConfig,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  if (config.provider !== "codex") return false;
  const cliVersion = config.identity?.cliVersion;
  return (
    config.model === CODEX_ANALYSIS_MODEL &&
    qualifiedCodexCliVersions(platform, arch).some((version) => version === cliVersion) &&
    matchesProfile(config, codexAnalysisIdentity(config.model, cliVersion))
  );
}

/** Reading historical artifacts never inserts defaults or selects a launch policy. */
export function validStoredCodexAnalysisConfig(config: StudyAnalysisConfig): boolean {
  return storedProfiles.some((profile) => matchesProfile(config, identityFor(profile)));
}
