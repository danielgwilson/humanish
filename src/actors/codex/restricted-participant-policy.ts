import { z } from "zod";
import {
  participantActionSchema,
  participantSpeechActionSchema,
} from "../../browser-control/protocol.js";
import {
  closingReportSchema,
  strictOutputSchema,
  type ParticipantClosingReport,
} from "../closing-report.js";
import type { CuaTurn } from "../computer-use/loop.js";
import type { ActorExecutionProfile } from "../contract.js";

/** The declared profile. A participant replaces cliVersion with its detected CLI release, or with
 * this host's newest qualified release before its first launch. */
export const PARTICIPANT_PROFILE: Readonly<ActorExecutionProfile> = Object.freeze({
  schema: "humanish.actor-execution-profile.v1",
  transport: "codex-app-server",
  authentication: "chatgpt-account",
  billing: "account-unknown",
  requestedModel: "gpt-6-astra",
  reasoningEffort: "low",
  cliVersion: "0.154.0",
  toolPolicy: "codex-ui-tools-v1",
  participantSchema: "humanish.codex-ui-tool.v1",
  memoryPolicy: "continuing-thread-v1",
});
export const PARTICIPANT_LIMITS = Object.freeze({
  instructions: 64 * 1024,
  hint: 8 * 1024,
  narration: 2000,
  output: 256 * 1024,
  actions: 4,
  requestMs: 180_000,
  cleanupMs: 5000,
});
const toolInput = (speechEnabled: boolean) =>
  z.strictObject({
    narration: z.string().max(PARTICIPANT_LIMITS.narration),
    actions: z
      .array(speechEnabled ? participantSpeechActionSchema : participantActionSchema)
      .min(1)
      .max(PARTICIPANT_LIMITS.actions),
  });
export function participantToolSchema(speechEnabled = false): Record<string, unknown> {
  return z.toJSONSchema(toolInput(speechEnabled), { io: "input" }) as Record<string, unknown>;
}
export const PARTICIPANT_TOOL_SCHEMA = participantToolSchema();
/** The participant's final account: how the task went, then its closing report. */
const participantFinal = z.strictObject({
  outcome: z.enum(["reached", "not_reached", "blocked"]),
  ...closingReportSchema.shape,
});
export const PARTICIPANT_FINAL_SCHEMA = strictOutputSchema(participantFinal);
/** humanish tool arguments, validated before the shared executor sees a batch. */
export function parseParticipantTool(value: unknown, speechEnabled = false): CuaTurn {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > PARTICIPANT_LIMITS.output)
    throw new Error("invalid_response");
  const v = toolInput(speechEnabled).parse(value);
  if (Buffer.byteLength(v.narration) > PARTICIPANT_LIMITS.narration)
    throw new Error("invalid_response");
  return {
    actions: v.actions,
    pendingSafetyChecks: [],
    done: false,
    ...(v.narration ? { message: v.narration } : {}),
    providerRequestPending: true,
  };
}
export function parseParticipantFinal(
  value: unknown,
): CuaTurn & { closingReport: ParticipantClosingReport } {
  const final = participantFinal.safeParse(value);
  if (!final.success) throw new Error("invalid_response");
  const { outcome, ...closingReport } = final.data;
  return {
    actions: [],
    pendingSafetyChecks: [],
    done: true,
    outcome,
    message: [closingReport.summary, ...closingReport.frictionReports].join("\n"),
    closingReport,
  };
}
