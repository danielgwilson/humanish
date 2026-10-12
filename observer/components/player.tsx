import { Select } from "./ui/select";
import { Checkbox } from "./ui/checkbox";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { formatDuration } from "@/lib/artifact-href";
import { liveEmbedSandbox } from "@/lib/live";
import type { ObserverData, ObserverStream } from "@/lib/observer-data";
import {
  boundedWindow,
  frameAtElapsedMs,
  frameElapsedMs,
  isActionRow,
  isWaitRow,
  rowElapsedMs,
  type PlayerModel,
} from "@/lib/player-model";
import type { PlayerView } from "@/lib/player-state";
import type { StudyPlayerControl } from "@/lib/use-study-playback";
import { usePlayerPlayback } from "@/lib/use-player-playback";
import { usePlayerPreferences } from "@/lib/use-player-preferences";
import { formatHash } from "@/lib/route";
import { participantLabels } from "@/lib/participant-label";
import { PlayerStage, type Zoom } from "./player-stage";
import { PlayerInspector } from "./player-inspector";
import { recordingContains } from "@/lib/grid-recording";
import {
  formatRunTime,
  recordingInterval as streamRecordingInterval,
} from "../../src/run/run-clock.js";
import { RecordingVideo } from "./recording-video";
import type { ParticipantAnalysis as AnalysisReview } from "@/lib/study-report";
import "@/styles/player.css";

const FILMSTRIP_LIMIT = 40;

export function Player({
  data,
  stream,
  model,
  initialFrame = null,
  initialMode = null,
  initialEventId = null,
  navigationRevision = 0,
  updating = true,
  onViewChange,
  recordedActorStatus,
  analysisReview,
  studyPlayback,
  navigation,
  outcome,
}: {
  /** Return and participant paging controls, shown at the start of the heading line. */
  navigation?: ReactNode;
  /** The analyzed outcome, shown after the recorded status. */
  outcome?: ReactNode;
  data: ObserverData;
  stream: ObserverStream;
  model: PlayerModel;
  initialFrame?: number | null;
  initialMode?: "live" | "replay" | null;
  initialEventId?: string | null;
  recordedActorStatus?: string | undefined;
  analysisReview?: AnalysisReview | undefined;
  /** Shared study clock owns playback; this view only projects its participant. */
  studyPlayback?: StudyPlayerControl | undefined;
  /** An explicit in-app navigation may repeat the original address after local seeking. */
  navigationRevision?: number;
  /** Source capability, not the most recent poll result; transient failures stay updating. */
  updating?: boolean;
  onViewChange?: (view: PlayerView) => void;
}) {
  const prefs = usePlayerPreferences();
  const { preferences } = prefs;
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [feedPage, setFeedPage] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const [unavailableRecording, setUnavailableRecording] = useState<string | null>(null);
  const [scrubPreview, setScrubPreview] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const [streamRevision, setStreamRevision] = useState(0);
  const playback = usePlayerPlayback({
    stream,
    model,
    initialFrame,
    initialMode,
    initialEventId,
    navigationRevision,
    updating,
    studyPlayback,
    speed: preferences.speed,
    skipWaits: preferences.skipWaits,
    onViewChange,
    onNavigate: (reason) => {
      setFeedPage(null);
      if (reason === "seek") setNotice(null);
    },
  });
  const { frame, current, eventId, selectedRow, controlled, active, preparing } = playback;
  const { following, live, playing, elapsed, hold, skipDuration, rows: rowIndex } = playback;
  const { seek, seekEntry, togglePlay, jumpToLive, pins: currentPins } = playback;
  const lifecycle = preparing ? "Preparing" : "Running";
  const viewerRef = useRef<HTMLDivElement>(null);
  const filmRef = useRef<HTMLDivElement>(null);
  const frames = model.frames;
  // Computer-use actions use desktop pixels, not the browser CSS layout viewport.
  // Older browser recordings lack desktopGeometry and retain their viewport mapping.
  const coordinateSpace =
    stream.desktopGeometry?.screen.verified ??
    stream.desktopGeometry?.screen.requested ??
    stream.viewport;
  const raw = current?.redaction === "none" || stream.actor?.redaction.screenshots === "raw";
  const notableEnd = rowIndex.notableEnd;
  const duration = frameElapsedMs(model, Math.max(0, frames.length - 1));
  const recordingInterval = studyPlayback ? streamRecordingInterval(stream.recording) : null;
  const recordingKey = recordingInterval
    ? `${stream.id}:${recordingInterval.recording.path}`
    : null;
  const recordingFailed = recordingKey !== null && unavailableRecording === recordingKey;
  const showRecording =
    studyPlayback && !recordingFailed && recordingContains(recordingInterval, studyPlayback.atMs);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const selectedPosition = selectedRow ? rowIndex.positions.get(selectedRow.id) : undefined;
  const filmWindow = boundedWindow(frames.length, Math.max(0, frame), FILMSTRIP_LIMIT);
  useEffect(() => {
    // Scroll only as far as it takes to show the selected thumbnail.
    const pane = filmRef.current;
    const thumb = pane?.querySelector("[data-on]");
    if (!pane || !(thumb instanceof HTMLElement)) return;
    const p = pane.getBoundingClientRect();
    const t = thumb.getBoundingClientRect();
    if (t.left < p.left) pane.scrollLeft += t.left - p.left;
    else if (t.right > p.right) pane.scrollLeft += t.right - p.right;
  }, [frame]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else {
        // The study dock is a sibling of the player content, so fullscreen must
        // include their common shell rather than strand playback controls.
        const target = controlled
          ? (viewerRef.current?.closest<HTMLElement>(".main") ?? viewerRef.current)
          : viewerRef.current;
        if (target?.requestFullscreen) await target.requestFullscreen();
        else throw new Error("unavailable");
      }
      setNotice(null);
    } catch {
      setNotice(
        "Fullscreen is unavailable in this browser or was declined. The player remains usable here.",
      );
    }
  };
  const copyMoment = async () => {
    if (!current) return;
    // Deliberately copies a replay address, even while following the live desktop.
    const link = `${window.location.href.split("#")[0] ?? ""}${formatHash(stream.id, current.index, null, selectedRow?.id)}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("unavailable");
      await navigator.clipboard.writeText(link);
      setManualLink(null);
      setNotice("Link copied to this recorded moment.");
    } catch {
      setManualLink(link);
      setNotice("Copy this moment link below. Clipboard access is unavailable.");
    }
  };
  const nextAction = model.rows.find(
    (row, index) =>
      isActionRow(row) &&
      (selectedPosition === undefined ? row.frameIndex >= frame : index > selectedPosition),
  );
  const nextFinding = rowIndex.findings.find((index) => index > frame);
  const markerLeft = (index: number) =>
    `${duration > 0 ? (100 * frameElapsedMs(model, index)) / duration : 0}%`;
  const captureAge = current?.atMs !== undefined ? Math.max(0, now - current.atMs) : null;
  const modeLabel = !updating
    ? recordedActorStatus
      ? `Actor record: ${recordedActorStatus}`
      : `Participant status: ${stream.statusLabel || stream.status}`
    : active
      ? live
        ? `${lifecycle} · Live desktop`
        : following
          ? `${lifecycle} · Latest capture`
          : controlled
            ? `${lifecycle} · Study replay`
            : `${lifecycle} · Replay at ${formatRunTime(elapsed)}`
      : `${stream.status === "failed" || stream.status === "blocked" || stream.status === "timed_out" ? "Stopped" : "Finished"} · Recording`;
  const participantName = participantLabels(data.streams).get(stream.id) ?? stream.label;
  // The study note below already says when a selected frame has no capture time.
  const studyCaptureNote =
    !showRecording &&
    studyPlayback?.reviewing &&
    current &&
    studyPlayback.moment.kind === "capture";
  const captureLine = live
    ? "Read-only desktop; connection health is managed by the provider."
    : following && active && current
      ? captureAge === null
        ? "Capture time unavailable"
        : `Captured ${formatDuration(captureAge)} ago`
      : showRecording && studyPlayback?.atMs !== null
        ? `Desktop video · ${new Date(studyPlayback.atMs).toISOString()}`
        : current?.atMs !== undefined
          ? `Captured ${new Date(current.atMs).toISOString()}`
          : studyPlayback?.moment.kind === "before-first"
            ? "No capture yet"
            : studyCaptureNote
              ? null
              : "Capture timestamps unavailable";
  const emptyText = studyPlayback?.unavailableFrame
    ? "This addressed frame is unavailable in the current recording. Choose another moment below."
    : studyPlayback?.reviewing && studyPlayback.moment.kind === "before-first"
      ? "No capture had been recorded for this participant at the study cursor."
      : studyPlayback?.reviewing && studyPlayback.moment.kind === "timing-unavailable"
        ? "Capture timing is unavailable for this participant at the study cursor."
        : studyPlayback?.reviewing && studyPlayback.moment.kind === "no-captures"
          ? "This participant has no captured screen at the study cursor."
          : frames.length > 0
            ? "This addressed frame is unavailable in the current recording. Choose another moment below."
            : !updating
              ? "This saved snapshot contains no recorded screenshots. It cannot show current participant activity."
              : active
                ? preparing
                  ? "The participant is preparing. Waiting for its first recorded frame."
                  : "Waiting for the first recorded frame. The participant is still running."
                : "This participant ended without a recorded screenshot.";

  return (
    <div
      className="player evidence-player"
      data-inspector={preferences.inspector ? "open" : "closed"}
    >
      <div className="viewer" ref={viewerRef}>
        <div className="player-heading">
          {navigation ? <div className="player-navigation">{navigation}</div> : null}
          <div className="player-mode">
            <b className="player-participant" title={participantName}>
              {participantName}
            </b>
            <strong>{modeLabel}</strong>
            {outcome}
          </div>
          {live ? (
            <button
              type="button"
              className="tbtn"
              onClick={() => {
                setStreamRevision((value) => value + 1);
                setNotice(
                  "Reloading the read-only desktop connection. This does not restart the participant; connection health is managed by the provider.",
                );
              }}
            >
              Reload stream
            </button>
          ) : null}
          {active && !following ? (
            <button
              type="button"
              className="tbtn live-jump"
              aria-label="Jump to live"
              onClick={jumpToLive}
            >
              Go live
            </button>
          ) : null}
          <button
            type="button"
            className="tbtn"
            aria-label={preferences.inspector ? "Hide inspector" : "Show inspector"}
            aria-expanded={preferences.inspector}
            onClick={prefs.toggleInspector}
          >
            Inspector {preferences.inspector ? "−" : "+"}
          </button>
        </div>
        {selectedRow || eventId ? (
          <div className="player-entry-context" role="group" aria-label="Selected evidence">
            {selectedRow ? (
              <>
                <span className="entry-label">
                  {selectedRow.kind === "reasoning"
                    ? "Reported thinking"
                    : isActionRow(selectedRow)
                      ? "Recorded action"
                      : isWaitRow(selectedRow)
                        ? "Recorded wait"
                        : "Recorded entry"}
                  {selectedRow.atMs !== undefined
                    ? ` · ${model.paced === "recorded" ? formatRunTime(rowElapsedMs(model, selectedRow)) : new Date(selectedRow.atMs).toISOString()}`
                    : " · Time unavailable"}
                </span>
                <span className="entry-title">{selectedRow.title}</span>
                {selectedRow.text ? (
                  <details className="entry-text">
                    <summary>Read entry</summary>
                    <p>{selectedRow.text}</p>
                  </details>
                ) : null}
                <span className="entry-capture">
                  {current?.atMs !== undefined
                    ? `Capture ${model.paced === "recorded" ? formatRunTime(elapsed) : new Date(current.atMs).toISOString()}`
                    : `Capture ${frame + 1} · time unavailable`}
                  {current?.atMs !== undefined && selectedRow.atMs !== undefined
                    ? current.atMs === selectedRow.atMs
                      ? " · same recorded time"
                      : ` · ${formatDuration(Math.abs(selectedRow.atMs - current.atMs))} ${selectedRow.atMs > current.atMs ? "before" : "after"} entry`
                    : " · associated by trace order"}
                </span>
                <button type="button" className="tbtn" onClick={() => seek(frame)}>
                  Show capture interval
                </button>
              </>
            ) : eventId ? (
              <span>
                The selected entry is unavailable in this capture interval. Choose an entry from the
                activity list.
              </span>
            ) : (
              <span>
                {live
                  ? "Live desktop · select recorded activity to inspect an entry."
                  : `${currentPins.length ? `${currentPins.length} recorded ${currentPins.length === 1 ? "pin" : "pins"} in this capture interval. ` : ""}Select an activity entry to inspect its time and location.`}
              </span>
            )}
          </div>
        ) : null}
        {showRecording && recordingInterval && studyPlayback.atMs !== null ? (
          <RecordingVideo
            key={recordingKey}
            interval={recordingInterval}
            atMs={studyPlayback.atMs}
            playing={studyPlayback.playing}
            speed={studyPlayback.speed}
            seekRevision={studyPlayback.seekRevision}
            label={participantName}
            onUnavailable={() => setUnavailableRecording(recordingKey)}
          />
        ) : (
          <PlayerStage
            sandbox={liveEmbedSandbox(stream)}
            frame={current}
            count={frames.length}
            viewport={coordinateSpace}
            pins={currentPins}
            zoom={zoom}
            live={live}
            streamRevision={streamRevision}
            label={participantName}
            emptyText={emptyText}
          />
        )}
        {!controlled ? (
          <div className="transport">
            <IconButton
              className="tbtn"
              label={playing ? "Pause" : "Play"}
              hint={playing ? "Pause playback" : "Play recording"}
              onClick={togglePlay}
              disabled={frames.length === 0}
            >
              <ReviewIcon name={playing ? "pause" : "play"} />
            </IconButton>
            <IconButton
              className="tbtn"
              label="Previous frame"
              onClick={() => seek(frame - 1)}
              disabled={frame <= 0}
            >
              <ReviewIcon name="previous-frame" />
            </IconButton>
            <IconButton
              className="tbtn"
              label="Next frame"
              onClick={() => seek(frame + 1)}
              disabled={frame >= frames.length - 1}
            >
              <ReviewIcon name="next-frame" />
            </IconButton>
            <span className="elapsed">
              {formatRunTime(elapsed)} <span>/ {formatRunTime(duration)}</span>
            </span>
            <div className="scrubwrap" onPointerLeave={() => setScrubPreview(null)}>
              {scrubPreview !== null && frames[scrubPreview] ? (
                <div className="scrub-preview" aria-hidden="true">
                  <img src={frames[scrubPreview]?.href} alt="" />
                  <span>
                    {formatRunTime(frameElapsedMs(model, scrubPreview))} · frame {scrubPreview + 1}
                  </span>
                </div>
              ) : null}
              <div className="scrub-track" aria-hidden="true">
                <div className="scrub-played" style={{ width: markerLeft(Math.max(0, frame)) }} />
                {[...rowIndex.pins.keys()].slice(0, 200).map((index) => (
                  <span key={index} className="scrub-tick" style={{ left: markerLeft(index) }} />
                ))}
                {notableEnd && frames.length > 0 ? <span className="scrub-flag">⚑</span> : null}
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
                              ? frame + Math.max(1, Math.ceil(frames.length / 10))
                              : event.key === "PageDown"
                                ? frame - Math.max(1, Math.ceil(frames.length / 10))
                                : null;
                  if (next === null) return;
                  // Native millisecond steps snap back to the same sparse capture. Move
                  // between recorded boundaries so both arrow directions remain usable.
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
                    setScrubPreview(
                      frameAtElapsedMs(
                        model,
                        Math.max(0, Math.min(1, (event.clientX - bounds.left - inset) / travel)) *
                          duration,
                      ),
                    );
                }}
                onChange={(event) => seek(frameAtElapsedMs(model, Number(event.target.value)))}
              />
            </div>
            <span className="counter">
              {Math.max(0, frame + 1)} / {frames.length}
            </span>
            <button
              type="button"
              className="tbtn speed"
              aria-label="Playback speed"
              onClick={prefs.cycleSpeed}
            >
              {preferences.speed}×
            </button>
            <IconButton
              className="tbtn"
              label="Fullscreen"
              onClick={() => {
                void toggleFullscreen();
              }}
            >
              <ReviewIcon name="fullscreen" />
            </IconButton>
          </div>
        ) : null}
        <div className="player-review-tools">
          {controlled ? (
            <>
              {frames.length > 0 ? (
                <>
                  <IconButton
                    className="tbtn"
                    label="Previous frame"
                    onClick={() => seek(frame - 1)}
                    disabled={frame <= 0}
                  >
                    <ReviewIcon name="previous-frame" />
                  </IconButton>
                  <IconButton
                    className="tbtn"
                    label="Next frame"
                    onClick={() => seek(frame + 1)}
                    disabled={frame >= frames.length - 1}
                  >
                    <ReviewIcon name="next-frame" />
                  </IconButton>
                  <span className="counter">
                    {Math.max(0, frame + 1)} / {frames.length}
                  </span>
                </>
              ) : null}
              <IconButton
                className="tbtn"
                label="Fullscreen"
                onClick={() => {
                  void toggleFullscreen();
                }}
              >
                <ReviewIcon name="fullscreen" />
              </IconButton>
            </>
          ) : (
            <label>
              <Checkbox checked={preferences.skipWaits} onCheckedChange={prefs.setSkipWaits} /> Skip
              waits
            </label>
          )}
          <button
            type="button"
            className="tbtn"
            disabled={nextAction === undefined}
            onClick={() => {
              if (nextAction !== undefined) seekEntry(nextAction);
            }}
          >
            Next action
          </button>
          <button
            type="button"
            className="tbtn"
            disabled={nextFinding === undefined}
            onClick={() => {
              if (nextFinding !== undefined) seek(nextFinding);
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
                  setZoom(value === "fit" || value === "actual" ? value : Number(value))
                }
                options={[
                  { value: "fit", label: "Fit" },
                  { value: "actual", label: "Actual size" },
                  { value: "0.5", label: "50%" },
                  { value: "1.5", label: "150%" },
                  { value: "2", label: "200%" },
                  { value: "3", label: "300%" },
                ]}
              />
            </label>
          ) : null}
          {current ? (
            <button
              type="button"
              className="tbtn"
              disabled={!!eventId && !selectedRow}
              onClick={() => {
                void copyMoment();
              }}
            >
              Copy moment link
            </button>
          ) : null}
          {current ? (
            <a
              className="tbtn"
              href={current.href}
              target="_blank"
              rel="noopener noreferrer"
              download
            >
              Original frame
            </a>
          ) : null}
          {frames.length > 0 ? (
            <details className="player-shortcuts">
              <summary>Shortcuts</summary>
              <span>
                Space: play or pause · ← / →: previous or next frame. Zoomed image: drag or scroll
                to pan. Use Tab to reach controls; shortcuts leave editable fields alone.
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
        <div className="player-evidence-note">
          {captureLine ? <span className="capture-line">{captureLine}</span> : null}
          {frames.length === 0 ? (
            <span>
              {active
                ? `${lifecycle} · awaiting the first recorded screenshot`
                : "No recorded screenshots"}
            </span>
          ) : null}
          {recordingFailed ? (
            <span>
              Desktop video could not load; showing recorded screenshot evidence when available.
            </span>
          ) : stream.recording && studyPlayback?.reviewing && !showRecording ? (
            <span>
              Desktop video unavailable at this study moment; showing recorded screenshot evidence
              when available.
            </span>
          ) : null}
          {studyCaptureNote && studyPlayback.moment.kind === "capture" ? (
            <span>
              {current.atMs === undefined ? (
                "Capture time unavailable; frame selected directly."
              ) : (
                <>
                  {studyPlayback.moment.coverage === "after-last" ? "Last capture" : "Capture"} ·{" "}
                  {formatRunTime(studyPlayback.moment.ageMs)} before study cursor.
                </>
              )}
            </span>
          ) : null}
          {!showRecording &&
          frame >= 0 &&
          frame < frames.length - 1 &&
          hold >= 5000 &&
          model.paced === "recorded" ? (
            <span>
              Next capture +{formatDuration(hold)}. Changes between captures are not recorded.
              {skipDuration > 0
                ? ` Playback skips ${formatDuration(skipDuration)} of this capture interval containing recorded waits.`
                : ""}
            </span>
          ) : null}
          {stream.liveEnded === true ? <span>Desktop stream ended · recorded evidence</span> : null}
        </div>
        {notice ? (
          <p className="player-notice" role="status">
            {notice}
          </p>
        ) : null}
        {manualLink ? (
          <label className="moment-fallback">
            Moment link
            <input
              readOnly
              value={manualLink}
              aria-label="Moment link"
              onFocus={(event) => event.target.select()}
            />
          </label>
        ) : null}
        {frames.length > 0 ? (
          <div className="filmstrip" ref={filmRef} role="group" aria-label="Recorded frames">
            {filmWindow.start > 0 ? (
              <button
                type="button"
                className="tbtn film-page"
                onClick={() => seek(Math.max(0, filmWindow.start - 1))}
              >
                Earlier frames
              </button>
            ) : null}
            {frames.slice(filmWindow.start, filmWindow.end).map((f) => (
              <button
                key={f.itemId}
                type="button"
                className="fs"
                {...(f.index === frame ? { "data-on": "" } : {})}
                aria-label={`Frame ${f.index + 1}, ${formatRunTime(frameElapsedMs(model, f.index))}, ${f.title}`}
                onClick={() => seek(f.index)}
              >
                <span className="im">
                  <img src={f.href} alt="" loading="lazy" decoding="async" />
                </span>
                <span className="lab">
                  {formatRunTime(frameElapsedMs(model, f.index))} · {f.index + 1}
                </span>
              </button>
            ))}
            {filmWindow.end < frames.length ? (
              <button type="button" className="tbtn film-page" onClick={() => seek(filmWindow.end)}>
                Later frames
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <PlayerInspector
        open={preferences.inspector}
        width={preferences.width}
        onResize={prefs.resizeInspector}
        data={data}
        stream={stream}
        model={model}
        playback={playback}
        analysisReview={analysisReview}
        name={participantName}
        feedPage={feedPage}
        onFeedPage={setFeedPage}
      />
    </div>
  );
}
