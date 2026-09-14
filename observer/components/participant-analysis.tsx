import type { ObserverData } from "@/lib/observer-data";
import type { ParticipantAnalysis as Review } from "@/lib/study-report";
import { RecordedEntryLink } from "./recorded-entry-link";
import { formatElapsed } from "@/lib/player-model";

/** An explanation of the independent review, separate from recorded outcomes. */
export function ParticipantAnalysis({ data, review }: { data: ObserverData; review: Review }) {
  return <details className="participant-analysis" data-analysis-participant={review.streamId}>
    <summary>Independent analysis{review.stale ? " · stale" : ""}</summary>
    {review.stale ? <p className="analysis-notice">Evidence has changed since this analysis. These conclusions may no longer apply.</p> : null}
    <p>{review.summary}</p>
    <dl><dt>Apparent intent</dt><dd>{review.intent}</dd><dt>Analysis</dt><dd>{review.outcome}</dd><dt>Why</dt><dd>{review.outcomeReason}</dd></dl>
    {review.limitations.length ? <div><h3>Limitations</h3><ul>{review.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul></div> : null}
    <div className="participant-analysis-evidence" role="group" aria-label="Analysis evidence">{review.moments.map((moment, index) => {
      const time = moment.elapsedMs !== null ? formatElapsed(moment.elapsedMs) : moment.at && Number.isFinite(Date.parse(moment.at)) ? new Date(moment.at).toLocaleTimeString() : "Time unavailable";
      const snippet = moment.text.replace(/\s+/g, " ").trim();
      return <RecordedEntryLink key={moment.eventId} data={data} streamId={review.streamId} eventId={moment.eventId}><span className="analysis-entry-time">{index + 1}. {time} · {moment.label}</span><span>{snippet ? `${snippet.slice(0, 100)}${snippet.length > 100 ? "…" : ""}` : moment.eventId}</span></RecordedEntryLink>;
    })}</div>
    <p className="analysis-source-note">An independent interpretation of this participant’s retained evidence. Recorded outcomes and participant feedback remain unchanged.</p>
  </details>;
}
