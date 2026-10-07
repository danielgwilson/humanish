import type {
  ActorTrace,
  ParticipantClosingReport,
  ParticipantImpressions,
} from "../../contract.js";
import type { LoopSession } from "./session.js";

// A participant's impressions: what it says about the product at the end of a session, beyond
// friction. Each one is recorded as its own message so the analysis can quote and cite it as a
// participant statement, and the trace says why none were collected when a session has none.

/** The closing-account request for impressions, shared by every provider that writes one. */
export const IMPRESSIONS_ASK =
  "In impressions, list up to six things you noticed about the product itself, each in the first person and about something you saw in this session. Give each one a kind: unclear when something looked confusing or hard to read; unfinished when something looked broken, unpolished or out of place; untrustworthy when something made you hesitate to trust the product; liked when something worked well or felt good; missing when you expected something and did not find it; unlike_my_work when the screen differs from how you do the same task in your own work or life, only if your persona does this task outside this product. Keep each under 500 characters. Use an empty list if you have none.";

/** Record a closing account's impressions as quotable participant messages. */
export function recordImpressions(
  session: LoopSession,
  report: ParticipantClosingReport,
): ParticipantImpressions {
  if (report.impressions === undefined)
    return notCollected("the participant's closing account did not include impressions");
  return {
    status: "collected",
    items: report.impressions.map(({ kind, text }) => {
      const redacted = session.redactNarration(text.trim());
      const messageId = session.trace.record("message", () => ({
        lifecycle: "completed",
        title: "participant impression",
        text: `Impression (${kind.replaceAll("_", " ")}): ${redacted}`,
      }));
      session.trace.bump("messages");
      return { kind, text: redacted, messageId };
    }),
  };
}

/** Why a session that recorded no impressions has none: its closing report, or its stop. */
export function impressionsNotCollected(debrief: ActorTrace["debrief"]): ParticipantImpressions {
  if (debrief === undefined) return notCollected("the session stopped before a closing account");
  if (debrief.status === "completed")
    return notCollected("the participant's closing account did not include impressions");
  const outcome = debrief.status === "skipped" ? "was skipped" : "failed";
  return notCollected(`the closing report ${outcome}: ${debrief.reason}`);
}

export function notCollected(reason: string): ParticipantImpressions {
  return { status: "not_collected", reason };
}
