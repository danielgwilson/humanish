import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { PlayerFrame, PlayerRow } from "@/lib/player-model";
import { useDecodedImage, type DecodedImageState } from "@/lib/use-decoded-image";

export type Zoom = "fit" | "actual" | number;
export interface Size {
  width: number;
  height: number;
}

/** The wrapper is the raster rectangle, not an object-fit letterbox. Pins share it. */
export function fittedSize(image: Size, available: Size, zoom: Zoom): Size {
  const factor =
    zoom === "fit"
      ? Math.min(available.width / image.width, available.height / image.height)
      : zoom === "actual"
        ? 1
        : zoom;
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  return { width: image.width * safeFactor, height: image.height * safeFactor };
}

export function pinPosition(coord: { x: number; y: number }, viewport: Size): CSSProperties | null {
  if (
    !Number.isFinite(coord.x) ||
    !Number.isFinite(coord.y) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    coord.x < 0 ||
    coord.y < 0 ||
    coord.x > viewport.width ||
    coord.y > viewport.height
  )
    return null;
  return {
    left: `${(100 * coord.x) / viewport.width}%`,
    top: `${(100 * coord.y) / viewport.height}%`,
  };
}

/** The stage's recorded frame and the proportions that size it, from one render. */
function useRecordedFrame(
  href: string | null,
  viewport: Size | undefined,
  recordDimensions: (size: Size) => void,
): { image: DecodedImageState; recordedDimensions: Size } {
  const image = useDecodedImage(href);
  // Raster dimensions are authoritative; viewport is only a stable loading fallback.
  const recordedDimensions = image.decoded ?? viewport ?? { width: 1280, height: 800 };
  // A later live view keeps the last decoded proportions until its own capture is measured.
  useEffect(() => {
    if (image.decoded) recordDimensions(image.decoded);
  }, [image.decoded, recordDimensions]);
  return { image, recordedDimensions };
}

export function PlayerStage({
  frame,
  count,
  viewport,
  pins,
  zoom,
  live,
  label,
  emptyText,
  sandbox = "allow-scripts",
  streamRevision = 0,
}: {
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
  const [captureDimensions, setCaptureDimensions] = useState<(Size & { label: string }) | null>(
    null,
  );
  const recordDimensions = useCallback(
    (size: Size) => setCaptureDimensions({ ...size, label }),
    [label],
  );
  const { image, recordedDimensions } = useRecordedFrame(
    !live && frame ? frame.href : null,
    viewport,
    recordDimensions,
  );
  useEffect(() => {
    if (!captureHref) return;
    const image = new Image();
    let active = true;
    const measured = () => {
      if (!active || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
      setCaptureDimensions({ label, width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onload = measured;
    image.src = captureHref;
    if (image.complete) measured();
    // Keep the previous known proportions while the next capture loads or fails.
    // A late image response must not change another participant or an unmounted stage.
    return () => {
      active = false;
      image.onload = null;
      image.onerror = null;
    };
  }, [captureHref, label]);
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth > 0 && node.clientHeight > 0)
        setAvailable({
          width: Math.max(1, node.clientWidth - 24),
          height: Math.max(1, node.clientHeight - 24),
        });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  // Mid-run bundles may omit desktopGeometry/viewport. The recorded raster still
  // establishes the actual screen proportions, including redacted/downscaled images.
  const liveDimensions = captureDimensions?.label === label ? captureDimensions : viewport;
  // The live view is sized from the measured stage; recorded fit is sized by CSS from the stage's
  // current box, so a measurement one frame behind can never shrink a recorded frame.
  const liveSize = fittedSize(liveDimensions ?? { width: 1280, height: 800 }, available, "fit");
  return (
    <div
      className="stage evidence-stage"
      role="region"
      ref={stageRef}
      data-fit-recording={!live && zoom === "fit" && frame ? "" : undefined}
      style={
        { "--fit-ratio": recordedDimensions.height / recordedDimensions.width } as CSSProperties
      }
      tabIndex={live ? -1 : 0}
      aria-label={
        zoom === "fit" || live ? "Evidence stage" : "Zoomed evidence; scroll or drag to pan"
      }
      onKeyDown={(event) => {
        // A focused zoomed stage owns native scrolling; global playback shortcuts
        // continue to work when focus is elsewhere in the recording.
        if (
          !live &&
          zoom !== "fit" &&
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(event.key)
        )
          event.stopPropagation();
      }}
      onPointerDown={(event) => {
        if (zoom === "fit" || live || event.pointerType !== "mouse" || event.button !== 0) return;
        const node = event.currentTarget;
        drag.current = {
          x: event.clientX,
          y: event.clientY,
          left: node.scrollLeft,
          top: node.scrollTop,
        };
        node.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX;
        event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY;
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onLostPointerCapture={() => {
        drag.current = null;
      }}
    >
      {live && !liveDimensions ? (
        <p className="live-size-note" role="status">
          Preview proportions are provisional until a captured screen is available.
        </p>
      ) : null}
      <div className="evidence-canvas">
        {live ? (
          <div className="stage-live" style={liveSize}>
            <iframe
              key={streamRevision}
              sandbox={sandbox}
              src={live}
              title={`Live view — ${label}`}
              tabIndex={-1}
              aria-hidden="true"
              referrerPolicy="no-referrer"
            />
          </div>
        ) : frame ? (
          <RecordedImage
            frame={frame}
            count={count}
            viewport={viewport}
            image={image}
            dimensions={recordedDimensions}
            zoom={zoom}
            pins={pins}
          />
        ) : (
          <p className="evidence-empty" role="status">
            {emptyText}
          </p>
        )}
      </div>
    </div>
  );
}

function RecordedImage({
  frame,
  count,
  viewport,
  image,
  dimensions,
  zoom,
  pins,
}: {
  frame: PlayerFrame;
  count: number;
  viewport: Size | undefined;
  image: DecodedImageState;
  dimensions: Size;
  zoom: Zoom;
  pins: PlayerRow[];
}) {
  const { decoded, slots, status, loaded, errored, retry } = image;
  // Fit is sized by CSS from the stage container and the stage's --fit-ratio. Zoom levels are the
  // raster size times a factor and need no measurement.
  const factor = zoom === "fit" || zoom === "actual" ? 1 : zoom;
  const size: CSSProperties | undefined =
    zoom === "fit"
      ? undefined
      : { width: dimensions.width * factor, height: dimensions.height * factor };
  return (
    <div
      className="stage-box evidence-image"
      data-fit={zoom === "fit" ? "" : undefined}
      style={size}
      data-image-state={status}
      data-retained-image={decoded && status === "loading" ? "" : undefined}
      aria-busy={status === "loading"}
    >
      {slots.map((slot) => (
        <img
          key={slot.key}
          src={slot.href}
          className={slot.pending ? "capture-pending" : undefined}
          data-requested-src={frame.href}
          alt={
            slot.pending
              ? ""
              : status !== "ready" && decoded
                ? "Previous capture while the selected frame is unavailable"
                : `Frame ${frame.index + 1} of ${count} — ${frame.title}`
          }
          aria-hidden={slot.pending || undefined}
          decoding="async"
          draggable={false}
          onLoad={(event) => {
            void loaded(event.currentTarget, slot.key);
          }}
          onError={() => errored(slot.key)}
        />
      ))}
      {status !== "ready" ? (
        <div className="evidence-message" role="status">
          {status === "loading" ? (
            "Loading recorded frame…"
          ) : (
            <>
              This recorded image could not be loaded.
              <button type="button" className="tbtn" onClick={retry}>
                Retry image
              </button>
            </>
          )}
          {decoded && status === "loading" ? <span>Previous capture shown.</span> : null}
        </div>
      ) : null}
      {/* The pins stay mounted while loading for stable geometry, but are not displayed
        until the selected raster is ready. A previous image can never masquerade as it. */}
      {viewport ? (
        <div
          className="pins"
          aria-hidden="true"
          style={{ visibility: status === "ready" ? "visible" : "hidden" }}
        >
          {pins.map((row) => {
            const position = row.coord ? pinPosition(row.coord, viewport) : null;
            const fraction = (row.coord?.x ?? 0) / viewport.width;
            const side = fraction > 0.5 ? "left" : "right";
            // The frame box is a size container, so the tip's room follows the box's own width.
            const room = side === "left" ? fraction : 1 - fraction;
            return position ? (
              <span
                key={row.id}
                className="spin"
                data-tip-side={side}
                data-tip-vertical={(row.coord?.y ?? 0) / viewport.height > 0.75 ? "above" : "below"}
                style={position}
              >
                <span
                  className="tip"
                  style={{ maxWidth: `min(180px, max(32px, calc(${room} * 100cqw - 20px)))` }}
                >
                  {row.title}
                </span>
              </span>
            ) : null;
          })}
        </div>
      ) : null}
    </div>
  );
}
