import { useEffect, useState, type CSSProperties } from "react";
import { formatDuration, keyframeHref, traceItems } from "@/lib/artifact-href";
import { ageLabel, frameUpdatedAt, isActiveStream, isServedOrigin, liveEmbedSandbox, liveEmbedUrl } from "@/lib/live";
import type { ObserverStream } from "@/lib/observer-data";
import type { GridMoment } from "@/lib/grid-recording";
import { formatElapsed } from "@/lib/player-model";
import { useDecodedImage } from "@/lib/use-decoded-image";
import { completionLabel, signalFor } from "@/lib/signal";
import { Popover } from "./ui/popover";
import { ReviewIcon } from "./review-icon";
import { ParticipantAssignment } from "./participant-assignment";
import TerminalCast, { type TerminalLine } from "./terminal-cast";

function terminalLines(plain: string): TerminalLine[] {
  return plain.split("\n").filter(Boolean).slice(-6).map((text) => text.startsWith("$ ") ? { kind: "cmd", text } : { kind: "dim", text });
}

export function ParticipantCard({ stream, name, onOpen, liveThumb = false, pinned = false, compared = false, comparisonFull = false, onPin, onCompare, now = Date.now(), updating = true, reviewOutcome, replay }: {
  replay?: GridMoment | undefined;
  reviewOutcome?: string | undefined;
  stream: ObserverStream; name: string; onOpen: (id: string) => void; liveThumb?: boolean;
  pinned?: boolean; compared?: boolean; comparisonFull?: boolean; onPin?: ((id: string) => void) | undefined; onCompare?: ((id: string) => void) | undefined; now?: number | undefined; updating?: boolean;
}) {
  const keyframe = replay ? replay.kind === "capture" ? replay.frame.href : null : keyframeHref(stream);
  const signal = signalFor(stream);
  const canUpdate = !replay && updating && isServedOrigin(window.location.protocol);
  const liveUrl = canUpdate ? liveEmbedUrl(stream) : null;
  const active = canUpdate && isActiveStream(stream);
  const statusLabel = !replay && !canUpdate && isActiveStream(stream) ? `Captured while ${stream.status}` : stream.statusLabel;
  const thought = active ? [...traceItems(stream)].reverse().find((item) => item.kind === "reasoning" && item.text) : undefined;
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const capture = useDecodedImage(liveThumb ? null : keyframe);
  useEffect(() => {
    if (!liveThumb || !liveUrl || !keyframe) return;
    // A live iframe hides the poster element. Read its raster dimensions anyway:
    // older and in-progress snapshots may omit declared viewport geometry.
    const image = new Image();
    image.onload = () => { if (image.naturalWidth && image.naturalHeight) setDimensions({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.src = keyframe;
    return () => { image.onload = null; };
  }, [liveThumb, liveUrl, keyframe]);
  const viewport = (liveThumb ? dimensions ?? capture.decoded : capture.decoded ?? dimensions)
    ?? stream.desktopGeometry?.screen.verified ?? stream.desktopGeometry?.screen.requested ?? stream.viewport;
  const warnings = stream.timeline.filter((event) => event.level === "warn" || event.level === "error");
  const label = stream.laneId ?? stream.label;
  const notable = completionLabel(stream);
  const flagged = !!notable || signal.flagged;
  const outcome = isActiveStream(stream) ? statusLabel : notable ?? (signal.flagged ? signal.label : statusLabel);
  const detailsLabel = `Participant details: ${name}`;
  const failed = keyframe !== null && capture.status === "error";
  const pending = keyframe !== null && capture.status === "loading" && !liveThumb;
  const sourceLabel = liveThumb && liveUrl ? "Live" : active ? "Capture" : !canUpdate && isActiveStream(stream) ? "Snapshot" : null;
  const previewLabel = liveThumb && liveUrl ? "Live desktop preview" : active ? `Latest capture · ${ageLabel(frameUpdatedAt(stream), now)}` : null;
  const captureLabel = replay?.kind === "capture" ? `${replay.coverage === "after-last" ? "Last capture" : "Capture"} · ${formatElapsed(replay.ageMs)} before cursor`
    : replay?.kind === "before-first" ? "No capture yet" : replay?.kind === "timing-unavailable" ? "Capture timing unavailable" : "No captured screens";
  const fromStart = replay?.kind === "timing-unavailable";
  const openLabel = fromStart ? `Open recording from start for ${name}` : `Open participant ${name}`;
  return <article className={`panel card${pinned ? " pinned" : ""}`} data-stream-id={stream.id} aria-label={name} data-compared={compared || undefined}
    style={{ "--preview-ratio": viewport ? viewport.width / viewport.height : 1.6 } as CSSProperties}>
    <div className="card-preview">
      <div className="thumb" style={{ aspectRatio: viewport ? `${viewport.width} / ${viewport.height}` : "16 / 10" }}>
        {liveThumb && liveUrl ? <iframe sandbox={liveEmbedSandbox(stream)} className="thumb-live" src={liveUrl} title={`Live thumb — ${name}`} referrerPolicy="no-referrer" aria-hidden="true" tabIndex={-1} />
          : keyframe ? <>{capture.slots.map((slot) => <img key={slot.key} className={slot.pending ? "capture-pending" : failed ? "capture-unavailable" : "keyframe"} src={slot.href} data-requested-src={keyframe}
            alt={slot.pending ? "" : `${pending && capture.decoded ? "Previous capture" : "Recorded screen"} from ${name}`} aria-hidden={slot.pending || undefined} loading="lazy" decoding="async"
            onLoad={(event) => { void capture.loaded(event.currentTarget, slot.key); }} onError={() => capture.errored(slot.key)} />)}
            {failed ? <div className="thumb-ph frame-unavailable"><span className="ph-state">Frame unavailable</span></div> : null}</>
            : !replay && stream.terminalPlain ? <div className="thumb-term"><TerminalCast lines={terminalLines(stream.terminalPlain)} /></div>
              : <div className="thumb-ph"><span className="ph-state">{failed ? "Frame unavailable" : replay ? captureLabel : active ? "Waiting for the first capture…" : "No captured screen"}</span></div>}
        <button type="button" className="open-overlay" aria-label={openLabel} onClick={() => onOpen(stream.id)} />
      </div>
    </div>
    {pending ? <p className="capture-loading" role="status">Loading selected capture…{capture.decoded ? " Previous capture shown." : ""}</p> : null}
    <div className="card-caption">
      {pinned ? <span className="card-pin" role="img" aria-label="Pinned participant" title="Pinned participant"><ReviewIcon name="pin" /></span> : null}
      <div className="card-identity"><button type="button" className="card-name" title={name} onClick={() => onOpen(stream.id)}>{name}</button>
        {replay ? <span className="card-capture-time" title={pending ? `Loading the selected capture.${capture.decoded ? " The previous capture remains visible." : ""}` : captureLabel}>{pending ? "Loading capture…" : replay.kind === "capture" ? <span className="card-capture-age">{formatDuration(Math.floor(replay.ageMs / 1000) * 1000)} ago</span> : captureLabel}</span>
          : <span className={`card-outcome${reviewOutcome ? " reviewed-outcome" : ""}${active ? " active" : ""}${flagged ? " flagged" : ""}`} title={reviewOutcome ? `Independent analysis: ${reviewOutcome}. Recorded actor: ${stream.actor?.status ?? "not retained"}.` : previewLabel ?? outcome}>{reviewOutcome ? `Analysis: ${reviewOutcome}` : sourceLabel ?? outcome}</span>}
      </div>
      <Popover triggerClassName="card-icon card-details-trigger" label={detailsLabel} title="Participant details" trigger={<ReviewIcon name="info" />}>
        <div className="card-details">
          <h3 className="participant-detail-name">{name}</h3>
          <ParticipantAssignment stream={stream} />
          <div className="card-detail-actions">
            {onPin ? <button type="button" className="review-tool" aria-pressed={pinned} aria-label={`${pinned ? "Pinned" : "Pin"} participant ${name}`} onClick={() => onPin(stream.id)}><ReviewIcon name="pin" />{pinned ? "Pinned" : "Pin"}</button> : null}
            {onCompare ? <button type="button" className="review-tool" aria-pressed={compared} aria-label={`Compare participant ${name}`} disabled={!compared && comparisonFull} onClick={() => onCompare(stream.id)}><ReviewIcon name={compared ? "check" : "compare"} />Compare</button> : null}
            {comparisonFull ? <p>Comparison limit: 3 participants. Remove one to choose another.</p> : null}
          </div>
          <dl><dt>Participant</dt><dd>{label}</dd><dt>Persona</dt><dd>{stream.sim.personaId}</dd>
            {reviewOutcome ? <><dt>Analyzed outcome</dt><dd>{reviewOutcome}</dd></> : null}
            <dt>{replay ? "Run status" : "Status"}</dt><dd>{statusLabel}</dd><dt>Preview</dt><dd>{replay ? captureLabel : previewLabel ?? "Recorded"}{liveThumb && liveUrl ? " · read-only; connection health is managed by the provider" : ""}</dd>
            <dt>Screen</dt><dd>{viewport ? `${viewport.width} × ${viewport.height} · ` : ""}{stream.kindLabel}</dd>
            {stream.actor ? <><dt>Duration</dt><dd>{formatDuration(stream.actor.durationMs)}</dd></> : null}
          </dl>
          <p><span className="sig-label">{replay ? "Whole-recording summary" : thought?.text ? "Reported thinking" : signal.label}</span><br />{thought?.text ?? signal.text}</p>
          {warnings.length ? <section className="card-warnings" aria-label="Participant notices"><h3>{warnings.length} recorded {warnings.length === 1 ? "notice" : "notices"}</h3><ul>{warnings.map((event) => <li key={event.id}>{event.message}</li>)}</ul></section> : null}
          <button type="button" className="review-tool" onClick={() => onOpen(stream.id)}>Open participant</button>
        </div>
      </Popover>
    </div>
    {failed ? <button type="button" className="card-retry" onClick={capture.retry}>Retry frame</button> : null}
  </article>;
}
