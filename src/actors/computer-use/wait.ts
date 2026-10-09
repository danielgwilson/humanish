// How long one participant wait action lasts. A study sets the longest (actor.maxWaitMs); the loop
// shortens a longer wait to it and sends the rest to the desktop in steps one desktop call carries.

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
  /** The smallest actor.maxWaitMs a study may set. */
  leastMaxMs: 1_000,
  /** The largest actor.maxWaitMs a study may set: a participant in a wait sees nothing new. */
  mostMaxMs: 600_000,
});

/** A whole number of milliseconds within the range actor.maxWaitMs accepts. */
export function isMaxWaitMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= CUA_WAIT_LIMITS.leastMaxMs &&
    value <= CUA_WAIT_LIMITS.mostMaxMs
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
