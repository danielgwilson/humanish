import { type ActorStatus, type ActorTrace } from "../actors/contract.js";
import {
  cuaGoalSource,
  isCuaTrace,
  CUA_COMPLETION_NOTE,
  type CuaGoalSource,
} from "../actors/goal-source.js";
import { actorEnding } from "../actors/stop-cause.js";
import type { TaskFunnel } from "../lab/tasks.js";
import type { ParticipantOutcomes, ReviewSummary, StudyTaskFunnel } from "./bundle.js";
import { isNonNegativeSafeInteger, isRecord } from "./primitives.js";

/** Tally participant outcomes from actor statuses. Statuses this does not recognise are counted in
 *  `total` but nowhere else, so the parts can never exceed the whole. */
export function tallyParticipantOutcomes(
  statuses: readonly ActorStatus[],
  /** Per-participant: did this one report friction or a defect? Same order as `statuses`. */
  reportedFriction: readonly boolean[] = [],
): ParticipantOutcomes {
  const tally: ParticipantOutcomes = {
    total: statuses.length,
    reachedGoal: 0,
    abandoned: 0,
    ranOut: 0,
    blocked: 0,
    harnessFailed: 0,
    reportedFriction: reportedFriction.filter(Boolean).length,
  };
  for (const status of statuses) {
    if (status === "passed") tally.reachedGoal += 1;
    else if (status === "abandoned") tally.abandoned += 1;
    else if (status === "incomplete" || status === "timed_out") tally.ranOut += 1;
    else if (status === "blocked") tally.blocked += 1;
    else if (status === "failed") tally.harnessFailed += 1;
  }
  return tally;
}

/** Roll per-participant funnels up into the study funnel. Undefined when nothing measured one. */
export function aggregateTaskFunnels(funnels: readonly TaskFunnel[]): StudyTaskFunnel | undefined {
  if (funnels.length === 0) return undefined;
  const order: string[] = [];
  const byId = new Map<
    string,
    { completed: number; sessions: number; observable: boolean; unmeasured: number }
  >();
  for (const funnel of funnels) {
    for (const task of funnel.tasks) {
      let entry = byId.get(task.id);
      if (entry === undefined) {
        entry = { completed: 0, sessions: 0, observable: false, unmeasured: 0 };
        byId.set(task.id, entry);
        order.push(task.id);
      }
      entry.sessions += 1;
      if (task.completed) entry.completed += 1;
      if (task.observable) entry.observable = true;
      if (task.inputsObserved === false) entry.unmeasured += 1;
    }
  }
  return {
    sessions: funnels.length,
    tasks: order.map((id) => {
      const entry = byId.get(id)!;
      return {
        id,
        completed: entry.completed,
        sessions: entry.sessions,
        observable: entry.observable,
        unmeasured: entry.unmeasured,
      };
    }),
  };
}

/** The funnel as one line, denominator on every number: `signup 2/2 · verify-email 1/2`. */
export function formatStudyTaskFunnel(funnel: StudyTaskFunnel): string {
  if (funnel.tasks.length === 0) return "no tasks declared";
  return funnel.tasks
    .map((task) => {
      if (!task.observable) return `${task.id} (no completion criterion)`;
      // A count that is entirely unmeasured must not render as a bare "0/3": that reads as a
      // participant failure when it is our observer that produced nothing (#514).
      if (task.unmeasured === task.sessions) {
        return `${task.id} (never measured in ${task.sessions})`;
      }
      const caveat = task.unmeasured > 0 ? ` (${task.unmeasured} never measured)` : "";
      return `${task.id} ${task.completed}/${task.sessions}${caveat}`;
    })
    .join(" · ");
}

type ParticipantOutcomeDetail = { status: ActorStatus; label?: string; goalSource?: CuaGoalSource };

function participantCompletionLine(
  outcomes: ParticipantOutcomes,
  terminalCauses: readonly ParticipantOutcomeDetail[],
): string {
  const completions = terminalCauses.filter((entry) => entry.status === "passed");
  const reported = completions.filter((entry) => entry.goalSource === "participant_report").length;
  const matched = completions.filter((entry) => entry.goalSource === "condition_matched").length;
  let goalLine =
    outcomes.reachedGoal === 0
      ? `0/${outcomes.total} recorded completions`
      : `${outcomes.reachedGoal}/${outcomes.total} reached the goal`;
  if (outcomes.reachedGoal > 0 && terminalCauses.some((entry) => entry.goalSource !== undefined)) {
    const count = `${outcomes.reachedGoal}/${outcomes.total}`;
    goalLine =
      completions.length !== outcomes.reachedGoal
        ? `${count} recorded completions (completion source unavailable)`
        : reported === outcomes.reachedGoal
          ? `${count} reported reaching the goal`
          : matched === outcomes.reachedGoal
            ? `${count} met a recorded completion condition`
            : `${count} recorded completions (${[
                reported > 0 ? `${reported} participant-reported` : undefined,
                matched > 0 ? `${matched} condition-matched` : undefined,
                outcomes.reachedGoal - reported - matched > 0
                  ? `${outcomes.reachedGoal - reported - matched} other or unavailable source`
                  : undefined,
              ]
                .filter(Boolean)
                .join(", ")})`;
  }
  return goalLine;
}

/** One line a stakeholder can read, with the denominator attached to every number. */
export function formatParticipantOutcomes(
  outcomes: ParticipantOutcomes,
  terminalCauses: readonly ParticipantOutcomeDetail[] = [],
): string {
  if (outcomes.total === 0) return "no participants reached a terminal state";
  const parts: string[] = [participantCompletionLine(outcomes, terminalCauses)];
  // Detail may explain a recorded outcome, but must never change its count or invent a match
  // between a tally and an incomplete set of traces.
  const append = (count: number, statuses: readonly ActorStatus[], fallback: string) => {
    if (count === 0) return;
    const matching = terminalCauses.filter((entry) => statuses.includes(entry.status));
    if (matching.length !== count) {
      parts.push(`${count} ${fallback}`);
      return;
    }
    const counts = new Map<string, number>();
    for (const entry of matching) {
      const description = entry.label === undefined ? fallback : `interrupted (${entry.label})`;
      counts.set(description, (counts.get(description) ?? 0) + 1);
    }
    for (const [description, n] of counts) parts.push(`${n} ${description}`);
  };
  append(outcomes.abandoned, ["abandoned"], "gave up");
  append(outcomes.ranOut, ["incomplete", "timed_out"], "interrupted (stop details unavailable)");
  // "blocked" covers an approval the run could not give AND a blocker the participant reported in
  // its own words (#476); the old "on an approval" read wrongly on a keyboard-first participant who
  // wrote "Blocked before diagram creation" about a mouse-only modal.
  if (outcomes.blocked > 0) parts.push(`${outcomes.blocked} blocked`);
  append(outcomes.harnessFailed, ["failed"], "lost to a harness failure");
  // Last, and separate, because it cuts across the outcomes rather than partitioning them: someone
  // can reach the goal and still have found the road there broken.
  if (outcomes.reportedFriction > 0) parts.push(`${outcomes.reportedFriction} reported friction`);
  return parts.join(", ");
}

/** Presentation details tolerate optional legacy actor payloads without changing their tallies. */
export function participantOutcomeDetails(
  streams: readonly { actor?: unknown; status?: unknown }[],
): ParticipantOutcomeDetail[] {
  return streams.flatMap((stream) => {
    if (!isRecord(stream.actor)) return [];
    const actor = stream.actor;
    const goalSource = cuaGoalSource(actor, stream.status);
    if (
      !["passed", "abandoned", "incomplete", "blocked", "timed_out", "failed"].includes(
        String(actor.status),
      )
    ) {
      return goalSource === "unavailable" ? [{ status: "passed" as const, goalSource }] : [];
    }
    const ending =
      Array.isArray(actor.items) && actor.items.every(isRecord)
        ? actorEnding(actor as unknown as ActorTrace)
        : undefined;
    return [
      {
        status: actor.status as ActorStatus,
        ...(ending === undefined ? {} : { label: ending.label }),
        ...(goalSource === undefined ? {} : { goalSource }),
      },
    ];
  });
}

/** Refresh a CUA completion claim from recorded traces, leaving original evidence and enums intact. */
export function withCuaReviewProvenance(
  review: ReviewSummary,
  streams: readonly { actor?: unknown; status?: unknown }[],
): ReviewSummary {
  const details = participantOutcomeDetails(streams);
  if (
    !isRecord(review.participants) ||
    ![
      "total",
      "reachedGoal",
      "abandoned",
      "ranOut",
      "blocked",
      "harnessFailed",
      "reportedFriction",
    ].every((key) =>
      isNonNegativeSafeInteger((review.participants as unknown as Record<string, unknown>)[key]),
    ) ||
    (review.participants.reachedGoal === 0
      ? !streams.some((stream) => isCuaTrace(stream.actor))
      : !details.some((entry) => entry.goalSource !== undefined))
  )
    return review;
  const outcomes = formatParticipantOutcomes(review.participants, details);
  // Preserve rerun context, participant narration and adapter-specific findings. Refreshing a
  // historical summary qualifies its old tally instead of silently discarding that context.
  const header = `Run gate: ${review.verdict}. Participants: ${outcomes}.${review.tasks ? ` Tasks: ${formatStudyTaskFunnel(review.tasks)}.` : ""}`;
  const prefix = `${header} Recorded summary: `;
  const recorded = review.summary.startsWith(prefix)
    ? review.summary.slice(prefix.length)
    : review.summary;
  const oldGoal = `${review.participants.reachedGoal}/${review.participants.total} reached the goal`;
  const qualified = recorded
    .split(oldGoal)
    .join(participantCompletionLine(review.participants, details));
  return {
    ...review,
    summary: `${prefix}${qualified}`,
    gaps:
      review.participants.reachedGoal === 0
        ? review.gaps
        : [...review.gaps.filter((gap) => gap !== CUA_COMPLETION_NOTE), CUA_COMPLETION_NOTE],
  };
}
