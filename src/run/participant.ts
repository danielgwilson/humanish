import type { ActorPersonaRef } from "../actors/contract.js";
import type { Participant } from "../lab/plan-participants.js";
import type { RunParticipantAssignment } from "./streams.js";

/**
 * A planned participant resolved for one run: the plan's record unchanged, plus what the route
 * derives before the participant starts. Every field about who the participant is lives on
 * `planned`; this record adds only the bundle ids, the resolved persona and the prompt.
 */
export interface ResolvedParticipant<P extends Participant = Participant> {
  /** Identity, persona id, mission and focus, labels and the route's own fields, from the plan. */
  readonly planned: P;
  /** Bundle ids from `planned.index`: `sim-NNN` and `stream-NNN`. */
  readonly simId: string;
  readonly streamId: string;
  /** The compiled persona brief. Evidence scrubbing replaces it before any bundle is written. */
  persona: ActorPersonaRef;
  /** The prompt the model reads. */
  readonly instructions: string;
  /** Redacted copy of the prompt for the bundle; set when the route scrubs its evidence. */
  evidenceInstructions?: string;
  /** What the participant was asked to do, as the bundle records it: mission, focus, task goals. */
  evidenceAssignment?: RunParticipantAssignment;
}

/** Resolve a planned participant: bundle ids from its index, plus the route's persona and prompt. */
export function resolveParticipant<P extends Participant>(
  planned: P,
  resolved: {
    persona: ActorPersonaRef;
    instructions: string;
    evidenceAssignment: RunParticipantAssignment;
  },
): ResolvedParticipant<P> {
  const ordinal = String(planned.index + 1).padStart(3, "0");
  return {
    planned,
    simId: `sim-${ordinal}`,
    streamId: `stream-${ordinal}`,
    persona: resolved.persona,
    instructions: resolved.instructions,
    evidenceAssignment: resolved.evidenceAssignment,
  };
}
