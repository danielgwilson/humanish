import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PlayerFrame, PlayerRow } from "@/lib/player-model";

export type Zoom = "fit" | "actual" | number;
export interface Size { width: number; height: number }

/** The wrapper is the raster rectangle, not an object-fit letterbox. Pins share it. */
export function fittedSize(image: Size, available: Size, zoom: Zoom): Size {
  const factor = zoom === "fit"
    ? Math.min(available.width / image.width, available.height / image.height)
    : zoom === "actual" ? 1 : zoom;
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return { width: image.width * safeFactor, height: image.height * safeFactor };
}

export function pinPosition(coord: { x: number; y: number }, viewport: Size): CSSProperties | null {
  if (!Number.isFinite(coord.x) || !Number.isFinite(coord.y) || viewport.width <= 0 || viewport.height <= 0
    || coord.x < 0 || coord.y < 0 || coord.x > viewport.width || coord.y > viewport.height) return null;
  return { left: `${100 * coord.x / viewport.width}%`, top: `${100 * coord.y / viewport.height}%` };
}

export function PlayerStage({ frame, count, viewport, pins, zoom, live, label, emptyText, sandbox = "allow-scripts", streamRevision = 0 }: {
  frame: PlayerFrame | undefined;
  count: number;
  viewport: Size | undefined;
  pins: PlayerRow[];
  zoom: Zoom;
  live: string | null;
  label: string;
  emptyText: string;
  sandbox?: string;
  streamRevision?: number;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<Size>({ width: 640, height: 480 });
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const captureHref = live ? frame?.href : undefined;
  const [liveCapture, setLiveCapture] = useState<(Size & { label: string }) | null>(null);
  useEffect(() => {
    if (!captureHref) return;
    const image = new Image();
    let active = true;
    const measured = () => {
      if (!active || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      setLiveCapture({ label, width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onload = measured;
    image.src = captureHref;
    if (image.complete) measured();
    // Keep the previous known proportions while the next capture loads or fails.
    // A late image response must not change another participant or an unmounted stage.
    return () => { active = false; image.onload = null; image.onerror = null; };
  }, [captureHref, label]);
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth > 0 && node.clientHeight > 0) setAvailable({ width: Math.max(1, node.clientWidth - 24), height: Math.max(1, node.clientHeight - 24) });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  // Mid-run bundles may omit desktopGeometry/viewport. The recorded raster still
  // establishes the actual screen proportions, including redacted/downscaled images.
  const liveDimensions = liveCapture?.label === label ? liveCapture : viewport;
  const liveSize = fittedSize(liveDimensions ?? { width: 1280, height: 800 }, available, "fit");
  return <div className="stage evidence-stage" ref={stageRef} tabIndex={zoom === "fit" || live ? -1 : 0}
    aria-label={zoom === "fit" || live ? "Evidence stage" : "Zoomed evidence; scroll or drag to pan"}
    onPointerDown={(event) => {
      if (zoom === "fit" || live || event.pointerType !== "mouse" || event.button !== 0) return;
      const node = event.currentTarget;
      drag.current = { x: event.clientX, y: event.clientY, left: node.scrollLeft, top: node.scrollTop };
      node.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      if (!drag.current) return;
      event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
      event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
    }}
    onPointerUp={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
    {live && !liveDimensions ? <p className="live-size-note" role="status">Preview proportions are provisional until a captured screen is available.</p> : null}
    <div className="evidence-canvas">
      {live ? <div className="stage-live" style={liveSize}>
        <iframe key={streamRevision} sandbox={sandbox} src={live} title={`Live view — ${label}`} tabIndex={-1} aria-hidden="true" referrerPolicy="no-referrer" />

      </div> : frame ? <RecordedImage key={frame.href} frame={frame} count={count} viewport={viewport} available={available} zoom={zoom} pins={pins} />
        : <p className="evidence-empty" role="status">{emptyText}</p>}
    </div>
  </div>;
}

function RecordedImage({ frame, count, viewport, available, zoom, pins }: {
  frame: PlayerFrame; count: number; viewport: Size | undefined; available: Size; zoom: Zoom; pins: PlayerRow[];
}) {
  const [natural, setNatural] = useState<Size | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  // Raster dimensions are authoritative; viewport is only a stable loading fallback.
  const dimensions = natural ?? viewport ?? { width: 1280, height: 800 };
  const size = fittedSize(dimensions, available, zoom);
  const loaded = (image: HTMLImageElement) => {
    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) { setStatus("error"); return; }
    setNatural({ width: image.naturalWidth, height: image.naturalHeight });
    setStatus("ready");
  };
  useEffect(() => {
    const image = imgRef.current;
    if (image?.complete && image.naturalWidth > 0) loaded(image);
  }, [attempt]);
  return <div className="stage-box evidence-image" style={size} data-image-state={status} aria-busy={status === "loading"}>
    <img key={attempt} ref={imgRef} src={frame.href} alt={`Frame ${frame.index + 1} of ${count} — ${frame.title}`}
      decoding="async" draggable={false} onLoad={(event) => loaded(event.currentTarget)} onError={() => setStatus("error")} />
    {status !== "ready" ? <div className="evidence-message" role="status">
      {status === "loading" ? "Loading recorded frame…" : <>This recorded image could not be loaded.<button type="button" className="tbtn" onClick={() => { setStatus("loading"); setAttempt((value) => value + 1); }}>Retry image</button></>}
    </div> : null}
    {/* The pins stay mounted while loading for stable geometry, but are not displayed
        until the selected raster is ready. A previous image can never masquerade as it. */}
    {viewport ? <div className="pins" aria-hidden="true" style={{ visibility: status === "ready" ? "visible" : "hidden" }}>
      {pins.map((row) => {
        const position = row.coord ? pinPosition(row.coord, viewport) : null;
        const fraction = (row.coord?.x ?? 0) / viewport.width;
        const side = fraction > 0.5 ? "left" : "right";
        const room = Math.max(32, (side === "left" ? fraction : 1 - fraction) * size.width - 20);
        return position ? <span key={row.id} className="spin" data-tip-side={side} data-tip-vertical={(row.coord?.y ?? 0) / viewport.height > 0.75 ? "above" : "below"} style={position}>
          <span className="tip" style={{ maxWidth: Math.min(180, room) }}>{row.title}</span>
        </span> : null;
      })}
    </div> : null}
  </div>;
}
