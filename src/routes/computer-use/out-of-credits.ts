// What a desktop run does once its model account is out of credits. The provider names the
// response (ComputerUseOutOfCreditsError), and the loop calls onOutOfCredits for any request that
// gets it, a closing request included. From then on the run starts nobody: the account answers
// every participant the same way, and one later 200 does not show the credits are back. Both
// desktop routes start each participant through runCuaParticipant with deps from
// desktopParticipantDeps, so the latch lives in those deps and the skip in that runner.

import { plural } from "../../run/text.js";

/** The run's record of whether its model account ran out of credits. It never resets. */
export interface AccountCredits {
  /** A participant's request got the out-of-credits response: latch the run. */
  trip(): void;
  /** Why a participant that has not started will not, once latched. */
  notStartedReason(): string | undefined;
  /** Aborts when the run latches, so a schedule stops waiting to start anyone. */
  readonly signal: AbortSignal;
}

const NOT_STARTED =
  "not started: the model provider account ran out of credits during this run; no desktop was created";

export function accountCredits(): AccountCredits {
  const exhausted = new AbortController();
  return {
    trip: () => exhausted.abort(),
    notStartedReason: () => (exhausted.signal.aborted ? NOT_STARTED : undefined),
    signal: exhausted.signal,
  };
}

/** One participant's ending as the run's summary reads it. */
interface EndedParticipant {
  readonly session?: unknown;
  readonly outOfCredits?: "ran_out" | "not_started" | undefined;
}

/**
 * The sentences a run's summary and its error open with when a participant's request got the
 * out-of-credits response: the cause, how many participants ran a session, how many were not
 * started because of it, and what to do. Undefined when none got it.
 */
export function outOfCreditsSummary(
  participants: readonly (EndedParticipant | undefined)[],
): string | undefined {
  if (!participants.some((participant) => participant?.outOfCredits === "ran_out"))
    return undefined;
  const ran = participants.filter((participant) => participant?.session !== undefined).length;
  const notStarted = participants.filter(
    (participant) => participant?.outOfCredits === "not_started",
  ).length;
  const skipped =
    notStarted === 0 ? "" : ` and ${notStarted} ${notStarted === 1 ? "was" : "were"} not started`;
  return `The model provider account ran out of credits during this run: ${ran} of ${plural(participants.length, "participant")} ran${skipped}. Add credits to the account, then run the study again.`;
}

/** A run's error with the out-of-credits sentences first, when a participant ran out. */
export function withOutOfCreditsSummary<E extends { readonly message: string }>(
  error: E,
  participants: readonly (EndedParticipant | undefined)[],
): E {
  const sentences = outOfCreditsSummary(participants);
  return sentences === undefined ? error : { ...error, message: `${sentences} ${error.message}` };
}
