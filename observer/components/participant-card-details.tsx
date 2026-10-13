import { formatDuration } from "@/lib/artifact-href";
import { traceItems } from "../../src/run/run-clock.js";
import type { GridMoment } from "@/lib/grid-recording";
import type { ObserverStream } from "@/lib/observer-data";
import type { CardText } from "@/lib/card-text";
import { Popover } from "./ui/popover";
import { ReviewIcon } from "./review-icon";
import { ParticipantAssignment } from "./participant-assignment";

/**
 * A tile's details popover: the participant's assignment, pin and compare actions, its recorded
 * facts, the newest reported thinking of an active participant (else its signal line, or in replay
 * a note that the summary covers the whole recording), and its recorded notices.
 */
export function CardDetails({
  stream,
  name,
  replay,
  reviewOutcome,
  active,
  liveView,
  text,
  viewport,
  pinned,
  compared,
  comparisonFull,
  onPin,
  onCompare,
  onOpen,
}: {
  stream: ObserverStream;
  name: string;
  replay: GridMoment | undefined;
  reviewOutcome: string | undefined;
  /** The participant is running and the page still updates. */
  active: boolean;
  /** The tile streams the provider's live desktop. */
  liveView: boolean;
  text: CardText;
  viewport: { width: number; height: number } | undefined;
  pinned: boolean;
  compared: boolean;
  comparisonFull: boolean;
  onPin: ((id: string) => void) | undefined;
  onCompare: ((id: string) => void) | undefined;
  onOpen: (id: string) => void;
}) {
  const thought = active
    ? [...traceItems(stream)].reverse().find((item) => item.kind === "reasoning" && item.text)
    : undefined;
  const warnings = stream.timeline.filter(
    (event) => event.level === "warn" || event.level === "error",
  );
  const label = stream.laneId ?? stream.label;
  const detailsLabel = `Participant details: ${name}`;
  return (
    <Popover
      triggerClassName="card-icon card-details-trigger"
      label={detailsLabel}
      title="Participant details"
      trigger={<ReviewIcon name="info" />}
    >
      <div className="card-details">
        <h3 className="participant-detail-name">{name}</h3>
        <ParticipantAssignment stream={stream} />
        <div className="card-detail-actions">
          {onPin ? (
            <button
              type="button"
              className="review-tool"
              aria-pressed={pinned}
              aria-label={`${pinned ? "Pinned" : "Pin"} participant ${name}`}
              onClick={() => onPin(stream.id)}
            >
              <ReviewIcon name="pin" />
              {pinned ? "Pinned" : "Pin"}
            </button>
          ) : null}
          {onCompare ? (
            <button
              type="button"
              className="review-tool"
              aria-pressed={compared}
              aria-label={`Compare participant ${name}`}
              disabled={!compared && comparisonFull}
              onClick={() => onCompare(stream.id)}
            >
              <ReviewIcon name={compared ? "check" : "compare"} />
              Compare
            </button>
          ) : null}
          {comparisonFull ? (
            <p>Comparison limit: 3 participants. Remove one to choose another.</p>
          ) : null}
        </div>
        <dl>
          <dt>Participant</dt>
          <dd>{label}</dd>
          <dt>Persona</dt>
          <dd>{stream.sim.personaId}</dd>
          {reviewOutcome ? (
            <>
              <dt>Analyzed outcome</dt>
              <dd>{reviewOutcome}</dd>
            </>
          ) : null}
          <dt>{replay ? "Run status" : "Status"}</dt>
          <dd>{text.statusLabel}</dd>
          <dt>Preview</dt>
          <dd>
            {replay ? text.captureLabel : (text.previewLabel ?? "Recorded")}
            {liveView ? " · read-only; connection health is managed by the provider" : ""}
          </dd>
          <dt>Screen</dt>
          <dd>
            {viewport ? `${viewport.width} × ${viewport.height} · ` : ""}
            {stream.kindLabel}
          </dd>
          {stream.actor ? (
            <>
              <dt>Duration</dt>
              <dd>{formatDuration(stream.actor.durationMs)}</dd>
            </>
          ) : null}
        </dl>
        <p>
          <span className="sig-label">
            {replay
              ? "Whole-recording summary"
              : thought?.text
                ? "Reported thinking"
                : text.signal.label}
          </span>
          <br />
          {thought?.text ?? text.signal.text}
        </p>
        {warnings.length ? (
          <section className="card-warnings" aria-label="Participant notices">
            <h3>
              {warnings.length} recorded {warnings.length === 1 ? "notice" : "notices"}
            </h3>
            <ul>
              {warnings.map((event) => (
                <li key={event.id}>{event.message}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <button type="button" className="review-tool" onClick={() => onOpen(stream.id)}>
          Open participant
        </button>
      </div>
    </Popover>
  );
}
