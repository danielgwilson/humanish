import type { ObserverStream } from "./observer-data";

// Typed notable outcomes (#426 card spec): when a lane completed one of these ways, the
// card's one signal line is a ⚑ badge plus the RECORDED reason, verbatim. budget_reached
// is deliberately here even though it maps to a passing status — hitting the recruiting
// budget is a finding the researcher wants surfaced, not an error state.
export const NOTABLE_COMPLETION: Record<string, string> = {
  gave_up: "gave up",
  blocked_approval: "blocked on approval",
  timed_out: "timed out",
  budget_reached: "budget cap",
  actor_error: "actor error",
  step_failed: "step failed",
  harness_error: "harness error"
};

export interface SignalLine {
  flagged: boolean;
  label: string;
  text: string;
}

// The card answers one question — "open this participant?" — with ONE signal line:
// notable completion → final recorded message → unresolved error → lane summary.
// Recoverable warnings remain available in the card’s notices.
export function signalFor(stream: ObserverStream): SignalLine {
  const actor = stream.actor;
  if (actor) {
    const notable = Object.hasOwn(NOTABLE_COMPLETION, actor.completionReason) ? NOTABLE_COMPLETION[actor.completionReason] : undefined;
    if (notable !== undefined && actor.reason !== "") {
      return { flagged: true, label: notable, text: actor.reason };
    }
  }
  const items = actor?.items ?? [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && item.kind === "message" && item.text !== undefined && item.text !== "") {
      return { flagged: false, label: "final message", text: item.text };
    }
  }
  const warn = stream.timeline.find((event) => event.level === "error");
  if (warn) return { flagged: true, label: "Needs attention", text: warn.message };
  return { flagged: false, label: "summary", text: stream.sim.summary };
}
