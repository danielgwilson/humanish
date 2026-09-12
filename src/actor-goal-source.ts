/** Presentation provenance for computer-use completion; never reclassifies the stored outcome. */
export type CuaGoalSource = "participant_report" | "condition_matched" | "unavailable";

export function cuaGoalSource(value: unknown, recordedStatus?: unknown): CuaGoalSource | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const trace = value as Record<string, unknown>;
  if (trace.lane !== "computer-use" && trace.protocol !== "cua-loop") return undefined;
  if (trace.status !== "passed") return recordedStatus === "passed" || recordedStatus === "complete" ? "unavailable" : undefined;
  if (trace.lane !== "computer-use" || trace.protocol !== "cua-loop"
    || trace.completionReason !== "goal_satisfied") return "unavailable";
  if (!Array.isArray(trace.items) || !trace.items.every((item) => typeof item === "object" && item !== null
    && !Array.isArray(item) && typeof item.id === "string" && typeof item.kind === "string"
    && typeof item.title === "string" && (item.lifecycle === "started" || item.lifecycle === "completed"))) {
    return "unavailable";
  }
  // These notices are written by the loop after a matched predicate/window, not by the model.
  if (trace.items.some((item: Record<string, unknown>) => item.kind === "notice"
    && item.lifecycle === "completed" && item.status === "matched"
    && typeof item.title === "string"
    && (item.title.startsWith("stopWhen matched:") || item.title === "dwell window complete"))) {
    return "condition_matched";
  }
  // A legacy trace without enough detail cannot establish which endpoint ended the loop.
  return trace.items.length > 0 ? "participant_report" : "unavailable";
}

export const CUA_COMPLETION_NOTE = "Participant reports alone do not establish task success. A matched stop condition establishes only its declared condition. Run gate and share-safety results are separate.";
