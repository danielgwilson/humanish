import { useState } from "react";
import { Select } from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import type { Zoom } from "./player-stage";
import type { ObserverStream } from "@/lib/observer-data";
import {
  frameAtElapsedMs,
  frameElapsedMs,
  isActionRow,
  type PlayerModel,
} from "@/lib/player-model";
import type { PlayerPlayback } from "@/lib/use-player-playback";
import { formatRunTime } from "../../src/run/run-clock.js";

/** Previous and next capture buttons, disabled at the first and last capture. */
function FrameStep({ playback, count }: { playback: PlayerPlayback; count: number }) {
  return (
    <>
      <IconButton
        className="tbtn"
        label="Previous frame"
        onClick={() => playback.seek(playback.frame - 1)}
        disabled={playback.frame <= 0}
      >
        <ReviewIcon name="previous-frame" />
      </IconButton>
      <IconButton
        className="tbtn"
        label="Next frame"
        onClick={() => playback.seek(playback.frame + 1)}
        disabled={playback.frame >= count - 1}
      >
        <ReviewIcon name="next-frame" />
      </IconButton>
    </>
  );
}

function FullscreenButton({ onFullscreen }: { onFullscreen: () => void }) {
  return (
    <IconButton className="tbtn" label="Fullscreen" onClick={onFullscreen}>
      <ReviewIcon name="fullscreen" />
    </IconButton>
  );
}

/** The player's own transport, shown when no study clock controls playback. */
export function PlayerTransport({
  model,
  playback,
  speed,
  onCycleSpeed,
  onFullscreen,
}: {
  model: PlayerModel;
  playback: PlayerPlayback;
  speed: number;
  onCycleSpeed: () => void;
  onFullscreen: () => void;
}) {
  const { frame, playing } = playback;
  const frames = model.frames;
  const elapsed = playback.elapsed;
  const duration = frameElapsedMs(model, Math.max(0, frames.length - 1));
  return (
    <div className="transport">
      <IconButton
        className="tbtn"
        label={playing ? "Pause" : "Play"}
        hint={playing ? "Pause playback" : "Play recording"}
        onClick={playback.togglePlay}
        disabled={frames.length === 0}
      >
        <ReviewIcon name={playing ? "pause" : "play"} />
      </IconButton>
      <FrameStep playback={playback} count={frames.length} />
      <span className="elapsed">
        {formatRunTime(elapsed)} <span>/ {formatRunTime(duration)}</span>
      </span>
      <PlayerScrubber model={model} playback={playback} duration={duration} />
      <span className="counter">
        {Math.max(0, frame + 1)} / {frames.length}
      </span>
      <button
        type="button"
        className="tbtn speed"
        aria-label="Playback speed"
        onClick={onCycleSpeed}
      >
        {speed}×
      </button>
      <FullscreenButton onFullscreen={onFullscreen} />
    </div>
  );
}

/**
 * The recording's time scrubber: played track, a tick per capture with recorded pins, the
 * notable-ending flag and a hovered-capture preview. Keys move between recorded captures, since
 * native millisecond steps would snap back to the same sparse capture.
 */
function PlayerScrubber({
  model,
  playback,
  duration,
}: {
  model: PlayerModel;
  playback: PlayerPlayback;
  duration: number;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const { frame, elapsed, seek } = playback;
  const frames = model.frames;
  const markerLeft = (index: number) =>
    `${duration > 0 ? (100 * frameElapsedMs(model, index)) / duration : 0}%`;
  return (
    <div className="scrubwrap" onPointerLeave={() => setPreview(null)}>
      {preview !== null && frames[preview] ? (
        <div className="scrub-preview" aria-hidden="true">
          <img src={frames[preview]?.href} alt="" />
          <span>
            {formatRunTime(frameElapsedMs(model, preview))} · frame {preview + 1}
          </span>
        </div>
      ) : null}
      <div className="scrub-track" aria-hidden="true">
        <div className="scrub-played" style={{ width: markerLeft(Math.max(0, frame)) }} />
        {[...playback.rows.pins.keys()].slice(0, 200).map((index) => (
          <span key={index} className="scrub-tick" style={{ left: markerLeft(index) }} />
        ))}
        {playback.rows.notableEnd && frames.length > 0 ? (
          <span className="scrub-flag">⚑</span>
        ) : null}
      </div>
      <input
        className="scrub"
        type="range"
        min={0}
        max={Math.max(1, duration)}
        step={1}
        value={elapsed}
        disabled={frames.length < 2}
        aria-label="Seek recording time"
        aria-valuetext={`${formatRunTime(elapsed)} of ${formatRunTime(duration)}, frame ${Math.max(0, frame + 1)} of ${frames.length}`}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          const page = Math.max(1, Math.ceil(frames.length / 10));
          const next =
            event.key === "ArrowRight" || event.key === "ArrowUp"
              ? frame + 1
              : event.key === "ArrowLeft" || event.key === "ArrowDown"
                ? frame - 1
                : event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? frames.length - 1
                    : event.key === "PageUp"
                      ? frame + page
                      : event.key === "PageDown"
                        ? frame - page
                        : null;
          if (next === null) return;
          event.preventDefault();
          seek(next);
        }}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const thumb = Number.parseFloat(
            getComputedStyle(event.currentTarget).getPropertyValue("--scrub-thumb-size"),
          );
          const inset = Number.isFinite(thumb) ? thumb / 2 : 0;
          const travel = bounds.width - inset * 2;
          if (travel > 0)
            setPreview(
              frameAtElapsedMs(
                model,
                Math.max(0, Math.min(1, (event.clientX - bounds.left - inset) / travel)) * duration,
              ),
            );
        }}
        onChange={(event) => seek(frameAtElapsedMs(model, Number(event.target.value)))}
      />
    </div>
  );
}

const ZOOM_OPTIONS = [
  { value: "fit", label: "Fit" },
  { value: "actual", label: "Actual size" },
  { value: "0.5", label: "50%" },
  { value: "1.5", label: "150%" },
  { value: "2", label: "200%" },
  { value: "3", label: "300%" },
];

/**
 * The review toolbar under the stage: capture stepping under a study clock (or Skip waits for
 * local playback), Next action, Next flagged frame, zoom, moment link, the original frame, the
 * shortcut list and the redaction state.
 */
export function PlayerReviewTools({
  model,
  stream,
  playback,
  skipWaits,
  onSkipWaits,
  zoom,
  onZoom,
  onFullscreen,
  onCopyMoment,
}: {
  model: PlayerModel;
  stream: ObserverStream;
  playback: PlayerPlayback;
  skipWaits: boolean;
  onSkipWaits: (skip: boolean) => void;
  zoom: Zoom;
  onZoom: (zoom: Zoom) => void;
  onFullscreen: () => void;
  onCopyMoment: () => void;
}) {
  const { frame, current, eventId, selectedRow, live } = playback;
  const frames = model.frames;
  const selectedPosition = selectedRow ? playback.rows.positions.get(selectedRow.id) : undefined;
  const nextAction = model.rows.find(
    (row, index) =>
      isActionRow(row) &&
      (selectedPosition === undefined ? row.frameIndex >= frame : index > selectedPosition),
  );
  const nextFinding = playback.rows.findings.find((index) => index > frame);
  const raw = current?.redaction === "none" || stream.actor?.redaction.screenshots === "raw";
  return (
    <div className="player-review-tools">
      {playback.controlled ? (
        <>
          {frames.length > 0 ? (
            <>
              <FrameStep playback={playback} count={frames.length} />
              <span className="counter">
                {Math.max(0, frame + 1)} / {frames.length}
              </span>
            </>
          ) : null}
          <FullscreenButton onFullscreen={onFullscreen} />
        </>
      ) : (
        <label>
          <Checkbox checked={skipWaits} onCheckedChange={onSkipWaits} /> Skip waits
        </label>
      )}
      <button
        type="button"
        className="tbtn"
        disabled={nextAction === undefined}
        onClick={() => {
          if (nextAction !== undefined) playback.seekEntry(nextAction);
        }}
      >
        Next action
      </button>
      <button
        type="button"
        className="tbtn"
        disabled={nextFinding === undefined}
        onClick={() => {
          if (nextFinding !== undefined) playback.seek(nextFinding);
        }}
        title="Frame-linked trace findings or notable completion. Run/setup notices are separate in Warnings & findings."
      >
        Next flagged frame
      </button>
      {current || live ? (
        <label className="zoom-control">
          View{" "}
          <Select
            label="Image zoom"
            value={String(zoom)}
            disabled={live !== null}
            onValueChange={(value) =>
              onZoom(value === "fit" || value === "actual" ? value : Number(value))
            }
            options={ZOOM_OPTIONS}
          />
        </label>
      ) : null}
      {current ? (
        <button
          type="button"
          className="tbtn"
          disabled={!!eventId && !selectedRow}
          onClick={onCopyMoment}
        >
          Copy moment link
        </button>
      ) : null}
      {current ? (
        <a className="tbtn" href={current.href} target="_blank" rel="noopener noreferrer" download>
          Original frame
        </a>
      ) : null}
      {frames.length > 0 ? (
        <details className="player-shortcuts">
          <summary>Shortcuts</summary>
          <span>
            Space: play or pause · ← / →: previous or next frame. Zoomed image: drag or scroll to
            pan. Use Tab to reach controls; shortcuts leave editable fields alone.
          </span>
        </details>
      ) : null}
      {raw ? (
        <span className="rawchip" title="Raw local screenshots. Redact before publishing.">
          RAW
        </span>
      ) : current?.redaction ? (
        <span className="frame-redaction">{current.redaction}</span>
      ) : null}
    </div>
  );
}
