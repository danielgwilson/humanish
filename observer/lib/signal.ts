import type { ObserverStream } from "./observer-data";

// Fallback labels for snapshots whose producer predates precise ending metadata.
export const NOTABLE_COMPLETION: Record<string, string> = {
  gave_up: "gave up",
  blocked_approval: "blocked on approval",
  timed_out: "time limit",
  budget_reached: "limit reached",
  actor_error: "actor error",
  step_failed: "step failed",
  harness_error: "harness error"
};

export function completionLabel(stream: ObserverStream): string | undefined {
  if (stream.ending) return stream.ending.label;
  const reason = stream.actor?.completionReason;
  return reason !== undefined && Object.hasOwn(NOTABLE_COMPLETION, reason) ? NOTABLE_COMPLETION[reason] : undefined;
}

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
    const notable = completionLabel(stream);
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
