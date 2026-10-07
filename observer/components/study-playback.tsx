import type { GridRecording } from "@/lib/grid-recording";
import { formatElapsed } from "@/lib/player-model";
import type { RunNote, SaveRunNoteResult } from "@/lib/run-notes";
import { AddNote, NoteMarkers } from "./reviewer-notes";
import { IconButton } from "./ui/icon-button";
import { ReviewIcon } from "./review-icon";
import { Select } from "./ui/select";
import { Popover } from "./ui/popover";
import "@/styles/study-playback.css";

export function StudyPlayback({
  recording,
  atMs,
  reviewing,
  playing,
  speed,
  canFollow,
  onToggle,
  onSeek,
  onSpeed,
  onLatest,
  notes = [],
  noteParticipant = null,
  onAddNote,
}: {
  recording: GridRecording;
  atMs: number | null;
  reviewing: boolean;
  playing: boolean;
  speed: number;
  canFollow: boolean;
  onToggle: () => void;
  onSeek: (atMs: number) => void;
  onSpeed: (speed: number) => void;
  onLatest: () => void;
  /** Reviewer notes, each marked on the timeline at its run clock time. */
  notes?: readonly RunNote[];
  /** The open participant's label, which a new note belongs to; null for the whole study. */
  noteParticipant?: string | null;
  /** Saves a note at a run clock time. Absent where this page cannot save notes. */
  onAddNote?: (atMs: number, text: string) => Promise<SaveRunNoteResult>;
}) {
  const start = recording.startMs ?? 0;
  const duration = Math.max(0, (recording.endMs ?? start) - start);
  const unavailable =
    reviewing &&
    atMs !== null &&
    (recording.startMs === null ||
      recording.endMs === null ||
      atMs < recording.startMs ||
      atMs > recording.endMs);
  const elapsed = Math.max(0, Math.min(duration, (atMs ?? start) - start));
  const timed = [...recording.lanes.values()].filter(
    (lane) => lane.times?.length || lane.media,
  ).length;
  return (
    <div className="study-playback" role="region" aria-label="Study playback">
      <div className="study-playback-controls">
        <IconButton
          className="tbtn"
          label={playing ? "Pause study" : "Play study"}
          hint={playing ? "Pause study recording" : "Play all recorded participants"}
          disabled={duration <= 0 || unavailable}
          onClick={onToggle}
        >
          <ReviewIcon name={playing ? "pause" : "play"} />
        </IconButton>
        <span className="study-playback-time" title="Study recording time">
          <span>Study </span>
          {reviewing && !unavailable ? formatElapsed(elapsed) : "—"}
          <span> / {formatElapsed(duration)}</span>
        </span>
        <div className="scrubwrap">
          <div className="scrub-track" aria-hidden="true">
            <div
              className="scrub-played"
              style={{ width: `${duration ? (elapsed / duration) * 100 : 0}%` }}
            />
            <NoteMarkers notes={notes} durationMs={duration} />
          </div>
          <input
            className="scrub"
            type="range"
            aria-label="Seek study recording"
            min={0}
            max={Math.max(1, duration)}
            step={1}
            value={elapsed}
            disabled={duration <= 0}
            aria-valuetext={
              unavailable
                ? "Selected time is outside the available recording. Seek to choose a new time."
                : reviewing
                  ? `${formatElapsed(elapsed)} of ${formatElapsed(duration)}, recorded capture time`
                  : `Latest previews. Recording duration ${formatElapsed(duration)}`
            }
            onChange={(event) => onSeek(start + Number(event.target.value))}
            onKeyDown={(event) => {
              if (event.altKey || event.ctrlKey || event.metaKey) return;
              const cursor = atMs ?? start;
              const next =
                event.key === "Home"
                  ? start
                  : event.key === "End"
                    ? start + duration
                    : event.key === "ArrowRight" || event.key === "ArrowUp"
                      ? (recording.boundariesMs.find((time) => time > cursor) ?? start + duration)
                      : event.key === "ArrowLeft" || event.key === "ArrowDown"
                        ? (recording.boundariesMs.findLast((time) => time < cursor) ?? start)
                        : event.key === "PageUp"
                          ? Math.min(start + duration, cursor + duration / 10)
                          : event.key === "PageDown"
                            ? Math.max(start, cursor - duration / 10)
                            : null;
              if (next === null) return;
              event.preventDefault();
              onSeek(next);
            }}
          />
        </div>
        {onAddNote && reviewing && !playing && !unavailable && recording.startMs !== null ? (
          <AddNote atMs={elapsed} participant={noteParticipant} onSave={onAddNote} />
        ) : null}
        <PlaybackOptions
          recording={recording}
          reviewing={reviewing}
          speed={speed}
          canFollow={canFollow}
          timed={timed}
          onSpeed={onSpeed}
          onLatest={onLatest}
        />
      </div>
      {unavailable ? (
        <p className="study-playback-warning" role="status">
          Selected time is no longer covered. Seek to choose another moment.
        </p>
      ) : null}
      {!timed ? (
        <span className="sr-only" role="status">
          Capture timing unavailable. Open a participant to review their recorded evidence.
        </span>
      ) : null}
    </div>
  );
}

/** The dock's options: playback speed, the jump to the latest captures, and timing coverage. */
function PlaybackOptions({
  recording,
  reviewing,
  speed,
  canFollow,
  timed,
  onSpeed,
  onLatest,
}: {
  recording: GridRecording;
  reviewing: boolean;
  speed: number;
  canFollow: boolean;
  /** How many participants have timed screenshots or desktop video. */
  timed: number;
  onSpeed: (speed: number) => void;
  onLatest: () => void;
}) {
  return (
    <Popover
      triggerClassName="tbtn study-playback-options"
      label="Playback options"
      trigger={<ReviewIcon name="options" />}
    >
      <div className="study-playback-settings">
        <label className="study-playback-speed">
          <span>Speed</span>
          <Select
            label="Study playback speed"
            value={String(speed)}
            onValueChange={(value) => onSpeed(Number(value))}
            options={[0.5, 1, 2, 4, 8].map((value) => ({
              value: String(value),
              label: `${value}×`,
            }))}
          />
        </label>
        <button
          type="button"
          className="review-tool study-playback-latest"
          disabled={!reviewing}
          onClick={onLatest}
        >
          {canFollow ? "Follow live" : "Latest captures"}
        </button>
        <p className="study-playback-note">
          {timed ? (
            <>
              {reviewing ? "Study timeline" : "Latest previews"} · {timed} of {recording.lanes.size}{" "}
              participants with timed screenshots or desktop video. Screens hold until the next
              capture.
            </>
          ) : (
            "Capture timing unavailable. Open a participant to review their recorded evidence."
          )}
        </p>
      </div>
    </Popover>
  );
}
