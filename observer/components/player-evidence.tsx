import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/artifact-href";
import { recordingContains } from "@/lib/grid-recording";
import { liveEmbedSandbox } from "@/lib/live";
import type { ObserverStream } from "@/lib/observer-data";
import { isActionRow, isWaitRow, rowElapsedMs, type PlayerModel } from "@/lib/player-model";
import type { PlayerPlayback } from "@/lib/use-player-playback";
import type { StudyPlayerControl } from "@/lib/use-study-playback";
import {
  formatRunTime,
  recordingInterval as streamRecordingInterval,
} from "../../src/run/run-clock.js";
import { PlayerStage, type Zoom } from "./player-stage";
import { RecordingVideo } from "./recording-video";

/**
 * Whether the stage shows the participant's desktop video: only under a study clock, at a moment
 * the recording covers, and until that recording fails to load. After a failure the stage shows
 * the recorded screenshot for this participant's recording.
 */
export function useRecordingFallback(
  stream: ObserverStream,
  studyPlayback: StudyPlayerControl | undefined,
) {
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const interval = studyPlayback ? streamRecordingInterval(stream.recording) : null;
  const key = interval ? `${stream.id}:${interval.recording.path}` : null;
  const failed = key !== null && unavailable === key;
  const show =
    studyPlayback !== undefined && !failed && recordingContains(interval, studyPlayback.atMs);
  return { interval, key, failed, show, onUnavailable: () => setUnavailable(key) };
}
type RecordingFallback = ReturnType<typeof useRecordingFallback>;

/** The stage: the desktop video, the live desktop or the recorded capture with its pins, or a
 * sentence saying why there is nothing to show. */
export function PlayerScreen({
  stream,
  model,
  playback,
  studyPlayback,
  recording,
  updating,
  zoom,
  streamRevision,
  label,
}: {
  stream: ObserverStream;
  model: PlayerModel;
  playback: PlayerPlayback;
  studyPlayback: StudyPlayerControl | undefined;
  recording: RecordingFallback;
  updating: boolean;
  zoom: Zoom;
  streamRevision: number;
  label: string;
}) {
  if (recording.show && recording.interval && studyPlayback && studyPlayback.atMs !== null)
    return (
      <RecordingVideo
        key={recording.key}
        interval={recording.interval}
        atMs={studyPlayback.atMs}
        playing={studyPlayback.playing}
        speed={studyPlayback.speed}
        seekRevision={studyPlayback.seekRevision}
        label={label}
        onUnavailable={recording.onUnavailable}
      />
    );
  const emptyText = studyPlayback?.unavailableFrame
    ? "This addressed frame is unavailable in the current recording. Choose another moment below."
    : studyPlayback?.reviewing && studyPlayback.moment.kind === "before-first"
      ? "No capture had been recorded for this participant at the study cursor."
      : studyPlayback?.reviewing && studyPlayback.moment.kind === "timing-unavailable"
        ? "Capture timing is unavailable for this participant at the study cursor."
        : studyPlayback?.reviewing && studyPlayback.moment.kind === "no-captures"
          ? "This participant has no captured screen at the study cursor."
          : model.frames.length > 0
            ? "This addressed frame is unavailable in the current recording. Choose another moment below."
            : !updating
              ? "This saved snapshot contains no recorded screenshots. It cannot show current participant activity."
              : playback.active
                ? playback.preparing
                  ? "The participant is preparing. Waiting for its first recorded frame."
                  : "Waiting for the first recorded frame. The participant is still running."
                : "This participant ended without a recorded screenshot.";
  return (
    <PlayerStage
      sandbox={liveEmbedSandbox(stream)}
      frame={playback.current}
      count={model.frames.length}
      // Computer-use actions use desktop pixels, not the browser CSS layout viewport.
      // Older browser recordings lack desktopGeometry and retain their viewport mapping.
      viewport={
        stream.desktopGeometry?.screen.verified ??
        stream.desktopGeometry?.screen.requested ??
        stream.viewport
      }
      pins={playback.pins}
      zoom={zoom}
      live={playback.live}
      streamRevision={streamRevision}
      label={label}
      emptyText={emptyText}
    />
  );
}

/** The selected entry above the stage: its kind, its time, and how its time relates to the
 * capture shown. Renders nothing when no entry is selected. */
export function SelectedEntry({
  model,
  playback,
}: {
  model: PlayerModel;
  playback: PlayerPlayback;
}) {
  const { selectedRow, eventId, current, frame } = playback;
  if (!selectedRow && !eventId) return null;
  return (
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
              ? `Capture ${model.paced === "recorded" ? formatRunTime(playback.elapsed) : new Date(current.atMs).toISOString()}`
              : `Capture ${frame + 1} · time unavailable`}
            {current?.atMs !== undefined && selectedRow.atMs !== undefined
              ? current.atMs === selectedRow.atMs
                ? " · same recorded time"
                : ` · ${formatDuration(Math.abs(selectedRow.atMs - current.atMs))} ${selectedRow.atMs > current.atMs ? "before" : "after"} entry`
              : " · associated by trace order"}
          </span>
          <button type="button" className="tbtn" onClick={() => playback.seek(frame)}>
            Show capture interval
          </button>
        </>
      ) : (
        <span>
          The selected entry is unavailable in this capture interval. Choose an entry from the
          activity list.
        </span>
      )}
    </div>
  );
}

/**
 * The note under the controls: when the shown capture was taken (counted every second while a
 * participant runs), whether desktop video was available, how old a held study capture is, and
 * what a long capture interval leaves out.
 */
export function PlayerEvidenceNote({
  stream,
  model,
  playback,
  studyPlayback,
  recording,
}: {
  stream: ObserverStream;
  model: PlayerModel;
  playback: PlayerPlayback;
  studyPlayback: StudyPlayerControl | undefined;
  recording: RecordingFallback;
}) {
  const { active, following, live, current, frame, hold, skipDuration } = playback;
  const frames = model.frames;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const captureAge = current?.atMs !== undefined ? Math.max(0, now - current.atMs) : null;
  // The study note below already says when a selected frame has no capture time.
  const studyCaptureNote =
    !recording.show &&
    studyPlayback?.reviewing &&
    current &&
    studyPlayback.moment.kind === "capture";
  const captureLine = live
    ? "Read-only desktop; connection health is managed by the provider."
    : following && active && current
      ? captureAge === null
        ? "Capture time unavailable"
        : `Captured ${formatDuration(captureAge)} ago`
      : recording.show && studyPlayback && studyPlayback.atMs !== null
        ? `Desktop video · ${new Date(studyPlayback.atMs).toISOString()}`
        : current?.atMs !== undefined
          ? `Captured ${new Date(current.atMs).toISOString()}`
          : studyPlayback?.moment.kind === "before-first"
            ? "No capture yet"
            : studyCaptureNote
              ? null
              : "Capture timestamps unavailable";
  return (
    <div className="player-evidence-note">
      {captureLine ? <span className="capture-line">{captureLine}</span> : null}
      {frames.length === 0 ? (
        <span>
          {active
            ? `${playback.preparing ? "Preparing" : "Running"} · awaiting the first recorded screenshot`
            : "No recorded screenshots"}
        </span>
      ) : null}
      {recording.failed ? (
        <span>
          Desktop video could not load; showing recorded screenshot evidence when available.
        </span>
      ) : stream.recording && studyPlayback?.reviewing && !recording.show ? (
        <span>
          Desktop video unavailable at this study moment; showing recorded screenshot evidence when
          available.
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
      {!recording.show &&
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
  );
}
