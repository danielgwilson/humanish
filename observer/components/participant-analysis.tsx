import type { ObserverData } from "@/lib/observer-data";
import type { ParticipantAnalysis as Review } from "@/lib/study-report";
import { RecordedEntryLink } from "./recorded-entry-link";

/** An explanation of the independent review, separate from recorded outcomes. */
export function ParticipantAnalysis({ data, review }: { data: ObserverData; review: Review }) {
  return <details className="participant-analysis" data-analysis-participant={review.streamId}>
    <summary>Independent analysis{review.stale ? " · stale" : ""}</summary>
    {review.stale ? <p className="analysis-notice">Evidence has changed since this analysis. These conclusions may no longer apply.</p> : null}
    <p>{review.summary}</p>
    <dl><dt>Apparent intent</dt><dd>{review.intent}</dd><dt>Interpreted outcome</dt><dd>{review.outcome}</dd><dt>Why</dt><dd>{review.outcomeReason}</dd></dl>
    {review.limitations.length ? <div><h3>Limitations</h3><ul>{review.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul></div> : null}
    <div className="participant-analysis-evidence" role="group" aria-label="Analysis evidence">{review.moments.map((moment, index) => <RecordedEntryLink key={moment.eventId} data={data} streamId={review.streamId} eventId={moment.eventId}>{index + 1}. {moment.label}</RecordedEntryLink>)}</div>
    <p className="analysis-source-note">An independent interpretation of this participant’s retained evidence. Recorded outcomes and participant feedback remain unchanged.</p>
  </details>;
}
