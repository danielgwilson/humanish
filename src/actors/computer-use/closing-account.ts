import type { CuaTurn } from "./loop.js";
import {
  closingReportSchema,
  impressionsReplySchema,
  strictOutputSchema,
} from "../closing-report.js";

// The participant's closing account, as every API provider asks for it and reads it: the JSON
// Schema of each closing request, the words that state it in the request, and the account a
// reply's text gives. Each vendor's conversation wraps the schema in its own output-format field.

/**
 * What a closing request asks for: the closing report after a harness-owned stop, or only
 * impressions after the participant ended the session itself.
 */
export type ClosingRequest = "report" | "impressions";

/** The JSON Schema the strict closing request sets for `closing`. */
export function closingSchema(closing: ClosingRequest): Record<string, unknown> {
  return strictOutputSchema(closing === "report" ? closingReportSchema : impressionsReplySchema);
}

/**
 * What form a closing reply takes, said in the request itself: an output-format field would
 * change the cached prefix, so the first closing request states the schema the strict retry sets.
 */
export function replyFormText(closing: ClosingRequest): string {
  return `Reply with only a JSON object that matches this JSON Schema, with no other text: ${JSON.stringify(closingSchema(closing))}`;
}

/**
 * The account a closing reply's text gives: JSON the request's schema accepts, or none. A reply
 * sent without an output format must give every field the stated schema requires. With one the
 * provider holds the reply to that schema, and the check is the one any provider's report gets.
 */
export function closingAccount(
  message: string | undefined,
  closing: ClosingRequest,
  strict: boolean,
): Pick<CuaTurn, "closingReport"> | Pick<CuaTurn, "impressions"> | undefined {
  // Without an output format a model may set the object in a code fence or after a message.
  const text = message ?? "";
  let reply: unknown;
  try {
    reply = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {
    return undefined;
  }
  if (closing === "report") {
    const report = (strict ? closingReportSchema : closingReportSchema.required()).safeParse(reply);
    return report.success ? { closingReport: report.data } : undefined;
  }
  const impressions = impressionsReplySchema.safeParse(reply);
  return impressions.success ? { impressions: impressions.data.impressions } : undefined;
}
