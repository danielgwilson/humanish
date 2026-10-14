import type { ActorWaitSettings } from "../contract.js";

// How long one participant wait action lasts, for every provider and desktop. A study sets the
// longest (actor.maxWaitMs) and how long a wait that names no duration lasts while the participant
// only waits (actor.idleWaitMs). The loop asks planWait for each wait. A turn with another action
// sends its waits to the desktop in steps one desktop call carries; a turn that only waits watches
// the screen instead (loop/watch.ts), for its waits' lengths and at least idleWaitMs, the named
// ones together up to watchMaxMs, or longer as the watches of idle turns in a row grow.

export const CUA_WAIT_LIMITS = Object.freeze({
  /**
   * The longest wait one desktop call is given. A browser-control request must be answered within
   * its 35 s deadline, and a hosted desktop runs a wait as a sandbox command that times out after
   * 60 s, so the loop sends a longer wait as consecutive steps of at most this.
   */
  stepMs: 30_000,
  /**
   * The longest one wait action sent to the desktop lasts when a study does not set
   * actor.maxWaitMs and the desktop has no speech (defaultMaxWaitMs). Two minutes covers waiting in a lobby or for an email to
   * arrive, and the participant still sees a fresh screenshot at least that often.
   */
  defaultMaxMs: 120_000,
  /**
   * The longest a watch over an unchanged screen grows to, and the longest the named waits of a
   * turn that only waits are watched for together, when a study does not set actor.maxWaitMs. Each further watch
   * in a row that ends with no change lasts twice as long as the one before, so on a static screen
   * a participant settles at one model request per 10 minutes.
   */
  defaultWatchMaxMs: 600_000,
  /**
   * How long a wait that names no duration lasts in a turn that only waits or takes screenshots,
   * when a study does not set actor.idleWaitMs. OpenAI's computer tool `wait` names no duration;
   * its wait_minutes function names one in minutes. A participant told to wait about a minute
   * sent ten computer tool waits in one turn, which lasts 50 s at this length; one wait a turn
   * makes a one-minute wait about six turns. It is also the shortest a watch lasts and how often
   * it looks.
   */
  defaultIdleMs: 5_000,
  /**
   * How long a wait that names no duration lasts after the participant acts in the same turn, so
   * the screen can settle before the next screenshot. Nearly every OpenAI computer tool wait
   * follows a click or keypress this way, so a longer one would slow every run. A watch looks again
   * this soon after a large part of the screen moved.
   */
  settleMs: 500,
  /**
   * The longest gap between two looks of a watch on a desktop with speech. Heard speech reaches the
   * participant with a look, and the desktop session ends when more utterances arrive between two
   * observations than it holds; 30 s is the spacing the speech default kept before watches.
   */
  speechLookMs: 30_000,
  /** The smallest actor.maxWaitMs or actor.idleWaitMs a study may set. */
  leastMs: 1_000,
  /** The largest actor.idleWaitMs a study may set. */
  mostIdleMs: 600_000,
  /** The largest actor.maxWaitMs a study may set: a watch may grow to an hour. */
  mostMaxMs: 3_600_000,
});

/**
 * The wait lengths one session applies. The trace records the first three as `waitSettings`.
 * `watchMaxMs` is the longest a watch grows to over an unchanged screen and the longest a watched
 * turn's named waits last together, and `lookEveryMs` how often a watch looks.
 */
export type WaitSettings = Readonly<ActorWaitSettings> & {
  readonly watchMaxMs: number;
  readonly lookEveryMs: number;
};

/** One wait as the desktop runs it. */
export interface PlannedWait {
  /** How long the wait lasts. */
  readonly ms: number;
  /** The desktop calls it takes, in order, each at most CUA_WAIT_LIMITS.stepMs. */
  readonly steps: readonly number[];
  /** What the participant asked for, when that was longer than maxWaitMs. */
  readonly shortenedFromMs?: number;
}

/** A whole number of milliseconds from CUA_WAIT_LIMITS.leastMs to `mostMs`. */
function isWaitMs(value: unknown, mostMs: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= CUA_WAIT_LIMITS.leastMs &&
    value <= mostMs
  );
}

/**
 * The longest one wait action lasts when a study does not set actor.maxWaitMs. On a desktop with
 * speech, heard speech reaches the participant only with a screenshot, and the desktop session ends
 * when more utterances arrive between two screenshots than it holds. A wait takes no screenshot, so
 * there the default keeps one wait to one desktop call.
 */
function defaultMaxWaitMs(speechEnabled: boolean): number {
  return speechEnabled ? CUA_WAIT_LIMITS.stepMs : CUA_WAIT_LIMITS.defaultMaxMs;
}

const FIELDS = [
  ["maxWaitMs", "the longest one wait or one turn of only waits lasts", CUA_WAIT_LIMITS.mostMaxMs],
  [
    "idleWaitMs",
    "how long a wait with no duration lasts while the participant only waits",
    CUA_WAIT_LIMITS.mostIdleMs,
  ],
] as const;

/**
 * Why these wait fields cannot run, or null. `prefix` names their owner in the message: `actor.`
 * in a study file, empty for loop options. `maxPrefix` names the owner of maxWaitMs when it is
 * another, as for a participant's own idleWaitMs under actor.maxWaitMs.
 */
export function waitFieldsReason(
  fields: { readonly maxWaitMs?: unknown; readonly idleWaitMs?: unknown },
  prefix: string,
  maxPrefix: string = prefix,
): string | null {
  for (const [name, meaning, mostMs] of FIELDS) {
    if (fields[name] !== undefined && !isWaitMs(fields[name], mostMs))
      return `${name === "maxWaitMs" ? maxPrefix : prefix}${name}, ${meaning}, must be a whole number of milliseconds from ${CUA_WAIT_LIMITS.leastMs} to ${mostMs}.`;
  }
  const { maxWaitMs, idleWaitMs } = fields;
  if (typeof maxWaitMs === "number" && typeof idleWaitMs === "number" && idleWaitMs > maxWaitMs)
    return `${prefix}idleWaitMs (${idleWaitMs}) is longer than ${maxPrefix}maxWaitMs (${maxWaitMs}), the longest one wait or one turn of only waits lasts. Lower ${prefix}idleWaitMs or raise ${maxPrefix}maxWaitMs.`;
  return null;
}

/**
 * The wait lengths a session applies: the study's values, or their defaults. The idle wait never
 * outlasts the longest wait, which on a desktop with speech defaults to 30 s. A watch grows to
 * actor.maxWaitMs, else 10 minutes, and looks every idle wait, at most every 30 s on a desktop with
 * speech. Throws a RangeError for fields waitFieldsReason refuses.
 */
export function resolveWaitSettings(options: {
  readonly maxWaitMs?: number | undefined;
  readonly idleWaitMs?: number | undefined;
  readonly speechEnabled: boolean;
}): WaitSettings {
  const reason = waitFieldsReason(options, "");
  if (reason !== null) throw new RangeError(reason);
  const maxWaitMs = options.maxWaitMs ?? defaultMaxWaitMs(options.speechEnabled);
  const idleWaitMs = Math.min(options.idleWaitMs ?? CUA_WAIT_LIMITS.defaultIdleMs, maxWaitMs);
  return {
    maxWaitMs,
    idleWaitMs,
    settleWaitMs: CUA_WAIT_LIMITS.settleMs,
    watchMaxMs: options.maxWaitMs ?? CUA_WAIT_LIMITS.defaultWatchMaxMs,
    lookEveryMs: options.speechEnabled
      ? Math.min(idleWaitMs, CUA_WAIT_LIMITS.speechLookMs)
      : idleWaitMs,
  };
}

/**
 * How long one wait lasts and the desktop calls it takes. A wait that names no duration lasts
 * idleWaitMs when its turn only waits or takes screenshots (`idleTurn`), and settleWaitMs after an
 * action. A longer wait than maxWaitMs is shortened to it, and a negative one lasts 0 ms. 70 s is
 * sent as 30 s, 30 s and 10 s.
 */
export function planWait(
  settings: WaitSettings,
  requestedMs: number | undefined,
  idleTurn: boolean,
): PlannedWait {
  const askedMs = Math.max(
    0,
    requestedMs ?? (idleTurn ? settings.idleWaitMs : settings.settleWaitMs),
  );
  const ms = Math.min(askedMs, settings.maxWaitMs);
  const { stepMs } = CUA_WAIT_LIMITS;
  const steps: number[] = [];
  for (let left = ms; left > stepMs; left -= stepMs) steps.push(stepMs);
  steps.push(ms - steps.length * stepMs);
  return { ms, steps, ...(askedMs > ms ? { shortenedFromMs: askedMs } : {}) };
}
