import { checkRestrictedCodexSessionReadiness, runRestrictedCodexSession, type RestrictedCodexSessionOptions } from "./restricted-codex-session.js";
import type { RestrictedCodexAnalysisErrorCode, RestrictedCodexRequest, RestrictedCodexResult } from "./restricted-codex-policy.js";
export { RESTRICTED_CODEX_ANALYSIS_IDENTITY, RESTRICTED_CODEX_ANALYSIS_MODELS } from "./restricted-codex-policy.js";
export type { RestrictedCodexAnalysisErrorCode } from "./restricted-codex-policy.js";

/** Structurally implements StudyAnalysisProvider without importing its API transport.
 * Schema/evidence validation and transient-secret scrubbing remain in the engine. */
export function createRestrictedCodexAnalysisProvider(options: RestrictedCodexSessionOptions = {}):
  (request: RestrictedCodexRequest) => Promise<RestrictedCodexResult> {
  return request => runRestrictedCodexSession(request, options);
}

/** Does not submit a model turn. Readiness is not a quota/access guarantee. */
export async function checkRestrictedCodexAnalysisReadiness(input: { signal?: AbortSignal; timeoutMs?: number } = {},
  options: RestrictedCodexSessionOptions = {}): Promise<{ ready: boolean; errorCode: RestrictedCodexAnalysisErrorCode | null }> {
  const result = await checkRestrictedCodexSessionReadiness(input, options);
  return { ready: result.status === "completed", errorCode: result.errorCode };
}
