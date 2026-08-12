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
// notable completion (reason verbatim) → warn event → the lane's final recorded message
// (the closest thing the bundle has to a report first line) → the lane summary.
export function signalFor(stream: ObserverStream): SignalLine {
  const actor = stream.actor;
  if (actor) {
    const notable = NOTABLE_COMPLETION[actor.completionReason];
    if (notable !== undefined && actor.reason !== "") {
      return { flagged: true, label: notable, text: actor.reason };
    }
  }
  const warn = stream.timeline.find((event) => event.level === "warn");
  if (warn) return { flagged: true, label: warn.type, text: warn.message };
  const items = actor?.items ?? [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && item.kind === "message" && item.text !== undefined && item.text !== "") {
      return { flagged: false, label: "final message — verbatim", text: item.text };
    }
  }
  return { flagged: false, label: "summary", text: stream.sim.summary };
}
