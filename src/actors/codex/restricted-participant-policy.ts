import { z } from "zod";
import {
  BROWSER_CONTROL_LIMITS,
  browserControlActionSchema,
  browserOnlyControlActionSchema,
  validateBrowserControlAction,
} from "../../browser-control/protocol.js";
import { validClosingReport, type CuaTurn, type ShortenedWait } from "../computer-use/loop.js";
import type { ActorExecutionProfile, ParticipantClosingReport } from "../contract.js";

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
  /** The longest wait one action lasts; a longer one is shortened to it. */
  waitMs: BROWSER_CONTROL_LIMITS.waitMs,
  requestMs: 180_000,
  cleanupMs: 5000,
});
const toolInput = (speechEnabled: boolean) =>
  z.strictObject({
    narration: z.string().max(PARTICIPANT_LIMITS.narration),
    actions: z
      .array(speechEnabled ? browserControlActionSchema : browserOnlyControlActionSchema)
      .min(1)
      .max(PARTICIPANT_LIMITS.actions),
  });
export function participantToolSchema(speechEnabled = false): Record<string, unknown> {
  return z.toJSONSchema(toolInput(speechEnabled), { io: "input" }) as Record<string, unknown>;
}
export const PARTICIPANT_TOOL_SCHEMA = participantToolSchema();
export const PARTICIPANT_FINAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "summary", "frictionReports"],
  properties: {
    outcome: { type: "string", enum: ["reached", "not_reached", "blocked"] },
    summary: { type: "string", minLength: 1, maxLength: 4000 },
    frictionReports: {
      type: "array",
      maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 2000 },
    },
  },
};
/**
 * Shorten each wait longer than one browser-control request may wait. A failed tool call ends the
 * native run, so a wait that asks too much would otherwise end the whole session.
 */
function shortenWaits(value: unknown): { value: unknown; shortened: ShortenedWait[] } {
  const actions = (value as { actions?: unknown } | null)?.actions;
  if (typeof value !== "object" || !Array.isArray(actions)) return { value, shortened: [] };
  const shortened: ShortenedWait[] = [];
  const limit = PARTICIPANT_LIMITS.waitMs;
  const next = actions.map((action: unknown, index) => {
    const wait = action as { kind?: unknown; ms?: unknown } | null;
    if (
      wait?.kind !== "wait" ||
      typeof wait.ms !== "number" ||
      !Number.isFinite(wait.ms) ||
      wait.ms <= limit
    )
      return action;
    shortened.push({ index, requestedMs: wait.ms, ms: limit });
    return { ...wait, ms: limit };
  });
  return shortened.length === 0
    ? { value, shortened }
    : { value: { ...value, actions: next }, shortened };
}

/** humanish tool arguments, validated before the shared executor sees a batch. */
export function parseParticipantTool(value: unknown, speechEnabled = false): CuaTurn {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > PARTICIPANT_LIMITS.output)
    throw new Error("invalid_response");
  const { value: admitted, shortened } = shortenWaits(value);
  const v = toolInput(speechEnabled).parse(admitted);
  if (Buffer.byteLength(v.narration) > PARTICIPANT_LIMITS.narration)
    throw new Error("invalid_response");
  return {
    actions: v.actions.map(validateBrowserControlAction),
    ...(shortened.length === 0 ? {} : { shortenedWaits: shortened }),
    pendingSafetyChecks: [],
    done: false,
    ...(v.narration ? { message: v.narration } : {}),
    providerRequestPending: true,
  };
}
export function parseParticipantFinal(
  value: unknown,
): CuaTurn & { closingReport: ParticipantClosingReport } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_response");
  const { outcome, ...report } = value as Record<string, unknown>;
  if (
    (outcome !== "reached" && outcome !== "not_reached" && outcome !== "blocked") ||
    !validClosingReport(report)
  )
    throw new Error("invalid_response");
  return {
    actions: [],
    pendingSafetyChecks: [],
    done: true,
    outcome,
    message: [report.summary, ...report.frictionReports].join("\n"),
    closingReport: { summary: report.summary, frictionReports: [...report.frictionReports] },
  };
}
