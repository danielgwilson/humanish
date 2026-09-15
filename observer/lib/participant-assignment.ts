import type { ObserverStream } from "./observer-data";

/** Only retained context from this participant can supply its assignment. */
export function recordedParticipantAssignment(stream: ObserverStream): {
  assignment: NonNullable<ObserverStream["assignment"]>;
  source: "assignment" | "scripted_goal";
} | null {
  if (stream.assignment) return { assignment: stream.assignment, source: "assignment" };
  const goal = stream.ui?.intent;
  return stream.actor?.lane === "scripted-browser" && typeof goal === "string" && goal.trim()
    ? { assignment: { mission: goal }, source: "scripted_goal" } : null;
}
