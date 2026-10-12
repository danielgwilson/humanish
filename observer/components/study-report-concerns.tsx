import { ArrowRight } from "lucide-react";
import type { ObserverData } from "@/lib/observer-data";
import { participantLabels } from "@/lib/participant-label";
import { basisLabel, resolveReportMoment, type StudyReport } from "@/lib/study-report";
import { reportMomentTime } from "./study-report-findings";

/** Every material concern the analysis weighed, including those left out of the ranked
 * findings, with links to the finding that includes it and to its cited moments. */
export function StudyReportConcerns({
  data,
  reviews,
  open,
  onOpenChange,
  onFinding,
  onOpen,
}: {
  data: ObserverData;
  reviews: NonNullable<StudyReport["concernReviews"]>;
  open: boolean | undefined;
  onOpenChange: ((open: boolean) => void) | undefined;
  onFinding: (id: string) => void;
  onOpen: (
    streamId: string,
    frame: number | null,
    eventId: string | undefined,
    findingId: string,
  ) => void;
}) {
  const labels = participantLabels(data.streams);
  return (
    <details
      className="report-concerns"
      open={open}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
    >
      <summary>Concerns considered ({reviews.length})</summary>
      <p className="concern-intro">
        Material concerns reviewed in this analysis, including those left out of the ranked
        findings.
      </p>
      {!reviews.length ? <p>No material concerns were recorded in this review.</p> : null}
      {reviews.map((review, index) => (
        <section className="concern-review" key={index}>
          <div className="concern-heading">
            <span className="observation-basis">{basisLabel[review.basis]}</span>
            {review.findingId ? (
              <button type="button" onClick={() => onFinding(review.findingId!)}>
                Included in {review.findingId}
                <ArrowRight size={12} aria-hidden="true" />
              </button>
            ) : (
              <span className="concern-disposition">
                {review.disposition === "context" ? "Context only" : "Not established"}
              </span>
            )}
          </div>
          <p className="concern-claim">{review.claim}</p>
          <p>{review.reason}</p>
          {review.limitation ? <p className="observation-limit">{review.limitation}</p> : null}
          <div className="concern-evidence">
            {review.moments.map((moment, momentIndex) => {
              const resolved = resolveReportMoment(data, moment.streamId, moment.eventId);
              const time = reportMomentTime(resolved);
              const label = labels.get(moment.streamId) ?? moment.streamId;
              return (
                <button
                  type="button"
                  key={`${moment.streamId}/${moment.eventId}`}
                  disabled={!resolved}
                  onClick={() => {
                    if (resolved)
                      onOpen(moment.streamId, resolved.frameIndex, resolved.eventId, "");
                  }}
                  aria-label={`Open concern evidence: ${label} · ${time} · ${momentIndex + 1} of ${review.moments.length}`}
                >
                  {momentIndex + 1}. {label} · {time}
                  <ArrowRight size={12} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>
      ))}
    </details>
  );
}
