// What a desktop run does once its model account is out of credits. The provider names the
// response (ComputerUseOutOfCreditsError) and the loop ends that participant's session with the
// stop cause provider_out_of_credits. From then on the run starts nobody: the account answers
// every participant the same way, and one later 200 does not show the credits are back. Both
// desktop routes start each participant through runCuaParticipant with deps from
// desktopParticipantDeps, so the latch lives in those deps and the skip in that runner.

import type { ActorTrace } from "../../actors/contract.js";
import { plural } from "../../run/text.js";

/** The run's record of whether its model account ran out of credits. It never resets. */
export interface AccountCredits {
  /** Read each ended session's trace; one that ended out of credits latches the run. */
  noteEnded(trace: Pick<ActorTrace, "stopCause"> | undefined): void;
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
    noteEnded(trace) {
      if (trace?.stopCause === "provider_out_of_credits") exhausted.abort();
    },
    notStartedReason: () => (exhausted.signal.aborted ? NOT_STARTED : undefined),
    signal: exhausted.signal,
  };
}

/** One participant's ending as the run's summary reads it. */
interface EndedParticipant {
  readonly session?: { readonly trace: Pick<ActorTrace, "stopCause"> } | undefined;
  readonly skippedReason?: string | undefined;
}

/**
 * The sentences a run's summary and its error open with when a participant ran out of credits:
 * the cause, how many participants ran and how many did not start, and what to do. Undefined when
 * none did.
 */
export function outOfCreditsSummary(
  participants: readonly (EndedParticipant | undefined)[],
): string | undefined {
  const ended = participants.filter((participant) => participant !== undefined);
  if (
    !ended.some((participant) => participant.session?.trace.stopCause === "provider_out_of_credits")
  )
    return undefined;
  const notStarted = ended.filter((participant) => participant.skippedReason !== undefined).length;
  const ran = `${participants.length - notStarted} of ${plural(participants.length, "participant")} ran`;
  const skipped =
    notStarted === 0 ? "" : ` and ${notStarted} ${notStarted === 1 ? "was" : "were"} not started`;
  return `The model provider account ran out of credits during this run: ${ran}${skipped}. Add credits to the account, then run the study again.`;
}

/** A summary's opening sentences followed by a space, or "" when there are none. */
export function opening(sentences: string | undefined): string {
  return sentences === undefined ? "" : `${sentences} `;
}

/** A run's error with the out-of-credits sentences first, when a participant ran out. */
export function withOutOfCreditsSummary<E extends { readonly message: string }>(
  error: E,
  participants: readonly (EndedParticipant | undefined)[],
): E {
  const sentences = outOfCreditsSummary(participants);
  return sentences === undefined ? error : { ...error, message: `${sentences} ${error.message}` };
}
