import { useEffect, useState, type CSSProperties } from "react";
import { formatDuration, keyframeHref, traceItems } from "@/lib/artifact-href";
import { ageLabel, frameUpdatedAt, isActiveStream, isServedOrigin, liveEmbedSandbox, liveEmbedUrl } from "@/lib/live";
import type { ObserverStream } from "@/lib/observer-data";
import { NOTABLE_COMPLETION, signalFor } from "@/lib/signal";
import { Popover } from "./ui/popover";
import { ReviewIcon } from "./review-icon";
import TerminalCast, { type TerminalLine } from "./terminal-cast";

function terminalLines(plain: string): TerminalLine[] {
  return plain.split("\n").filter(Boolean).slice(-6).map((text) => text.startsWith("$ ") ? { kind: "cmd", text } : { kind: "dim", text });
}

export function ParticipantCard({ stream, name, onOpen, liveThumb = false, pinned = false, compared = false, comparisonFull = false, onPin, onCompare, now = Date.now() }: {
  stream: ObserverStream; name: string; onOpen: (id: string) => void; liveThumb?: boolean;
  pinned?: boolean; compared?: boolean; comparisonFull?: boolean; onPin?: ((id: string) => void) | undefined; onCompare?: ((id: string) => void) | undefined; now?: number | undefined;
}) {
  const keyframe = keyframeHref(stream);
  const signal = signalFor(stream);
  const liveUrl = isServedOrigin(window.location.protocol) ? liveEmbedUrl(stream) : null;
  const active = isServedOrigin(window.location.protocol) && isActiveStream(stream);
  const statusLabel = !isServedOrigin(window.location.protocol) && isActiveStream(stream) ? `Captured while ${stream.status}` : stream.statusLabel;
  const thought = active ? [...traceItems(stream)].reverse().find((item) => item.kind === "reasoning" && item.text) : undefined;
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  useEffect(() => {
    if (!liveThumb || !liveUrl || !keyframe) return;
    // A live iframe hides the poster element. Read its raster dimensions anyway:
    // older and in-progress snapshots may omit declared viewport geometry.
    const image = new Image();
    image.onload = () => { if (image.naturalWidth && image.naturalHeight) setDimensions({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.src = keyframe;
    return () => { image.onload = null; };
  }, [liveThumb, liveUrl, keyframe]);
  const viewport = dimensions ?? stream.desktopGeometry?.screen.verified ?? stream.desktopGeometry?.screen.requested ?? stream.viewport;
  const warnings = stream.timeline.filter((event) => event.level === "warn" || event.level === "error");
  const label = stream.laneId ?? stream.label;
  const notable = stream.actor && Object.hasOwn(NOTABLE_COMPLETION, stream.actor.completionReason) ? NOTABLE_COMPLETION[stream.actor.completionReason] : undefined;
  const flagged = !!notable || signal.flagged;
  const outcome = isActiveStream(stream) ? statusLabel : notable ?? (signal.flagged ? signal.label : statusLabel);
  const detailsLabel = `Participant details: ${name}`;
  const failed = keyframe !== null && keyframe === failedImage;
  const sourceLabel = liveThumb && liveUrl ? "Live" : active ? "Capture" : !isServedOrigin(window.location.protocol) && isActiveStream(stream) ? "Snapshot" : null;
  const previewLabel = liveThumb && liveUrl ? "Live desktop preview" : active ? `Latest capture · ${ageLabel(frameUpdatedAt(stream), now)}` : null;
  return <article className={`panel card${pinned ? " pinned" : ""}`} data-stream-id={stream.id} aria-label={name} data-compared={compared || undefined}
    style={{ "--preview-ratio": viewport ? viewport.width / viewport.height : 1.6 } as CSSProperties}>
    <div className="card-preview">
      <div className="thumb" style={{ aspectRatio: viewport ? `${viewport.width} / ${viewport.height}` : "16 / 10" }}>
        {liveThumb && liveUrl ? <iframe sandbox={liveEmbedSandbox(stream)} className="thumb-live" src={liveUrl} title={`Live thumb — ${name}`} referrerPolicy="no-referrer" aria-hidden="true" tabIndex={-1} />
          : keyframe && !failed ? <img className="keyframe" src={keyframe} alt={`Recorded screen from ${name}`} loading="lazy"
            onLoad={(event) => { const i = event.currentTarget; if (i.naturalWidth && i.naturalHeight) setDimensions({ width: i.naturalWidth, height: i.naturalHeight }); }}
            onError={() => setFailedImage(keyframe)} />
            : stream.terminalPlain ? <div className="thumb-term"><TerminalCast lines={terminalLines(stream.terminalPlain)} /></div>
              : <div className="thumb-ph"><span className="ph-state">{failed ? "Frame unavailable" : active ? "Waiting for the first capture…" : "No captured screen"}</span></div>}
        <button type="button" className="open-overlay" aria-label={`Open participant ${name}`} onClick={() => onOpen(stream.id)} />
      </div>
    </div>
    <div className="card-caption">
      <div className="card-identity"><button type="button" className="card-name" title={name} onClick={() => onOpen(stream.id)}>{name}</button>
        <span className={`card-outcome${active ? " active" : ""}${flagged ? " flagged" : ""}`} title={previewLabel ?? outcome}>{sourceLabel ?? outcome}</span>
      </div>
      <Popover triggerClassName="card-icon card-details-trigger" label={detailsLabel} title="Participant details" trigger={<ReviewIcon name="info" />}>
        <div className="card-details">
          <h3 className="participant-detail-name">{name}</h3>
          <div className="card-detail-actions">
            {onPin ? <button type="button" className="review-tool" aria-pressed={pinned} aria-label={`Pin participant ${name}`} onClick={() => onPin(stream.id)}><ReviewIcon name="pin" />Pin</button> : null}
            {onCompare ? <button type="button" className="review-tool" aria-pressed={compared} aria-label={`Compare participant ${name}`} disabled={!compared && comparisonFull} onClick={() => onCompare(stream.id)}><ReviewIcon name={compared ? "check" : "compare"} />Compare</button> : null}
            {comparisonFull ? <p>Comparison limit: 3 participants. Remove one to choose another.</p> : null}
          </div>
          <dl><dt>Participant</dt><dd>{label}</dd><dt>Persona</dt><dd>{stream.sim.personaId}</dd>
            <dt>Status</dt><dd>{statusLabel}</dd><dt>Preview</dt><dd>{previewLabel ?? "Recorded"}{liveThumb && liveUrl ? " · read-only; connection health is managed by the provider" : ""}</dd>
            <dt>Screen</dt><dd>{viewport ? `${viewport.width} × ${viewport.height} · ` : ""}{stream.kindLabel}</dd>
            {stream.actor ? <><dt>Duration</dt><dd>{formatDuration(stream.actor.durationMs)}</dd></> : null}
          </dl>
          <p><span className="sig-label">{thought?.text ? "Reported thinking" : signal.label}</span><br />{thought?.text ?? signal.text}</p>
          {warnings.length ? <section className="card-warnings" aria-label="Participant notices"><h3>{warnings.length} recorded {warnings.length === 1 ? "notice" : "notices"}</h3><ul>{warnings.map((event) => <li key={event.id}>{event.message}</li>)}</ul></section> : null}
          <button type="button" className="review-tool" onClick={() => onOpen(stream.id)}>Open participant</button>
        </div>
      </Popover>
    </div>
    {failed ? <button type="button" className="card-retry" onClick={() => setFailedImage(null)}>Retry frame</button> : null}
  </article>;
}
