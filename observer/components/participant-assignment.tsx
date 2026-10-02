import type { ObserverStream } from "@/lib/observer-data";
import { recordedParticipantAssignment } from "@/lib/participant-assignment";
import "@/styles/assignment.css";

/** Retained scripted goals predate stream.assignment. Other lanes and study-level
 * goals cannot fill missing participant context. */
export function ParticipantAssignment({ stream }: { stream: ObserverStream }) {
  const recorded = recordedParticipantAssignment(stream);
  const actor = stream.liveActor ?? stream.actor;
  const brief = stream.actor?.persona?.brief;
  const hints =
    actor?.items.filter(
      (item) => item.kind === "notice" && item.title === "Participant context hint",
    ) ?? [];
  const context = (
    <>
      <details className="participant-assignment">
        <summary>
          <span className="assignment-label">Participant background</span>
        </summary>
        <div className="assignment-body">
          {brief ? (
            <>
              <p>{brief.text}</p>
              <p>
                Recorded persona context{brief.redacted ? "; sensitive values removed" : ""}. Task
                and runtime instructions are separate.
              </p>
            </>
          ) : (
            <p>Background was not recorded for this participant.</p>
          )}
        </div>
      </details>
      {hints.length ? (
        <details className="participant-assignment">
          <summary>
            <span className="assignment-label">Session guidance</span>
            <span>{hints.length} recorded hints</span>
          </summary>
          <div className="assignment-body">
            <ul>
              {hints.map((item) => (
                <li key={item.id}>{item.text}</li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}
    </>
  );
  if (!recorded)
    return (
      <>
        {context}
        <p className="assignment-missing">Assigned task not recorded for this participant.</p>
      </>
    );
  const { assignment, source } = recorded;
  return (
    <>
      <details className="participant-assignment">
        <summary>
          <span className="assignment-label">Assigned task</span>
          <span className="assignment-preview">{assignment.focus || assignment.mission}</span>
        </summary>
        <div className="assignment-body">
          {source === "scripted_goal" ? <h3>Recorded scripted goal</h3> : null}
          {assignment.focus ? (
            <div>
              <h3>Assigned focus</h3>
              <p>{assignment.focus}</p>
            </div>
          ) : null}
          <div>
            {assignment.focus ? <h3>Task</h3> : null}
            <p>{assignment.mission}</p>
          </div>
          {assignment.tasks?.length ? (
            <div>
              <h3>Participant tasks</h3>
              <ol>
                {assignment.tasks.map((task) => (
                  <li key={task.id}>{task.goal}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </div>
      </details>
      {context}
    </>
  );
}
