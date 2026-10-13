// When each participant of a computer-use or shared-world run starts, and on computer use when it
// ends. A study may give each participant an offset from the moment the run starts its participants
// (`participants[].startAfterMs`) and, on computer use, an end on the same clock
// (`participants[].endAfterMs`), with a wind-down before it in which each turn tells the
// participant the time left (`windDownMs`). The plan simulates the start queue to report the schedule and
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

/** The longest default wind-down: 10 minutes is enough to wrap up what a participant is doing. */
const MAX_DEFAULT_WIND_DOWN_MS = 10 * 60_000;

/**
 * Room a scheduled participant's session keeps past its end for the turn in flight and the closing
 * report. The loop ends the session at the end; this keeps the session's own time limit, and the
 * sandbox sized from it, from cutting the closing report short.
 */
const SCHEDULED_END_ROOM_MS = 5 * 60_000;

/**
 * A participant's declared window: when it starts, and when it ends on the run's clock
 * (`endAfterMs`) or at the latest after its own session started (`maxSessionMs`).
 */
export interface ParticipantWindow {
  readonly id?: string;
  readonly startAfterMs?: number;
  readonly endAfterMs?: number;
  readonly maxSessionMs?: number;
  readonly windDownMs?: number;
}

/**
 * Why a participant's declared end cannot run, or undefined: an end that is not a whole number of
 * milliseconds up to 24 hours, one at or before its start, a cap that is not a whole number of
 * milliseconds from 1 to 24 hours, a cap beside an end, or a wind-down that is not a whole number
 * of milliseconds or has neither. `path` names the entry, as in "participants[1]".
 */
export function windowReason(
  entry: {
    readonly id?: string;
    readonly startAfterMs?: number;
    readonly endAfterMs?: unknown;
    readonly maxSessionMs?: unknown;
    readonly windDownMs?: unknown;
  },
  path: string,
): string | undefined {
  const { endAfterMs, maxSessionMs, windDownMs } = entry;
  if (maxSessionMs !== undefined && endAfterMs !== undefined)
    return `${path} sets both endAfterMs and maxSessionMs. endAfterMs holds the participant until a set time, and maxSessionMs lets it end its session sooner, up to a cap, so a participant takes one of them. Keep endAfterMs for one that stays until a set time, or maxSessionMs for one that may leave when it is done.`;
  if (maxSessionMs !== undefined && !(isStartAfterMs(maxSessionMs) && maxSessionMs > 0))
    return `${path}.maxSessionMs must be a whole number of milliseconds from 1 to ${LATEST_START_AFTER_MS} (24 hours): the longest the participant's session lasts, counted from its start.`;
  if (windDownMs !== undefined && endAfterMs === undefined && maxSessionMs === undefined)
    return `${path}.windDownMs is how long before its endAfterMs or maxSessionMs a participant is told the time left, so it needs one of them. Add an end, or remove windDownMs.`;
  if (windDownMs !== undefined && !isStartAfterMs(windDownMs))
    return `${path}.windDownMs must be a whole number of milliseconds from 0 to ${LATEST_START_AFTER_MS} (24 hours): how long before its end the participant is told the time left.`;
  if (endAfterMs === undefined) return undefined;
  if (!isStartAfterMs(endAfterMs))
    return `${path}.endAfterMs must be a whole number of milliseconds up to ${LATEST_START_AFTER_MS} (24 hours): when the participant's session ends, after the run starts its participants.`;
  const startAfterMs = entry.startAfterMs ?? 0;
  if (endAfterMs <= startAfterMs) {
    const who = entry.id === undefined ? "" : ` ("${entry.id}")`;
    return `${path}.endAfterMs${who} is ${endAfterMs} ms and its startAfterMs is ${startAfterMs} ms, so it would end before it starts. Set endAfterMs after startAfterMs.`;
  }
  return undefined;
}

/**
 * A participant's session budget: with a declared end, its window plus SCHEDULED_END_ROOM_MS, and
 * with a cap, the cap plus the same room, in place of the study's `sessionMs` (execution.timeoutMs
 * or its default); else `sessionMs`.
 */
export function participantSessionMs(participant: ParticipantWindow, sessionMs: number): number {
  const windowMs = declaredWindowMs(participant);
  return windowMs === undefined ? sessionMs : windowMs + SCHEDULED_END_ROOM_MS;
}

/** How long a participant with a declared end or cap may work, or undefined without either. */
function declaredWindowMs(participant: ParticipantWindow): number | undefined {
  if (participant.maxSessionMs !== undefined) return participant.maxSessionMs;
  if (participant.endAfterMs === undefined) return undefined;
  return participant.endAfterMs - (participant.startAfterMs ?? 0);
}

/**
 * How long before its end or cap each turn tells a participant the time left: its `windDownMs` as
 * written, else a quarter of its window, at most 10 minutes. A fixed 10 minutes covered the whole
 * of a window of 10 minutes or less, so a short session was told its end from the first turn.
 * A quarter leaves most of a short session without a countdown, and a window of 40 minutes or
 * more keeps the 10 minutes. Undefined without an end or a cap.
 */
export function windDownMsOf(participant: ParticipantWindow): number | undefined {
  const windowMs = declaredWindowMs(participant);
  if (windowMs === undefined) return undefined;
  return participant.windDownMs ?? Math.min(MAX_DEFAULT_WIND_DOWN_MS, Math.floor(windowMs / 4));
}

/**
 * When a participant's session ends: at a time on the run's clock, or at the latest a time after
 * its own session starts, which the route reads when the session starts.
 */
export type ParticipantEnd =
  | { readonly kind: "scheduled_end"; readonly atMs: number; readonly windDownMs: number }
  | { readonly kind: "session_cap"; readonly afterMs: number; readonly windDownMs: number };

/**
 * How a participant that was due at `scheduledAt` (runOnSchedule's ScheduledStart) ends, or
 * undefined when it declares neither an end nor a cap. A participant that waited for a slot still
 * ends at its declared time, and still gets its whole cap.
 */
export function participantEnd(
  participant: ParticipantWindow,
  scheduledAt: number,
): ParticipantEnd | undefined {
  const windDownMs = windDownMsOf(participant);
  if (windDownMs === undefined) return undefined;
  if (participant.maxSessionMs !== undefined)
    return { kind: "session_cap", afterMs: participant.maxSessionMs, windDownMs };
  if (participant.endAfterMs === undefined) return undefined;
  return {
    kind: "scheduled_end",
    atMs: scheduledAt - (participant.startAfterMs ?? 0) + participant.endAfterMs,
    windDownMs,
  };
}

/**
 * Why the sandbox of the first participant whose window or cap passes `ceilingMs` cannot live that
 * long, or undefined. Its deadline is its session (participantSessionMs) plus `headroomMs`, what the
 * route adds to a session for setup and teardown (sandboxHeadroomMs).
 */
export function windowDeadlineRefusal(
  participants: readonly ParticipantWindow[],
  sandbox: { readonly sessionMs: number; readonly headroomMs: number },
  ceilingMs: number,
): string | undefined {
  const inMinutes = (ms: number) => Math.round(ms / 60_000);
  for (const participant of participants) {
    if (declaredWindowMs(participant) === undefined) continue;
    const deadlineMs = participantSessionMs(participant, sandbox.sessionMs) + sandbox.headroomMs;
    if (deadlineMs <= ceilingMs) continue;
    const name = participant.id === undefined ? "A participant" : `Participant "${participant.id}"`;
    const works =
      participant.maxSessionMs === undefined
        ? `works from +${formatDuration(participant.startAfterMs ?? 0)} to +${formatDuration(participant.endAfterMs ?? 0)}`
        : `may work for up to ${formatDuration(participant.maxSessionMs)}`;
    const window = participant.maxSessionMs === undefined ? "window" : "cap";
    return `${name} ${works}, so its sandbox needs a ${inMinutes(deadlineMs)}m deadline: the ${window}, ${inMinutes(SCHEDULED_END_ROOM_MS)}m for its closing report and ${inMinutes(sandbox.headroomMs)}m to set up and tear down. A sandbox may not live longer than ${ceilingMs / 60_000}m. Shorten its ${window}.${ceilingAdvice(deadlineMs)}`;
  }
  return undefined;
}

/**
 * Each participant's window for `study check`, when any participant declares an end or a cap: when
 * it starts and ends and when it is first told the time left, when it starts and its cap and how
 * far into its session it is first told the time left, or when it starts and its session budget.
 */
export function describeWindows(
  participants: readonly ParticipantWindow[],
  sessionMs: number,
): string | undefined {
  if (!participants.some((participant) => declaredWindowMs(participant) !== undefined))
    return undefined;
  const windows = participants.map((participant) => {
    const start = `${participant.id ?? "participant"} from +${formatDuration(participant.startAfterMs ?? 0)}`;
    if (participant.maxSessionMs !== undefined) {
      const told = Math.max(0, participant.maxSessionMs - windDownMsOf(participant)!);
      return `${start} until it ends itself or for up to ${formatDuration(participant.maxSessionMs)}, told the time left from ${formatDuration(told)} into its session`;
    }
    if (participant.endAfterMs === undefined)
      return `${start} for up to ${formatDuration(sessionMs)}`;
    const told = Math.max(
      participant.startAfterMs ?? 0,
      participant.endAfterMs - windDownMsOf(participant)!,
    );
    return `${start} to +${formatDuration(participant.endAfterMs)}, told the time left from +${formatDuration(told)}`;
  });
  return `${windows.join("; ")}.`;
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
 * follows. `sessionsMs` gives a participant with a declared end its own session budget
 * (participantSessionMs); the others hold their slot for `queue.sessionMs`.
 */
export function planArrivals(
  offsets: readonly (number | undefined)[],
  queue: StartQueue,
  sessionsMs: readonly number[] = [],
): ArrivalPlan {
  const due = offsets.map((offset) => offset ?? 0);
  const session = (index: number) => sessionsMs[index] ?? queue.sessionMs;
  const starts = queueStarts(due, queue, session);
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
    peak: mostAtOnce(starts, session),
    waiting,
    longestWaitMs,
    lastEndMs: Math.max(...starts.map((start, index) => start + session(index))),
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
  participants: readonly ParticipantWindow[],
  queue: StartQueue,
  lowered: string | undefined,
): { arrivals: ArrivalPlan; warnings: string[] } {
  const arrivals = planArrivals(
    participants.map((participant) => participant.startAfterMs),
    queue,
    participants.map((participant) => participantSessionMs(participant, queue.sessionMs)),
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

/** Each participant's start in roster order, when each session holds its slot for `session(index)`. */
function queueStarts(
  due: readonly number[],
  queue: StartQueue,
  session: (index: number) => number,
): number[] {
  const starts = [...due];
  const queued = scheduleOrder(due).filter((index) => index !== queue.ownSlot);
  const pooled = queue.ownSlot === undefined ? queue.slots : queue.slots - 1;
  // When each slot is next free; a participant takes the one that frees first.
  const free = Array.from({ length: Math.max(1, Math.min(pooled, queued.length)) }, () => 0);
  for (const index of queued) {
    const slot = free.indexOf(Math.min(...free));
    const start = Math.max(due[index]!, free[slot]!);
    starts[index] = start;
    free[slot] = start + session(index);
  }
  return starts;
}

function mostAtOnce(starts: readonly number[], session: (index: number) => number): number {
  // An end sorts before a start at the same instant: that slot is free again.
  const changes = starts
    .flatMap((start, index) => [
      { at: start, by: 1 },
      { at: start + session(index), by: -1 },
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
