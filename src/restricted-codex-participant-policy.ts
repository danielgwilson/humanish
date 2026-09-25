import { z } from "zod";
import { browserControlActionSchema, validateBrowserControlAction } from "./browser-control-protocol.js";
import { validClosingReport, type CuaTurn } from "./computer-use.js";
import type { ActorExecutionProfile, ParticipantClosingReport } from "./actor-contract.js";

export const PARTICIPANT_PROFILE: Readonly<ActorExecutionProfile> = Object.freeze({
  schema: "humanish.actor-execution-profile.v1", transport: "codex-app-server", authentication: "chatgpt-account",
  billing: "account-unknown", requestedModel: "gpt-6-astra", reasoningEffort: "low", cliVersion: "0.154.0",
  toolPolicy: "codex-ui-tools-v1", participantSchema: "humanish.codex-ui-tool.v1", memoryPolicy: "continuing-thread-v1"
});
export const PARTICIPANT_LIMITS = Object.freeze({ instructions: 64 * 1024, hint: 8 * 1024, narration: 2000, output: 256 * 1024, actions: 4, requestMs: 180_000, cleanupMs: 5000 });
const toolInput = z.strictObject({ narration: z.string().max(PARTICIPANT_LIMITS.narration),
  actions: z.array(browserControlActionSchema).min(1).max(PARTICIPANT_LIMITS.actions) });
export const PARTICIPANT_TOOL_SCHEMA = z.toJSONSchema(toolInput, { io: "input" }) as Record<string, unknown>;
export const PARTICIPANT_FINAL_SCHEMA = {
  type: "object", additionalProperties: false, required: ["outcome", "summary", "frictionReports"], properties: {
    outcome: { type: "string", enum: ["reached", "not_reached", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    frictionReports: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 2000 } }
  }
};
/** Humanish tool arguments, validated before the shared executor sees a batch. */
export function parseParticipantTool(value: unknown): CuaTurn {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > PARTICIPANT_LIMITS.output) throw new Error("invalid_response");
  const v = toolInput.parse(value);
  if (Buffer.byteLength(v.narration) > PARTICIPANT_LIMITS.narration) throw new Error("invalid_response");
  return { actions: v.actions.map(validateBrowserControlAction), pendingSafetyChecks: [], done: false,
    ...(v.narration ? { message: v.narration } : {}), providerRequestPending: true };
}
export function parseParticipantFinal(value: unknown): CuaTurn & { closingReport: ParticipantClosingReport } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_response");
  const { outcome, ...report } = value as Record<string, unknown>;
  if ((outcome !== "reached" && outcome !== "not_reached" && outcome !== "blocked") || !validClosingReport(report)) throw new Error("invalid_response");
  return { actions: [], pendingSafetyChecks: [], done: true, outcome,
    message: [report.summary, ...report.frictionReports].join("\n"),
    closingReport: { summary: report.summary, frictionReports: [...report.frictionReports] } };
}
