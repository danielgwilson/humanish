import { redactText } from "./redaction.js";
import type { RunParticipantAssignment } from "./run.js";

/** Project only authored participant-facing fields. Never pass runtime-composed instructions:
 * they can contain inbox URLs or multiplayer grants. Pick fields explicitly so a task's hidden
 * success criteria cannot cross this evidence boundary, even from an untyped library caller. */
export function participantAssignment(
  assignment: { mission: string; focus?: string; tasks?: readonly { id: string; goal: string }[] },
  scrubKnownValues: (text: string) => string = (text) => text
): RunParticipantAssignment {
  const sanitize = (text: string): string => redactText(scrubKnownValues(text));
  return {
    mission: sanitize(assignment.mission),
    ...(assignment.focus === undefined ? {} : { focus: sanitize(assignment.focus) }),
    ...(assignment.tasks === undefined ? {} : {
      tasks: assignment.tasks.map(({ id, goal }) => ({ id: sanitize(id), goal: sanitize(goal) }))
    })
  };
}
