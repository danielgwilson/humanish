import {
  checkRestrictedCodexSessionReadiness,
  detectRestrictedCodexCliVersion,
  runRestrictedCodexSession,
  type RestrictedCodexSessionOptions,
} from "../actors/codex/restricted-session.js";
import type { AnalysisConfig } from "./types.js";
import type {
  RestrictedCodexAnalysisErrorCode,
  RestrictedCodexRequest,
  RestrictedCodexResult,
} from "../actors/codex/restricted-policy.js";

/** Structurally implements AnalysisProvider without importing its API transport.
 * Schema/evidence validation and transient-secret scrubbing remain in runAnalysis. */
export function createRestrictedCodexAnalysisProvider(
  options: RestrictedCodexSessionOptions = {},
): (request: RestrictedCodexRequest) => Promise<RestrictedCodexResult> {
  return (request) => runRestrictedCodexSession(request, options);
}

/**
 * Record the installed release in a Codex identity when this host qualifies it. If detection
 * fails, the requested identity stays and the launcher refuses that dispatch with its usual code.
 */
export async function bindCodexAnalysisCliVersion(
  config: AnalysisConfig,
  detect: () => Promise<string | null> = async () =>
    (await detectRestrictedCodexCliVersion()).cliVersion,
): Promise<AnalysisConfig> {
  if (config.provider !== "codex") return config;
  const cliVersion = await detect();
  return cliVersion === null || cliVersion === config.identity.cliVersion
    ? config
    : { ...config, identity: { ...config.identity, cliVersion } };
}

/** Does not submit a model turn. Readiness is not a quota/access guarantee. */
export async function checkRestrictedCodexAnalysisReadiness(
  input: { signal?: AbortSignal; timeoutMs?: number } = {},
  options: RestrictedCodexSessionOptions = {},
): Promise<{ ready: boolean; errorCode: RestrictedCodexAnalysisErrorCode | null }> {
  const result = await checkRestrictedCodexSessionReadiness(input, options);
  return { ready: result.status === "completed", errorCode: result.errorCode };
}
