import type { ObserverStream } from "@/lib/observer-data";
import { recordedParticipantAssignment } from "@/lib/participant-assignment";
import "@/styles/assignment.css";

/** Retained scripted goals predate stream.assignment. Other lanes and study-level
 * goals cannot fill missing participant context. */
export function ParticipantAssignment({ stream }: { stream: ObserverStream }) {
  const recorded = recordedParticipantAssignment(stream);
  if (!recorded) return <p className="assignment-missing">Assigned task not recorded for this participant.</p>;
  const { assignment, source } = recorded;
  return <details className="participant-assignment">
    <summary><span className="assignment-label">Assigned task</span><span className="assignment-preview">{assignment.focus || assignment.mission}</span></summary>
    <div className="assignment-body">
      {source === "scripted_goal" ? <h3>Recorded scripted goal</h3> : null}
      {assignment.focus ? <div><h3>Lane focus</h3><p>{assignment.focus}</p></div> : null}
      <div>{assignment.focus ? <h3>Task</h3> : null}<p>{assignment.mission}</p></div>
      {assignment.tasks?.length ? <div><h3>Participant tasks</h3><ol>{assignment.tasks.map((task) => <li key={task.id}>{task.goal}</li>)}</ol></div> : null}
    </div>
  </details>;
}
