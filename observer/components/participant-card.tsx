import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { formatDuration, keyframeHref } from "@/lib/artifact-href";
import { isActiveStream, isServedOrigin, liveEmbedSandbox, liveEmbedUrl } from "@/lib/live";
import type { ObserverStream } from "@/lib/observer-data";
import type { GridMoment } from "@/lib/grid-recording";
import { useDecodedImage, type DecodedImageState } from "@/lib/use-decoded-image";
import { useSettled } from "@/lib/use-settled";
import { cardText, type CardText } from "@/lib/card-text";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { CardDetails } from "./participant-card-details";
import TerminalCast, { type TerminalLine } from "./terminal-cast";

function terminalLines(plain: string): TerminalLine[] {
  return plain
    .split("\n")
    .filter(Boolean)
    .slice(-6)
    .map((text) => (text.startsWith("$ ") ? { kind: "cmd", text } : { kind: "dim", text }));
}

/** A decode shorter than this shows nothing; see useSettled. */
const LOADING_AFFORDANCE_DELAY_MS = 400;

type Size = { width: number; height: number };

/**
 * The tile's capture: the decoded keyframe (none while the live thumb shows), the size that shapes
 * the tile, and whether the capture failed or is slow to decode. A live thumb reads its latest
 * capture's size, since older and in-progress snapshots may omit declared geometry. A capture that
 * failed while the server was stopped is asked for again when it answers.
 */
function useCardCapture(
  stream: ObserverStream,
  keyframe: string | null,
  liveThumb: boolean,
  liveUrl: string | null,
  serverStopped: boolean,
) {
  const [dimensions, setDimensions] = useState<Size | null>(null);
  const capture = useDecodedImage(liveThumb ? null : keyframe);
  const [previousStopped, setPreviousStopped] = useState(serverStopped);
  if (previousStopped !== serverStopped) {
    setPreviousStopped(serverStopped);
    // Requests failed while no server answered; ask again once one does.
    if (!serverStopped && capture.status === "error") capture.retry();
  }
  useEffect(() => {
    if (!liveThumb || !liveUrl || !keyframe) return;
    // A live iframe hides the poster element. Read its raster dimensions anyway:
    // older and in-progress snapshots may omit declared viewport geometry.
    const image = new Image();
    image.onload = () => {
      if (image.naturalWidth && image.naturalHeight)
        setDimensions({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.src = keyframe;
    return () => {
      image.onload = null;
    };
  }, [liveThumb, liveUrl, keyframe]);
  const viewport =
    (liveThumb ? (dimensions ?? capture.decoded) : (capture.decoded ?? dimensions)) ??
    stream.desktopGeometry?.screen.verified ??
    stream.desktopGeometry?.screen.requested ??
    stream.viewport;
  const captureFailed = keyframe !== null && capture.status === "error";
  // Without a server every request fails, which says nothing about the recording. The page
  // notice explains it once, so the tile shows no capture and no message of its own.
  const failed = captureFailed && !serverStopped;
  const pending = keyframe !== null && capture.status === "loading" && !liveThumb;
  // Only a slow decode earns the loading bar and caption; a fast one keeps the previous capture and label.
  const slowLoad = useSettled(pending, LOADING_AFFORDANCE_DELAY_MS);
  return { capture, viewport, captureFailed, failed, pending, slowLoad };
}

export function ParticipantCard({
  stream,
  name,
  onOpen,
  liveThumb = false,
  pinned = false,
  compared = false,
  comparisonFull = false,
  onPin,
  onCompare,
  now = Date.now(),
  updating = true,
  reviewOutcome,
  replay,
  serverStopped = false,
}: {
  /** The serving process is gone; one page notice says so in place of a message per tile. */
  serverStopped?: boolean;
  replay?: GridMoment | undefined;
  reviewOutcome?: string | undefined;
  stream: ObserverStream;
  name: string;
  onOpen: (id: string) => void;
  liveThumb?: boolean;
  pinned?: boolean;
  compared?: boolean;
  comparisonFull?: boolean;
  onPin?: ((id: string) => void) | undefined;
  onCompare?: ((id: string) => void) | undefined;
  now?: number | undefined;
  updating?: boolean;
}) {
  const keyframe = replay
    ? replay.kind === "capture"
      ? replay.frame.href
      : null
    : keyframeHref(stream);
  const canUpdate = !replay && updating && isServedOrigin(window.location.protocol);
  const liveUrl = canUpdate ? liveEmbedUrl(stream) : null;
  const active = canUpdate && isActiveStream(stream);
  const { capture, viewport, captureFailed, failed, pending, slowLoad } = useCardCapture(
    stream,
    keyframe,
    liveThumb,
    liveUrl,
    serverStopped,
  );
  const liveView = !!(liveThumb && liveUrl);
  const text = cardText(stream, { name, replay, canUpdate, active, liveView, now });
  return (
    <article
      className={`panel card${pinned ? " pinned" : ""}`}
      data-stream-id={stream.id}
      aria-label={name}
      data-compared={compared || undefined}
      style={
        { "--preview-ratio": viewport ? viewport.width / viewport.height : 1.6 } as CSSProperties
      }
    >
      <CardPreview
        stream={stream}
        name={name}
        liveUrl={liveThumb ? liveUrl : null}
        keyframe={keyframe}
        capture={capture}
        captureFailed={captureFailed}
        failed={failed}
        pending={pending}
        replay={replay}
        active={active}
        text={text}
        viewport={viewport}
        onOpen={onOpen}
      />
      {slowLoad ? (
        <p className="capture-loading" role="status">
          Loading selected capture…{capture.decoded ? " Previous capture shown." : ""}
        </p>
      ) : null}
      <CardCaption
        stream={stream}
        name={name}
        replay={replay}
        reviewOutcome={reviewOutcome}
        active={active}
        text={text}
        slowLoad={slowLoad}
        previousShown={!!capture.decoded}
        pinned={pinned}
        onPin={onPin}
        onOpen={onOpen}
        details={
          <CardDetails
            stream={stream}
            name={name}
            replay={replay}
            reviewOutcome={reviewOutcome}
            active={active}
            liveView={liveView}
            text={text}
            viewport={viewport}
            pinned={pinned}
            compared={compared}
            comparisonFull={comparisonFull}
            onPin={onPin}
            onCompare={onCompare}
            onOpen={onOpen}
          />
        }
      />
      {failed ? (
        <button type="button" className="card-retry" onClick={capture.retry}>
          Retry frame
        </button>
      ) : null}
    </article>
  );
}

/** The thumb: the live desktop, the capture, the last terminal lines, or why there is none. */
function CardPreview({
  stream,
  name,
  liveUrl,
  keyframe,
  capture,
  captureFailed,
  failed,
  pending,
  replay,
  active,
  text,
  viewport,
  onOpen,
}: {
  stream: ObserverStream;
  name: string;
  /** Set only when the tile streams the live desktop. */
  liveUrl: string | null;
  keyframe: string | null;
  capture: DecodedImageState;
  captureFailed: boolean;
  failed: boolean;
  pending: boolean;
  replay: GridMoment | undefined;
  active: boolean;
  text: CardText;
  viewport: Size | undefined;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="card-preview">
      <div
        className="thumb"
        style={{ aspectRatio: viewport ? `${viewport.width} / ${viewport.height}` : "16 / 10" }}
      >
        {liveUrl ? (
          <iframe
            sandbox={liveEmbedSandbox(stream)}
            className="thumb-live"
            src={liveUrl}
            title={`Live thumb · ${name}`}
            referrerPolicy="no-referrer"
            aria-hidden="true"
            tabIndex={-1}
          />
        ) : keyframe ? (
          <>
            {capture.slots.map((slot) => (
              <img
                key={slot.key}
                className={
                  slot.pending
                    ? "capture-pending"
                    : captureFailed
                      ? "capture-unavailable"
                      : "keyframe"
                }
                src={slot.href}
                data-requested-src={keyframe}
                alt={
                  slot.pending
                    ? ""
                    : `${pending && capture.decoded ? "Previous capture" : "Recorded screen"} from ${name}`
                }
                aria-hidden={slot.pending || undefined}
                loading="lazy"
                decoding="async"
                onLoad={(event) => {
                  void capture.loaded(event.currentTarget, slot.key);
                }}
                onError={() => capture.errored(slot.key)}
              />
            ))}
            {failed ? (
              <div className="thumb-ph frame-unavailable">
                <span className="ph-state">Frame unavailable</span>
              </div>
            ) : null}
          </>
        ) : !replay && stream.terminalPlain ? (
          <div className="thumb-term">
            <TerminalCast lines={terminalLines(stream.terminalPlain)} />
          </div>
        ) : (
          <div className="thumb-ph">
            <span className="ph-state">
              {failed
                ? "Frame unavailable"
                : replay
                  ? text.captureLabel
                  : stream.status === "queued"
                    ? stream.sim.currentStep
                    : active
                      ? "Waiting for the first capture…"
                      : "No captured screen"}
            </span>
          </div>
        )}
        <button
          type="button"
          className="open-overlay"
          aria-label={text.openLabel}
          onClick={() => onOpen(stream.id)}
        />
      </div>
    </div>
  );
}

/**
 * The caption row: the name, the replay capture's age or the outcome, the pin toggle when pinning
 * is offered (a plain pin mark when it is not), and the details popover (`details`).
 */
function CardCaption({
  stream,
  name,
  replay,
  reviewOutcome,
  active,
  text,
  slowLoad,
  previousShown,
  pinned,
  onPin,
  onOpen,
  details,
}: {
  stream: ObserverStream;
  name: string;
  replay: GridMoment | undefined;
  reviewOutcome: string | undefined;
  active: boolean;
  text: CardText;
  slowLoad: boolean;
  /** A previous capture stays visible while the selected one loads. */
  previousShown: boolean;
  pinned: boolean;
  onPin: ((id: string) => void) | undefined;
  onOpen: (id: string) => void;
  details: ReactNode;
}) {
  return (
    <div className="card-caption" data-direct-pin={onPin ? "" : undefined}>
      {pinned && !onPin ? (
        <span
          className="card-pin"
          role="img"
          aria-label="Pinned participant"
          title="Pinned participant"
        >
          <ReviewIcon name="pin" />
        </span>
      ) : null}
      <div className="card-identity">
        <button type="button" className="card-name" title={name} onClick={() => onOpen(stream.id)}>
          {name}
        </button>
        {replay ? (
          <span
            className="card-capture-time"
            title={
              slowLoad
                ? `Loading the selected capture.${previousShown ? " The previous capture remains visible." : ""}`
                : text.captureLabel
            }
          >
            {slowLoad ? (
              "Loading capture…"
            ) : replay.kind === "capture" ? (
              <span className="card-capture-age">
                {formatDuration(Math.floor(replay.ageMs / 1000) * 1000)} ago
              </span>
            ) : (
              text.captureLabel
            )}
          </span>
        ) : (
          <span
            className={`card-outcome${reviewOutcome ? " reviewed-outcome" : ""}${active ? " active" : ""}${text.flagged ? " flagged" : ""}`}
            title={
              reviewOutcome
                ? `Independent analysis: ${reviewOutcome}. Recorded actor: ${stream.actor?.status ?? "not retained"}.`
                : (text.previewLabel ?? text.outcome)
            }
          >
            {reviewOutcome ? `Analysis: ${reviewOutcome}` : (text.sourceLabel ?? text.outcome)}
          </span>
        )}
      </div>
      {onPin ? (
        <IconButton
          className="card-icon card-pin-toggle"
          label={`${pinned ? "Unpin" : "Pin"} participant ${name} ${pinned ? "from" : "to"} top`}
          hint={
            pinned
              ? "Unpin participant from the top of the grid"
              : "Pin participant to the top of the grid"
          }
          aria-pressed={pinned}
          onClick={() => onPin(stream.id)}
        >
          {pinned ? (
            <span className="card-pin" role="img" aria-label="Pinned participant">
              <ReviewIcon name="pin" />
            </span>
          ) : (
            <ReviewIcon name="pin" />
          )}
        </IconButton>
      ) : null}
      {details}
    </div>
  );
}
