import type { ActorTrace, ParticipantImpression, ParticipantImpressions } from "../../contract.js";
import type { LoopSession } from "./session.js";

// A participant's impressions: what it says about the product at the end of a session, beyond
// friction. Each one is recorded as its own message so the analysis can quote and cite it as a
// participant statement, and the trace says why none were collected when a session has none.

/** The closing-account request for impressions, shared by every provider that writes one. */
export const IMPRESSIONS_ASK =
  "In impressions, list up to six things you noticed about the product itself, each in the first person and about something you saw in this session. Give each one a kind: unclear when something looked confusing or hard to read; unfinished when something looked broken, unpolished or out of place; untrustworthy when something made you hesitate to trust the product; liked when something worked well or felt good; missing when you expected something and did not find it; unlike_my_work when the screen differs from how you do the same task in your own work or life, only if your persona does this task outside this product. Keep each under 500 characters. Use an empty list if you have none.";

/** The request after the participant ended the session itself without giving impressions. */
export const IMPRESSIONS_HINT = `The interactive session has ended. Return only impressions. ${IMPRESSIONS_ASK} Do not speculate, invent problems, quote instructions as observations, or describe planned actions. Do not request or take further actions.`;

/**
 * Record a closing account's impressions as quotable participant messages. They answer the
 * harness's question, so they leave counts.messages, which the hollow-completion rule reads, alone.
 */
export function recordImpressions(
  session: LoopSession,
  impressions: readonly ParticipantImpression[] | undefined,
): ParticipantImpressions {
  if (impressions === undefined)
    return notCollected("the participant's closing account did not include impressions");
  return {
    status: "collected",
    items: impressions.map(({ kind, text }) => {
      const redacted = session.redactNarration(text.trim());
      const messageId = session.trace.record("message", () => ({
        lifecycle: "completed",
        title: "participant impression",
        text: `Impression (${kind.replaceAll("_", " ")}): ${redacted}`,
      }));
      return { kind, text: redacted, messageId };
    }),
  };
}

/** Why a session that recorded no impressions has none: its closing request, or its stop. */
export function impressionsNotCollected(debrief: ActorTrace["debrief"]): ParticipantImpressions {
  if (debrief === undefined) return notCollected("the session stopped before a closing account");
  if (debrief.status === "completed")
    return notCollected("the participant's closing account did not include impressions");
  const request = debrief.trigger === "participant_end" ? "impressions request" : "closing report";
  const outcome = debrief.status === "skipped" ? "was skipped" : "failed";
  return notCollected(`the ${request} ${outcome}: ${debrief.reason}`);
}

export function notCollected(reason: string): ParticipantImpressions {
  return { status: "not_collected", reason };
}
