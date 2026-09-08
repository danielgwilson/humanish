import { useEffect, useState, type CSSProperties } from "react";
import { formatDuration, keyframeHref, traceItems } from "@/lib/artifact-href";
import { ageLabel, frameUpdatedAt, isActiveStream, isServedOrigin, liveEmbedSandbox, liveEmbedUrl } from "@/lib/live";
import type { ObserverStream } from "@/lib/observer-data";
import { signalFor } from "@/lib/signal";
import TerminalCast, { type TerminalLine } from "./terminal-cast";

function terminalLines(plain: string): TerminalLine[] {
  return plain.split("\n").filter(Boolean).slice(-6).map((text) => text.startsWith("$ ") ? { kind: "cmd", text } : { kind: "dim", text });
}

export function ParticipantCard({ stream, onOpen, liveThumb = false, pinned = false, compared = false, onPin, onCompare, now = Date.now() }: {
  stream: ObserverStream; onOpen: (id: string) => void; liveThumb?: boolean;
  pinned?: boolean; compared?: boolean; onPin?: ((id: string) => void) | undefined; onCompare?: ((id: string) => void) | undefined; now?: number | undefined;
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
  const failed = keyframe !== null && keyframe === failedImage;
  const previewLabel = liveThumb && liveUrl ? "Live desktop preview" : active ? `Latest capture · ${ageLabel(frameUpdatedAt(stream), now)}` : "Recorded";
  return <article className={`panel card${pinned ? " pinned" : ""}`} data-stream-id={stream.id}
    style={{ "--preview-ratio": viewport ? viewport.width / viewport.height : 1.6 } as CSSProperties}>
    <div className="card-preview">
      <div className="thumb" style={{ aspectRatio: viewport ? `${viewport.width} / ${viewport.height}` : "16 / 10" }}>
        {liveThumb && liveUrl ? <iframe sandbox={liveEmbedSandbox(stream)} className="thumb-live" src={liveUrl} title={`Live thumb — ${label}`} referrerPolicy="no-referrer" aria-hidden="true" tabIndex={-1} />
          : keyframe && !failed ? <img className="keyframe" src={keyframe} alt={`Recorded screen from ${label}`} loading="lazy"
            onLoad={(event) => { const i = event.currentTarget; if (i.naturalWidth && i.naturalHeight) setDimensions({ width: i.naturalWidth, height: i.naturalHeight }); }}
            onError={() => setFailedImage(keyframe)} />
            : stream.terminalPlain ? <div className="thumb-term"><TerminalCast lines={terminalLines(stream.terminalPlain)} /></div>
              : <div className="thumb-ph"><span className="ph-state">{failed ? "Frame unavailable" : active ? "Waiting for the first capture…" : "No captured screen"}</span></div>}
        <button type="button" className="open-overlay" aria-label={`Open participant ${label}`} onClick={() => onOpen(stream.id)} />
        <span className="th-pill th-source">{previewLabel}</span>
        {stream.actor ? <span className="th-pill th-dur">{formatDuration(stream.actor.durationMs)}</span> : null}
        {liveThumb && liveUrl ? <span className="th-connection">Read-only · connection unverified</span> : null}
      </div>
    </div>
    <div className="cbar"><b className="pidx">{String(stream.sim.index).padStart(2, "0")}</b>
      <button type="button" className="cname" title={label} onClick={() => onOpen(stream.id)}>{label}</button>
      <span className={`chip${active ? " chip-dot" : " chip-mute"}`}>{statusLabel}</span>
    </div>
    <div className="card-meta">{viewport ? `${viewport.width} × ${viewport.height} · ` : ""}{stream.kindLabel}</div>
    <p className={`csig${thought?.text ? " ticker" : ""}`} title={thought?.text ? `Reported thinking: ${thought.text}` : undefined}>{thought?.text ? <><span className="sig-label">Reported thinking</span> {thought.text.replace(/\*\*([^*]+)\*\*/g, "$1")}</>
      : <><span className="sig-label">{signal.label}</span> {signal.text}</>}</p>
    <div className="card-tools">
      {onPin ? <button type="button" aria-pressed={pinned} aria-label={`${pinned ? "Unpin" : "Pin"} participant ${label}`} onClick={() => onPin(stream.id)}>{pinned ? "Pinned" : "Pin"}</button> : null}
      {onCompare ? <button type="button" aria-pressed={compared} aria-label={`${compared ? "Remove from" : "Add to"} comparison: ${label}`} onClick={() => onCompare(stream.id)}>{compared ? "Selected" : "Compare"}</button> : null}
      {failed ? <button type="button" onClick={() => setFailedImage(null)}>Retry frame</button> : null}
      {warnings.length ? <details className="card-warnings"><summary>{warnings.length} {warnings.length === 1 ? "notice" : "notices"}</summary><ul>{warnings.map((event) => <li key={event.id}>{event.message}</li>)}</ul></details> : null}
    </div>
  </article>;
}
