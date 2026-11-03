import { useEffect, useMemo, useRef } from "react";
import { frameHoldMs, type PlayerModel } from "@/lib/player-model";
import {
  framePointers,
  nextChangeMs,
  pointerAt,
  PRESS_RING_MS,
  type FramePointer,
} from "@/lib/pointer-track";
import type { GridMoment, GridRecording } from "@/lib/grid-recording";
import type { PlayerPlayback } from "@/lib/use-player-playback";
import type { StudyPlayerControl } from "@/lib/use-study-playback";
import { pinPosition, type Size } from "@/lib/stage-geometry";

/** The pointer to draw on the shown capture and the moment within it. */
export interface PointerView {
  readonly frame: FramePointer;
  /** Evidence time after the capture at `anchor`; it advances at `speed` while `playing`. */
  readonly ageMs: number;
  readonly playing: boolean;
  readonly speed: number;
  /** The capture interval's length: the drawn moment never passes it. */
  readonly limitMs: number;
  /** Changes whenever `ageMs` is a new starting point rather than a continuation. */
  readonly anchor: string;
}

/**
 * The pointer view for the shown capture, or null when there is none to draw: following the live
 * desktop, no capture shown, or the reviewer turned the pointer off. Under a study clock the
 * clock's age within the capture drives it; local playback starts each capture at its beginning,
 * or, paused on a selected entry, at that entry's move.
 */
export function usePointerView(
  model: PlayerModel,
  seed: string,
  playback: PlayerPlayback,
  studyPlayback: StudyPlayerControl | undefined,
  speed: number,
  enabled: boolean,
): PointerView | null {
  const frames = useMemo(() => framePointers(model, seed), [model, seed]);
  const frame = playback.frame >= 0 ? frames[playback.frame] : undefined;
  if (!enabled || playback.live !== null || !frame) return null;
  const limitMs = frameHoldMs(model, playback.frame);
  if (studyPlayback) {
    const ageMs = studyPlayback.moment.kind === "capture" ? studyPlayback.moment.ageMs : 0;
    return clockPointerView(
      frame,
      `${playback.frame}`,
      ageMs,
      limitMs,
      studyPlayback.playing,
      studyPlayback.speed,
    );
  }
  const selected = playback.selectedRow
    ? frame.moves.find((move) => move.rowId === playback.selectedRow?.id)
    : undefined;
  const ageMs = !playback.playing && selected ? selected.endMs : 0;
  return {
    frame,
    ageMs,
    playing: playback.playing,
    speed,
    limitMs,
    anchor: `${playback.frame}:${ageMs}:${playback.playing}`,
  };
}

/**
 * The pointer view for each grid tile: given a participant and the study clock's moment for it,
 * the pointer to draw, or null when the tile shows no recorded capture.
 */
export function useGridPointers(
  recording: GridRecording,
  playing: boolean,
  speed: number,
): (streamId: string, moment: GridMoment | undefined) => PointerView | null {
  const pointers = useMemo(
    () =>
      new Map(
        [...recording.lanes].map(([id, lane]) => [
          id,
          lane.model ? framePointers(lane.model, id) : undefined,
        ]),
      ),
    [recording],
  );
  return (streamId, moment) =>
    momentPointerView(
      recording.lanes.get(streamId)?.model ?? null,
      pointers.get(streamId),
      moment,
      playing,
      speed,
    );
}

function momentPointerView(
  model: PlayerModel | null,
  pointers: readonly FramePointer[] | undefined,
  moment: GridMoment | undefined,
  playing: boolean,
  speed: number,
): PointerView | null {
  if (!model || !pointers || moment?.kind !== "capture") return null;
  const frame = pointers[moment.frame.index];
  if (!frame) return null;
  return clockPointerView(
    frame,
    `${moment.frame.index}`,
    moment.ageMs,
    frameHoldMs(model, moment.frame.index),
    playing && moment.coverage === "within",
    speed,
  );
}

function clockPointerView(
  frame: FramePointer,
  capture: string,
  ageMs: number,
  limitMs: number,
  playing: boolean,
  speed: number,
): PointerView {
  return { frame, ageMs, playing, speed, limitMs, anchor: `${capture}:${ageMs}:${playing}` };
}

/**
 * The participant's pointer over a recorded capture: an arrow at the pointer's position, gliding
 * between recorded positions and ringing where a press landed. It is drawn from the action trace
 * in the same desktop-pixel box as the pins. The frames already show the real pointer where it was
 * at each capture; this one moves in between.
 */
export function PointerCursor({ view, viewport }: { view: PointerView; viewport: Size }) {
  const arrowRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  // When this anchor began, kept across re-renders that bring an equal anchor, such as a poll
  // that rebuilds the same participant's frames, so the pointer does not restart mid-move.
  const clock = useRef<{ anchor: string; at: number } | null>(null);
  const { frame, ageMs, playing, speed, limitMs, anchor } = view;
  const { width, height } = viewport;
  useEffect(() => {
    const arrow = arrowRef.current;
    const ring = ringRef.current;
    if (!arrow || !ring) return;
    if (clock.current?.anchor !== anchor) clock.current = { anchor, at: performance.now() };
    const started = clock.current.at;
    const still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = (age: number) => {
      const moment = Math.min(limitMs, Math.max(0, age));
      // Reduced motion shows each move where it ends, from the moment it starts.
      const state = pointerAt(frame, still ? endOfCurrentMove(frame, moment) : moment);
      const position = state.point ? pinPosition(state.point, { width, height }) : null;
      arrow.toggleAttribute("data-placed", position !== null);
      if (position) {
        arrow.style.left = String(position.left);
        arrow.style.top = String(position.top);
      }
      arrow.toggleAttribute("data-held", state.held);
      const pressed = state.pressedAgoMs;
      const progress = pressed === null ? 1 : pressed / PRESS_RING_MS;
      ring.style.opacity = progress < 1 ? String(0.7 * (1 - progress)) : "0";
      ring.style.transform = `translate(-50%, -50%) scale(${still ? 1 : 0.4 + 1.2 * Math.min(1, progress)})`;
      return moment;
    };
    const now = () => ageMs + (performance.now() - started) * speed;
    if (!playing) {
      draw(ageMs);
      return;
    }
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Animate only while a move or a ring is under way; between moves, wait for the next one.
    const tick = () => {
      const moment = draw(now());
      const next = moment >= limitMs ? null : nextChangeMs(frame, moment);
      if (next === null) return;
      if (next === 0) request = requestAnimationFrame(tick);
      else timer = setTimeout(tick, next / speed);
    };
    tick();
    return () => {
      cancelAnimationFrame(request);
      clearTimeout(timer);
    };
  }, [frame, ageMs, playing, speed, limitMs, anchor, width, height]);
  return (
    <div className="pointer-cursor" ref={arrowRef} aria-hidden="true" data-testid="pointer-cursor">
      <span className="pointer-ring" ref={ringRef} />
      <svg className="pointer-arrow" viewBox="0 0 16 22" focusable="false">
        <path d="M1.5 1.5 L1.5 17.5 L5.8 13.6 L8.6 20.2 L11.4 19 L8.6 12.5 L14.2 12.5 Z" />
      </svg>
    </div>
  );
}

/** The end of the move under way at `ageMs`, or `ageMs` itself between moves. */
function endOfCurrentMove(frame: FramePointer, ageMs: number): number {
  const move = frame.moves.find(
    (candidate) => ageMs >= candidate.startMs && ageMs < candidate.endMs,
  );
  return move ? move.endMs : ageMs;
}
