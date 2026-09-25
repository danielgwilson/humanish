/** Durable artifact profile. This reader never selects or imports CLI execution policy. */
export function validActorExecutionProfile(value: unknown): boolean {
  const expected = { schema: "humanish.actor-execution-profile.v1", transport: "codex-app-server",
    authentication: "chatgpt-account", billing: "account-unknown", requestedModel: "gpt-6-astra", reasoningEffort: "low",
    cliVersion: "0.154.0", toolPolicy: "restricted-codex-v1", participantSchema: "humanish.restricted-participant-turn.v1",
    memoryPolicy: "recent-eight-16k-v1" };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === Object.keys(expected).length && Object.entries(expected).every(([key, v]) => key === "memoryPolicy"
    ? record[key] === "recent-eight-16k-v1" || record[key] === "continuing-thread-v1" : record[key] === v);
}

/** Closed per-attempt evidence; dollar amounts are never part of account usage. */
export function validActorProviderRequests(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const codes = ["request_rejected", "unavailable", "busy", "refused", "invalid_response", "protocol_error", "timeout", "cancelled", "process_failed", "cleanup_unconfirmed"];
  const phases = ["startup", "initialize", "config/read", "account/read", "thread/start", "mcpServerStatus/list", "turn/start", "response", "cleanup"];
  return value.every((raw: unknown, index) => {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).some(k => !["ordinal", "kind", "dispatched", "usageComplete", "cleanup", "profileVerified", "errorCode", "failurePhase", "usage"].includes(k)) ||
      r.ordinal !== index + 1 || (typeof r.kind !== "string" || !["interaction", "debrief"].includes(r.kind)) ||
      !(typeof r.dispatched === "boolean" || r.dispatched === "unknown") || typeof r.usageComplete !== "boolean" ||
      (typeof r.cleanup !== "string" || !["confirmed", "unconfirmed"].includes(r.cleanup)) || typeof r.profileVerified !== "boolean" ||
      (r.profileVerified && r.dispatched !== true) || (r.errorCode !== undefined && (typeof r.errorCode !== "string" || !codes.includes(r.errorCode))) ||
      (r.failurePhase !== undefined && (r.errorCode === undefined || typeof r.failurePhase !== "string" || !phases.includes(r.failurePhase)))) return false;
    if (r.usage === undefined) return !r.usageComplete;
    if (r.usage === null || typeof r.usage !== "object" || Array.isArray(r.usage)) return false;
    const usage = r.usage as Record<string, unknown>;
    if (Object.entries(usage).some(([k, v]) => !["input", "output", "cachedInput", "cacheWriteInput", "total"].includes(k) ||
      typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)) return false;
    return !r.usageComplete || (typeof usage.input === "number" && typeof usage.output === "number" &&
      ((usage.cachedInput as number | undefined) ?? 0) + ((usage.cacheWriteInput as number | undefined) ?? 0) <= usage.input);
  });
}
