import { redactEncodedText } from "../evidence/encoded-text.js";
import type { RunParticipantAssignment } from "../run/streams.js";

/** Project only authored participant-facing fields. Never pass runtime-composed instructions:
 * they can contain inbox URLs or multiplayer grants. Pick fields explicitly so a task's hidden
 * success criteria cannot cross this evidence boundary, even from an untyped library caller. */
export function participantAssignment(
  assignment: {
    mission: string;
    typing?: string | false;
    focus?: string;
    tasks?: readonly { id: string; goal: string }[];
  },
  scrubKnownValues: (text: string) => string = (text) => text,
): RunParticipantAssignment {
  const sanitize = (text: string): string => redactEncodedText(scrubKnownValues(text));
  return {
    mission: sanitize(assignment.mission),
    ...(assignment.typing === undefined
      ? {}
      : { typing: assignment.typing === false ? false : sanitize(assignment.typing) }),
    ...(assignment.focus === undefined ? {} : { focus: sanitize(assignment.focus) }),
    ...(assignment.tasks === undefined
      ? {}
      : {
          tasks: assignment.tasks.map(({ id, goal }) => ({
            id: sanitize(id),
            goal: sanitize(goal),
          })),
        }),
  };
}
