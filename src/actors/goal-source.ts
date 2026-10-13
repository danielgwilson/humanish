/**
 * The endpoint a computer-use completion came from, as analysis provenance records it
 * (cuaEndpointSource). Saved analyses hash it, so a new value would make them invalid on read.
 */
export const CUA_ENDPOINT_SOURCES = [
  "participant_report",
  "condition_matched",
  "unavailable",
] as const;
export type CuaEndpointSource = (typeof CUA_ENDPOINT_SOURCES)[number];

/**
 * Presentation provenance for computer-use completion; never reclassifies the stored outcome.
 * `scheduled_end` and `session_cap` name a session that passed at that clock end without the
 * participant declaring it reached the goal (ranUntilClockEnd).
 */
export type CuaGoalSource = CuaEndpointSource | ClockEnd;

/** The two clock ends a computer-use session passes at: the stop causes of the same names. */
export type ClockEnd = "scheduled_end" | "session_cap";

export function isClockEnd(source: CuaGoalSource | undefined): source is ClockEnd {
  return source === "scheduled_end" || source === "session_cap";
}

/**
 * The clock end a session ran until, when the participant did not declare that it reached the
 * goal: its scheduled end or its session cap. Such a session ends as passed, because ending at
 * the clock is the plan, and its closing report says `DID NOT REACH THE GOAL.` or declares
 * nothing. The tally and every completion label read this, so none counts it as reaching the
 * goal. Undefined for every other ending, including a declared `reached` at a clock end.
 */
export function ranUntilClockEnd(trace: {
  readonly stopCause?: unknown;
  readonly declaredOutcome?: unknown;
}): ClockEnd | undefined {
  if (trace.stopCause !== "scheduled_end" && trace.stopCause !== "session_cap") return undefined;
  return trace.declaredOutcome === "reached" ? undefined : trace.stopCause;
}

export function isCuaTrace(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const trace = value as Record<string, unknown>;
  return trace.lane === "computer-use" || trace.protocol === "cua-loop";
}

export function cuaGoalSource(value: unknown, recordedStatus?: unknown): CuaGoalSource | undefined {
  if (!isCuaTrace(value)) return undefined;
  const trace = value as Record<string, unknown>;
  if (trace.status !== "passed")
    return recordedStatus === "passed" || recordedStatus === "complete" ? "unavailable" : undefined;
  if (
    trace.lane !== "computer-use" ||
    trace.protocol !== "cua-loop" ||
    trace.completionReason !== "goal_satisfied"
  )
    return "unavailable";
  if (
    !Array.isArray(trace.items) ||
    !trace.items.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        typeof item.id === "string" &&
        typeof item.kind === "string" &&
        typeof item.title === "string" &&
        (item.lifecycle === "started" || item.lifecycle === "completed"),
    )
  ) {
    return "unavailable";
  }
  // These notices are written by the loop after a matched predicate/window, not by the model.
  if (
    trace.items.some(
      (item: Record<string, unknown>) =>
        item.kind === "notice" &&
        item.lifecycle === "completed" &&
        item.status === "matched" &&
        typeof item.title === "string" &&
        (item.title.startsWith("stopWhen matched:") || item.title === "dwell window complete"),
    )
  ) {
    return "condition_matched";
  }
  return ranUntilClockEnd(trace) ?? endpointOfItems(trace.items);
}

// A legacy trace without enough detail cannot establish which endpoint ended the loop.
function endpointOfItems(items: readonly unknown[]): CuaEndpointSource {
  return items.length > 0 ? "participant_report" : "unavailable";
}

/**
 * cuaGoalSource for analysis provenance. A clock end reads as it did before it had a source of
 * its own, so an analysis saved then still matches its run when re-read. The provenance's
 * `stopCause` and `declaredOutcome` name the clock end.
 */
export function cuaEndpointSource(
  value: unknown,
  recordedStatus?: unknown,
): CuaEndpointSource | undefined {
  const source = cuaGoalSource(value, recordedStatus);
  // cuaGoalSource returns a clock end only after it has checked that `items` is an array.
  return isClockEnd(source)
    ? endpointOfItems((value as { items: readonly unknown[] }).items)
    : source;
}

export const CUA_COMPLETION_NOTE =
  "Participant reports alone do not establish task success. A matched stop condition establishes only its declared condition. Run gate and share-safety results are separate.";
