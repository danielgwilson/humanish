import type { ActorWaitSettings } from "../contract.js";

// How long one participant wait action lasts, for every provider and desktop. A study sets the
// longest (actor.maxWaitMs) and how long a wait that names no duration lasts while the participant
// only waits (actor.idleWaitMs). The loop asks planWait for each wait and sends it to the desktop
// in steps one desktop call carries.

export const CUA_WAIT_LIMITS = Object.freeze({
  /**
   * The longest wait one desktop call is given. A browser-control request must be answered within
   * its 35 s deadline, and a hosted desktop runs a wait as a sandbox command that times out after
   * 60 s, so the loop sends a longer wait as consecutive steps of at most this.
   */
  stepMs: 30_000,
  /**
   * The longest one wait action lasts when a study does not set actor.maxWaitMs and the desktop
   * has no speech (defaultMaxWaitMs). Two minutes covers waiting in a lobby or for an email to
   * arrive, and the participant still sees a fresh screenshot at least that often.
   */
  defaultMaxMs: 120_000,
  /**
   * How long a wait that names no duration lasts in a turn that only waits or takes screenshots,
   * when a study does not set actor.idleWaitMs. OpenAI's computer-use `wait` names no duration. A
   * participant told to wait about a minute sent ten in one turn, which lasts 50 s at this length;
   * one wait a turn makes a one-minute wait about six turns.
   */
  defaultIdleMs: 5_000,
  /**
   * How long a wait that names no duration lasts after the participant acts in the same turn, so
   * the screen can settle before the next screenshot. Nearly every OpenAI computer-use wait follows
   * a click or keypress this way, so a longer one would slow every run.
   */
  settleMs: 500,
  /** The smallest actor.maxWaitMs or actor.idleWaitMs a study may set. */
  leastMs: 1_000,
  /** The largest actor.maxWaitMs or actor.idleWaitMs a study may set. */
  mostMs: 600_000,
});

/** The wait lengths one session applies; the trace records them as `waitSettings`. */
export type WaitSettings = Readonly<ActorWaitSettings>;

/** One wait as the desktop runs it. */
export interface PlannedWait {
  /** How long the wait lasts. */
  readonly ms: number;
  /** The desktop calls it takes, in order, each at most CUA_WAIT_LIMITS.stepMs. */
  readonly steps: readonly number[];
  /** What the participant asked for, when that was longer than maxWaitMs. */
  readonly shortenedFromMs?: number;
}

/** A whole number of milliseconds within the range actor.maxWaitMs and actor.idleWaitMs accept. */
function isWaitMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= CUA_WAIT_LIMITS.leastMs &&
    value <= CUA_WAIT_LIMITS.mostMs
  );
}

/**
 * The longest one wait action lasts when a study does not set actor.maxWaitMs. On a desktop with
 * speech, heard speech reaches the participant only with a screenshot, and the desktop session ends
 * when more utterances arrive between two screenshots than it holds. A wait takes no screenshot, so
 * there the default keeps one wait to one desktop call.
 */
export function defaultMaxWaitMs(speechEnabled: boolean): number {
  return speechEnabled ? CUA_WAIT_LIMITS.stepMs : CUA_WAIT_LIMITS.defaultMaxMs;
}

const FIELDS = [
  ["maxWaitMs", "the longest one wait action lasts"],
  ["idleWaitMs", "how long a wait with no duration lasts while the participant only waits"],
] as const;

/**
 * Why these wait fields cannot run, or null. `prefix` names their owner in the message: `actor.`
 * in a study file, empty for loop options.
 */
export function waitFieldsReason(
  fields: { readonly maxWaitMs?: unknown; readonly idleWaitMs?: unknown },
  prefix: string,
): string | null {
  for (const [name, meaning] of FIELDS) {
    if (fields[name] !== undefined && !isWaitMs(fields[name]))
      return `${prefix}${name}, ${meaning}, must be a whole number of milliseconds from ${CUA_WAIT_LIMITS.leastMs} to ${CUA_WAIT_LIMITS.mostMs}.`;
  }
  const { maxWaitMs, idleWaitMs } = fields;
  if (typeof maxWaitMs === "number" && typeof idleWaitMs === "number" && idleWaitMs > maxWaitMs)
    return `${prefix}idleWaitMs (${idleWaitMs}) is longer than ${prefix}maxWaitMs (${maxWaitMs}), the longest one wait action lasts. Lower ${prefix}idleWaitMs or raise ${prefix}maxWaitMs.`;
  return null;
}

/**
 * The wait lengths a session applies: the study's values, or their defaults. The idle wait never
 * outlasts the longest wait, which on a desktop with speech defaults to 30 s. Throws a RangeError
 * for fields waitFieldsReason refuses.
 */
export function resolveWaitSettings(options: {
  readonly maxWaitMs?: number | undefined;
  readonly idleWaitMs?: number | undefined;
  readonly speechEnabled: boolean;
}): WaitSettings {
  const reason = waitFieldsReason(options, "");
  if (reason !== null) throw new RangeError(reason);
  const maxWaitMs = options.maxWaitMs ?? defaultMaxWaitMs(options.speechEnabled);
  return {
    maxWaitMs,
    idleWaitMs: Math.min(options.idleWaitMs ?? CUA_WAIT_LIMITS.defaultIdleMs, maxWaitMs),
    settleWaitMs: CUA_WAIT_LIMITS.settleMs,
  };
}

/**
 * How long one wait lasts and the desktop calls it takes. A wait that names no duration lasts
 * idleWaitMs when its turn only waits or takes screenshots (`idleTurn`), and settleWaitMs after an
 * action. A longer wait than maxWaitMs is shortened to it. 70 s is sent as 30 s, 30 s and 10 s.
 */
export function planWait(
  settings: WaitSettings,
  requestedMs: number | undefined,
  idleTurn: boolean,
): PlannedWait {
  const askedMs = requestedMs ?? (idleTurn ? settings.idleWaitMs : settings.settleWaitMs);
  const ms = Math.min(askedMs, settings.maxWaitMs);
  const { stepMs } = CUA_WAIT_LIMITS;
  const steps: number[] = [];
  for (let left = ms; left > stepMs; left -= stepMs) steps.push(stepMs);
  steps.push(ms - steps.length * stepMs);
  return { ms, steps, ...(askedMs > ms ? { shortenedFromMs: askedMs } : {}) };
}
