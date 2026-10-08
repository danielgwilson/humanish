import type { ObserverData } from "@/lib/observer-data";
import { participantLabels } from "@/lib/participant-label";
import { formatRunTime } from "../../src/run/run-clock.js";
import {
  resolveReportMoment,
  type DesignSeverity,
  type StudyDesignFinding,
} from "@/lib/study-report";

const SEVERITIES: { severity: DesignSeverity; label: string }[] = [
  { severity: "major", label: "Major: misleads or blocks" },
  { severity: "moderate", label: "Moderate: slows or confuses" },
  { severity: "minor", label: "Minor: polish" },
];
// A design finding usually cites one or two captures; more stay listed by count.
const MAX_THUMBNAILS = 4;

/** Problems a designer would see in the captures, grouped by severity, each with the captures
 * that show it. */
export function StudyReportDesign({
  data,
  findings,
  onOpen,
}: {
  data: ObserverData;
  findings: StudyDesignFinding[];
  onOpen: (streamId: string, frame: number | null, eventId: string | undefined) => void;
}) {
  const labels = participantLabels(data.streams);
  return (
    <section className="report-design" aria-labelledby="design-findings-heading">
      <h2 id="design-findings-heading" tabIndex={-1}>
        Design findings ({findings.length})
      </h2>
      <p className="design-intro">
        Problems a designer would notice in the captures, whether or not a participant mentioned
        them. Each cites the capture that shows it.
      </p>
      {!findings.length ? (
        <p className="design-empty">The design review found no problem in the reviewed captures.</p>
      ) : null}
      {SEVERITIES.map(({ severity, label }) => {
        const group = findings.filter((finding) => finding.severity === severity);
        if (!group.length) return null;
        return (
          <section className="design-group" key={severity} aria-label={label}>
            <h3>
              {label} ({group.length})
            </h3>
            {group.map((finding) => {
              const captures = finding.moments.map((moment) => ({
                ...moment,
                resolved: resolveReportMoment(data, moment.streamId, moment.eventId),
              }));
              const hidden = captures.length - MAX_THUMBNAILS;
              return (
                <article
                  className="design-finding"
                  key={finding.id}
                  data-design-finding={finding.id}
                >
                  <div className="design-text">
                    <h4>{finding.headline}</h4>
                    <dl>
                      <dt>Screen</dt>
                      <dd>{finding.screen}</dd>
                      <dt>What a designer notices</dt>
                      <dd>{finding.notice}</dd>
                      <dt>Why it matters</dt>
                      <dd>{finding.whyItMatters}</dd>
                      <dt>Suggestion</dt>
                      <dd>{finding.suggestion}</dd>
                    </dl>
                    <p className="design-meta">
                      Seen by {finding.seenByStreamIds.map((id) => labels.get(id) ?? id).join(", ")}{" "}
                      · {finding.confidence} confidence
                    </p>
                  </div>
                  <div className="design-captures">
                    {captures.slice(0, MAX_THUMBNAILS).map((capture) => {
                      const label = labels.get(capture.streamId) ?? capture.streamId;
                      const time =
                        capture.resolved?.elapsedMs != null
                          ? formatRunTime(capture.resolved.elapsedMs)
                          : "Time unavailable";
                      return (
                        <button
                          type="button"
                          className="design-capture"
                          key={`${capture.streamId}/${capture.eventId}`}
                          disabled={!capture.resolved?.frame}
                          aria-label={`Open capture: ${label} · ${time}`}
                          onClick={() => {
                            if (capture.resolved)
                              onOpen(
                                capture.streamId,
                                capture.resolved.frameIndex,
                                capture.resolved.eventId,
                              );
                          }}
                        >
                          {capture.resolved?.frame ? (
                            <img src={capture.resolved.frame.href} alt="" />
                          ) : (
                            <span className="design-capture-missing">
                              This capture is no longer available in the current recording.
                            </span>
                          )}
                          <span className="design-capture-caption">
                            {label} · {time}
                          </span>
                        </button>
                      );
                    })}
                    {hidden > 0 ? (
                      <p className="design-capture-more">
                        {hidden} more cited {hidden === 1 ? "capture" : "captures"}
                      </p>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}
