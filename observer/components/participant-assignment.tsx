import type { ObserverStream } from "@/lib/observer-data";
import "@/styles/assignment.css";

/** The stream's recorded assignment is authoritative. A study-level goal may
 * contain a different lane's prompt, so older evidence gets no inferred fallback. */
export function ParticipantAssignment({ stream }: { stream: ObserverStream }) {
  const assignment = stream.assignment;
  if (!assignment) return <p className="assignment-missing">Assigned task not recorded for this participant.</p>;
  return <details className="participant-assignment">
    <summary><span className="assignment-label">Assigned task</span><span className="assignment-preview">{assignment.focus || assignment.mission}</span></summary>
    <div className="assignment-body">
      {assignment.focus ? <div><h3>Lane focus</h3><p>{assignment.focus}</p></div> : null}
      <div>{assignment.focus ? <h3>Task</h3> : null}<p>{assignment.mission}</p></div>
      {assignment.tasks?.length ? <div><h3>Participant tasks</h3><ol>{assignment.tasks.map((task) => <li key={task.id}>{task.goal}</li>)}</ol></div> : null}
    </div>
  </details>;
}
