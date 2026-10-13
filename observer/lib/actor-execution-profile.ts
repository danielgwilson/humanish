/**
 * The oldest Codex CLI release a recorded account profile may name. Readers accept every stable
 * `MAJOR.MINOR.PATCH` release from it on, so a saved bundle stays readable whichever release
 * recorded it; this copy of src/actors/contract.ts's reader imports no launch policy.
 */
const RECORDED_CODEX_CLI_FLOOR = "0.154.0";
/** A stable release at or above the floor. Parts compare as digit strings, exact at any length. */
export function isRecordedCodexCliVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    return false;
  const release = value.split("."),
    floor = RECORDED_CODEX_CLI_FLOOR.split(".");
  for (const [index, part] of release.entries()) {
    const order =
      part.length - floor[index]!.length ||
      (part === floor[index] ? 0 : part > floor[index]! ? 1 : -1);
    if (order !== 0) return order > 0;
  }
  return true;
}

/** Durable artifact profile. This reader never selects or imports CLI execution policy. */
export function validActorExecutionProfile(value: unknown): boolean {
  const expected = {
    schema: "humanish.actor-execution-profile.v1",
    transport: "codex-app-server",
    authentication: "chatgpt-account",
    billing: "account-unknown",
  };
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== Object.keys(expected).length + 6 ||
    !Object.entries(expected).every(([key, expectedValue]) => record[key] === expectedValue)
  )
    return false;
  // Only 0.154.0 produced the legacy structured-action profile.
  const legacy =
    record.cliVersion === "0.154.0" &&
    record.requestedModel === "gpt-6-astra" &&
    record.reasoningEffort === "low" &&
    record.toolPolicy === "restricted-codex-v1" &&
    record.participantSchema === "humanish.restricted-participant-turn.v1" &&
    (record.memoryPolicy === "recent-eight-16k-v1" ||
      record.memoryPolicy === "continuing-thread-v1");
  const uiTools =
    isRecordedCodexCliVersion(record.cliVersion) &&
    typeof record.requestedModel === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(record.requestedModel) &&
    typeof record.reasoningEffort === "string" &&
    ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(record.reasoningEffort) &&
    record.toolPolicy === "codex-ui-tools-v1" &&
    record.participantSchema === "humanish.codex-ui-tool.v1" &&
    record.memoryPolicy === "continuing-thread-v1";
  return legacy || uiTools;
}
