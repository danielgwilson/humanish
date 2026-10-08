import { z } from "zod";
import { CLOSING_REPORT_LIMITS as LIMITS } from "./closing-report-limits.js";

// What a participant says at the end of a session: the closing report and its impressions. This
// schema is the one description of them. The providers send the JSON Schema made from it, and
// every reply is parsed with it, so a participant is asked for exactly what is accepted.

/**
 * What a participant can say about the product at the end of a session, beyond friction.
 * `unlike_my_work` compares the screen with how the persona does the same task in its own work or
 * life.
 */
const PARTICIPANT_IMPRESSION_KINDS = [
  "unclear",
  "unfinished",
  "untrustworthy",
  "liked",
  "missing",
  "unlike_my_work",
] as const;

/**
 * Text the participant wrote. The JSON Schema carries the length limits; the check that it is not
 * only whitespace runs on the reply.
 */
const said = (maxChars: number) =>
  z
    .string()
    .min(1)
    .max(maxChars)
    .refine((text) => text.trim() !== "");

const impressionSchema = z.strictObject({
  kind: z.enum(PARTICIPANT_IMPRESSION_KINDS),
  text: said(LIMITS.impressionChars),
});

/** The impressions a participant gave; an empty list means it had none. */
export const participantImpressionsSchema = z.array(impressionSchema).max(LIMITS.impressions);

/**
 * A closing report. A report without impressions is still valid: third-party provider ports and
 * stored traces do not have them.
 */
export const closingReportSchema = z.strictObject({
  summary: said(LIMITS.summaryChars),
  frictionReports: z.array(said(LIMITS.frictionReportChars)).max(LIMITS.frictionReports),
  impressions: participantImpressionsSchema.optional(),
});

/** The reply to an impressions-only request: the impressions and nothing else. */
export const impressionsReplySchema = z.strictObject({
  impressions: participantImpressionsSchema,
});

/** The participant's account, not an independently confirmed product diagnosis. */
export type ParticipantClosingReport = z.infer<typeof closingReportSchema>;

/** One first-person impression about something the participant saw in the session. */
export type ParticipantImpression = z.infer<typeof impressionSchema>;

/**
 * The JSON Schema a strict structured-output request sends for `schema`. Strict mode needs every
 * field, so optional ones become required. `$schema` is left out, so the request carries only
 * keywords both providers' strict modes are known to accept.
 */
export function strictOutputSchema(schema: z.ZodObject): Record<string, unknown> {
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema.required(), { io: "input" });
  return json;
}
