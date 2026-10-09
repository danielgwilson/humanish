// When each participant of a computer-use or shared-world run starts. A study may give each
// participant an offset from the moment the run starts its participants
// (`participants[].startAfterMs`). The plan simulates the start queue to report the schedule and
// when the last session ends at the latest; the routes start their participants through
// runOnSchedule, which waits for each one's time and then for a free slot. A participant's desktop
// is created when it starts, so a late start holds no sandbox before then.

import { setTimeout as delay } from "node:timers/promises";

import type { RunParticipantArrival } from "../run/bundle.js";
import { formatDuration } from "../run/projection.js";
import { plural } from "../run/text.js";
import { ceilingAdvice, sandboxHeadroomMs } from "../substrates/e2b/lifetime.js";

/**
 * The latest start a study may declare: 24 hours, the longest sandbox lifetime E2B documents. It
 * also keeps every wait under Node's timer limit of 2^31 - 1 ms, past which a timer fires at once.
 */
export const LATEST_START_AFTER_MS = 24 * 60 * 60_000;

/** Whether `value` is a start offset humanish runs: whole milliseconds from 0 to 24 hours. */
export function isStartAfterMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= LATEST_START_AFTER_MS
  );
}

/** The refusal of a start offset that is not one, naming its `field`. */
export function startAfterMessage(field: string): string {
  return `${field} must be a whole number of milliseconds from 0 to ${LATEST_START_AFTER_MS} (24 hours): how long after the run starts its participants this one starts.`;
}

/**
 * Why a roster's declared starts cannot run, or undefined. A start orders participants against
 * each other, so it needs two or more of them, and the host of an external public app opens the
 * session the others join, so it starts with the run.
 */
export function rosterStartsReason(
  roster: readonly {
    readonly id?: string;
    readonly startAfterMs?: number;
    readonly host?: boolean;
  }[],
): string | undefined {
  if (roster.length === 1 && roster[0]?.startAfterMs !== undefined)
    return "`startAfterMs` sets when a participant starts relative to the others, so it needs two or more participants, and this study has one. Remove it: a single participant starts with the run.";
  const host = roster.find((entry) => entry.host === true && (entry.startAfterMs ?? 0) > 0);
  if (host !== undefined)
    return `The host participant${host.id === undefined ? "" : ` "${host.id}"`} opens the shared session the others join, so it starts with the run. Remove its \`startAfterMs\`, or set it to 0.`;
  return undefined;
}

/** What the plan says about when a run's participants start, with every session at its full budget. */
export interface ArrivalPlan {
  /** Whether any participant declares `startAfterMs`. */
  readonly declared: boolean;
  /** The earliest and the latest declared start, in ms after the run starts its participants. */
  readonly firstStartMs: number;
  readonly lastStartMs: number;
  /** The most participants running at once. */
  readonly peak: number;
  /** How many participants wait past their time for a free slot, and the longest of those waits. */
  readonly waiting: number;
  readonly longestWaitMs: number;
  /** When the last session ends at the latest, in ms after the run starts its participants. */
  readonly lastEndMs: number;
  /** The session budget every figure above assumes each participant uses. */
  readonly sessionMs: number;
}

/** How the runtime starts participants: how many run at once, and for how long at most. */
export interface StartQueue {
  readonly slots: number;
  readonly sessionMs: number;
  /**
   * The roster index of a participant that runs on a slot of its own, outside the queue: the
   * external-public host, which the others wait on. It counts against `slots`.
   */
  readonly ownSlot?: number;
}

/**
 * The schedule a roster's declared offsets give under the queue (`undefined` is 0: the participant
 * starts with the run). Participants start in schedule order, by offset and then roster position,
 * each at its time or when a slot frees, whichever is later; this is the rule runOnSchedule
 * follows.
 */
export function planArrivals(
  offsets: readonly (number | undefined)[],
  queue: StartQueue,
): ArrivalPlan {
  const due = offsets.map((offset) => offset ?? 0);
  const starts = queueStarts(due, queue);
  let waiting = 0;
  let longestWaitMs = 0;
  for (const [index, start] of starts.entries()) {
    const waitMs = start - due[index]!;
    if (waitMs > 0) waiting += 1;
    longestWaitMs = Math.max(longestWaitMs, waitMs);
  }
  return {
    declared: offsets.some((offset) => offset !== undefined),
    firstStartMs: Math.min(...due),
    lastStartMs: Math.max(...due),
    peak: mostAtOnce(starts, queue.sessionMs),
    waiting,
    longestWaitMs,
    lastEndMs: Math.max(...starts) + queue.sessionMs,
    sessionMs: queue.sessionMs,
  };
}

/**
 * The plan's schedule, after a "schedule:" label: the first and last start, and how many run at
 * once at the most.
 */
export function describeArrivals(arrivals: ArrivalPlan): string {
  const late =
    arrivals.waiting === 0
      ? ""
      : `; ${plural(arrivals.waiting, "participant")} then start late, waiting for a free slot, the latest by ${formatDuration(arrivals.longestWaitMs)}`;
  return `the first participant starts at +${formatDuration(arrivals.firstStartMs)} and the last at +${formatDuration(arrivals.lastStartMs)}; at most ${arrivals.peak} run at once when every session uses its ${formatDuration(arrivals.sessionMs)} budget${late}.`;
}

/**
 * A planner's arrival plan for its participants under the start queue, and the warnings the plan
 * records about it. A participant's desktop is created when it starts, so on computer use a late
 * start adds nothing to any sandbox's deadline; the provisioned shared world checks its app's
 * sandbox with servedScheduleRefusal. `lowered` is the warning that the E2B plan's limit runs the
 * roster in waves.
 */
export function planStarts(
  participants: readonly { readonly startAfterMs?: number }[],
  queue: StartQueue,
  lowered: string | undefined,
): { arrivals: ArrivalPlan; warnings: string[] } {
  const arrivals = planArrivals(
    participants.map((participant) => participant.startAfterMs),
    queue,
  );
  return { arrivals, warnings: startQueueWarnings(arrivals, queue, lowered) };
}

// A roster that starts together keeps `lowered`. A declared schedule spreads its participants
// itself, so it is warned only when it holds someone past their time, with `lowered` beside that
// when the limit is the reason.
function startQueueWarnings(
  arrivals: ArrivalPlan,
  queue: StartQueue,
  lowered: string | undefined,
): string[] {
  if (!arrivals.declared || arrivals.waiting === 0)
    return !arrivals.declared && lowered ? [lowered] : [];
  const late = `${plural(arrivals.waiting, "participant")} would start after their time when every session uses its ${formatDuration(arrivals.sessionMs)} budget, the latest by ${formatDuration(arrivals.longestWaitMs)}: the run starts at most ${queue.slots} at once and holds the next one until a slot frees.`;
  return lowered === undefined ? [late] : [late, lowered];
}

/**
 * Why a sandbox that serves the app until the last participant ends, the provisioned shared
 * world's subject sandbox, cannot live that long under `ceilingMs`; undefined when it can. Its
 * deadline is the schedule's `lastEndMs` plus the time to provision and seed the subject and tear
 * it down. The session alone is checked first (sandboxDeadlineRefusal), so this names what the
 * schedule adds: a late start or a wait for a free slot.
 */
export function servedScheduleRefusal(
  arrivals: ArrivalPlan,
  sandbox: {
    readonly sessionMs: number;
    readonly seed: readonly { readonly timeoutMs?: number | undefined }[];
  },
  ceilingMs: number,
): string | undefined {
  if (arrivals.lastEndMs <= sandbox.sessionMs) return undefined;
  const headroomMs = sandboxHeadroomMs({ seed: sandbox.seed });
  const deadlineMs = arrivals.lastEndMs + headroomMs;
  if (deadlineMs <= ceilingMs) return undefined;
  const inMinutes = (ms: number) => Math.round(ms / 60_000);
  const causes = [
    ...(arrivals.lastStartMs > arrivals.firstStartMs
      ? [
          `the last one is due ${formatDuration(arrivals.lastStartMs - arrivals.firstStartMs)} after the first`,
        ]
      : []),
    ...(arrivals.waiting > 0
      ? [`${plural(arrivals.waiting, "participant")} wait for a free slot`]
      : []),
  ];
  return `The participants use the app for up to ${formatDuration(arrivals.lastEndMs)} when every session uses its ${formatDuration(sandbox.sessionMs)} budget, because ${causes.join(" and ")}. The subject sandbox, which serves the app until every participant ends, then needs a ${inMinutes(deadlineMs)}m deadline, with ${inMinutes(headroomMs)}m to provision and seed the subject and tear it down, and a sandbox may not live longer than ${ceilingMs / 60_000}m. Start the last participant earlier, lower execution.timeoutMs, or run more participants at once.${ceilingAdvice(deadlineMs)}`;
}

/** The roster indexes in the order participants start: by offset, then roster position. */
function scheduleOrder(due: readonly number[]): number[] {
  return due.map((_, index) => index).sort((a, b) => due[a]! - due[b]! || a - b);
}

/** Each participant's start in roster order, when every session holds its slot for `sessionMs`. */
function queueStarts(due: readonly number[], queue: StartQueue): number[] {
  const starts = [...due];
  const queued = scheduleOrder(due).filter((index) => index !== queue.ownSlot);
  const pooled = queue.ownSlot === undefined ? queue.slots : queue.slots - 1;
  // When each slot is next free; a participant takes the one that frees first.
  const free = Array.from({ length: Math.max(1, Math.min(pooled, queued.length)) }, () => 0);
  for (const index of queued) {
    const slot = free.indexOf(Math.min(...free));
    const start = Math.max(due[index]!, free[slot]!);
    starts[index] = start;
    free[slot] = start + queue.sessionMs;
  }
  return starts;
}

function mostAtOnce(starts: readonly number[], sessionMs: number): number {
  // An end sorts before a start at the same instant: that slot is free again.
  const changes = starts
    .flatMap((start) => [
      { at: start, by: 1 },
      { at: start + sessionMs, by: -1 },
    ])
    .sort((a, b) => a.at - b.at || a.by - b.by);
  let live = 0;
  let most = 0;
  for (const change of changes) {
    live += change.by;
    most = Math.max(most, live);
  }
  return most;
}

/** When a participant was due and when it started, in epoch ms. One that never started has no `startedAt`. */
export interface ParticipantArrival {
  readonly scheduledAt: number;
  readonly startedAt?: number;
}

/** A participant's `arrival` in run.json: its offset, and on a live run when it was due and started. */
export function arrivalRecord(
  startAfterMs: number | undefined,
  arrival: ParticipantArrival | undefined,
): RunParticipantArrival {
  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    startAfterMs: startAfterMs ?? 0,
    ...(arrival === undefined ? {} : { scheduledAt: iso(arrival.scheduledAt) }),
    ...(arrival?.startedAt === undefined ? {} : { startedAt: iso(arrival.startedAt) }),
  };
}

/** Where a participant sits in the run's schedule when its start comes. */
export interface ScheduledStart {
  /** Its place in schedule order, from 0: the first participant to start has 0. */
  readonly order: number;
  /** Its time in epoch ms: the moment the run started its participants plus its offset. */
  readonly scheduledAt: number;
}

/**
 * Calls `start` for each item at its time, with at most `slots` calls in flight. Items start in
 * schedule order; one whose time comes while every slot is busy waits for the next free slot. An
 * abort of `signal` ends every wait at once, so `start` runs for the waiting items right away and
 * decides whether to skip them. Results come back in the items' order.
 */
export async function runOnSchedule<T, R>(
  items: readonly T[],
  options: {
    readonly startAfterMs: (item: T) => number | undefined;
    readonly slots: number;
    /** The run's clock in epoch ms, which must advance while a start waits. Defaults to Date.now. */
    readonly now?: () => number;
    /** Waits `ms` or until `signal` aborts. Defaults to node:timers/promises' setTimeout. */
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    readonly signal?: AbortSignal;
  },
  start: (item: T, index: number, scheduled: ScheduledStart) => Promise<R>,
): Promise<R[]> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? sleepUntilAborted;
  const anchor = now();
  const due = items.map((item) => options.startAfterMs(item) ?? 0);
  const order = scheduleOrder(due);
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(options.slots, items.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < order.length) {
        const position = next;
        next += 1;
        const index = order[position]!;
        const scheduledAt = anchor + due[index]!;
        // A timer can fire a millisecond before the clock it was set against reads its time.
        for (let waitMs = scheduledAt - now(); waitMs > 0; waitMs = scheduledAt - now()) {
          if (options.signal?.aborted === true) break;
          await sleep(waitMs, options.signal);
        }
        results[index] = await start(items[index]!, index, { order: position, scheduledAt });
      }
    }),
  );
  return results;
}

/** An abort ends the wait early; the caller reads the signal itself. */
function sleepUntilAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return delay(ms, undefined, signal === undefined ? {} : { signal }).catch(() => undefined);
}
