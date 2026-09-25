import { z } from "zod";
import { browserControlActionSchema, validateBrowserControlAction } from "./browser-control-protocol.js";
import { validClosingReport, type CuaTurn } from "./computer-use.js";
import type { ActorExecutionProfile, ParticipantClosingReport } from "./actor-contract.js";

export const PARTICIPANT_PROFILE: Readonly<ActorExecutionProfile> = Object.freeze({
  schema: "humanish.actor-execution-profile.v1", transport: "codex-app-server", authentication: "chatgpt-account",
  billing: "account-unknown", requestedModel: "gpt-6-astra", reasoningEffort: "low", cliVersion: "0.154.0",
  toolPolicy: "restricted-codex-v1", participantSchema: "humanish.restricted-participant-turn.v1", memoryPolicy: "continuing-thread-v1"
});
export const PARTICIPANT_LIMITS = Object.freeze({ instructions: 64 * 1024, hint: 8 * 1024, narration: 2000, output: 256 * 1024, actions: 4, requestMs: 180_000, cleanupMs: 5000 });
const envelope = z.strictObject({ schema: z.literal(PARTICIPANT_PROFILE.participantSchema),
  narration: z.string().max(PARTICIPANT_LIMITS.narration), done: z.boolean(),
  outcome: z.enum(["reached", "not_reached", "blocked"]).nullable(),
  actions: z.array(browserControlActionSchema).max(PARTICIPANT_LIMITS.actions) });
/** Strict structured output requires all object keys. Null selects the existing
 * executor default for click.button/wait.ms; it is never a new browser action. */
function outputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(outputSchema);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$schema")
    .map(([key, v]) => [key === "oneOf" ? "anyOf" : key, outputSchema(v)]));
  if (result.type === "object" && result.properties) {
    const properties = result.properties as Record<string, unknown>;
    const required = result.required as string[];
    for (const key of Object.keys(properties)) if (!required.includes(key)) properties[key] = { anyOf: [properties[key], { type: "null" }] };
    result.required = Object.keys(properties);
  }
  return result;
}
export const PARTICIPANT_TURN_SCHEMA = outputSchema(z.toJSONSchema(envelope, { io: "input" })) as Record<string, unknown>;
export const PARTICIPANT_CLOSING_SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "frictionReports"], properties: {
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    frictionReports: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 2000 } }
  }
};
/** Humanish output schema, not a provider-wire parser. Reject the whole proposal. */
export function parseParticipantTurn(value: unknown): CuaTurn {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > PARTICIPANT_LIMITS.output) throw new Error("invalid_response");
  const source = value as Record<string, unknown> | null;
  const normalized = source && Array.isArray(source.actions) ? { ...source, actions: source.actions.map((action: unknown) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return action;
    const result = { ...action } as Record<string, unknown>;
    if (result.kind === "click" && result.button === null) delete result.button;
    if (result.kind === "wait" && result.ms === null) delete result.ms;
    return result;
  }) } : value;
  const v = envelope.parse(normalized);
  if (Buffer.byteLength(v.narration) > PARTICIPANT_LIMITS.narration ||
    (v.done ? v.actions.length !== 0 || v.outcome === null || !v.narration.trim() : v.actions.length === 0 || v.outcome !== null)) {
    throw new Error("invalid_response");
  }
  return { actions: v.actions.map(validateBrowserControlAction), pendingSafetyChecks: [], done: v.done,
    ...(v.narration ? { message: v.narration } : {}), ...(v.outcome === null ? {} : { outcome: v.outcome }) };
}
export function parseParticipantClosing(value: unknown): ParticipantClosingReport {
  if (!validClosingReport(value)) throw new Error("invalid_response");
  return { summary: value.summary, frictionReports: [...value.frictionReports] };
}
