import { useLayoutEffect, useMemo, useRef } from "react";
import { frameHoldMs, type PlayerModel } from "@/lib/player-model";
import { pointerPose } from "@/lib/pointer-pose";
import { framePointers, lastLabelAt, nextChangeMs, type FramePointer } from "@/lib/pointer-track";
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
  // Paused on a selected entry, the pointer is where that entry's move ended, whichever clock runs.
  const selected = playback.selectedRow
    ? frame.moves.find((move) => move.rowId === playback.selectedRow?.id)
    : undefined;
  if (studyPlayback) {
    const clockAge = studyPlayback.moment.kind === "capture" ? studyPlayback.moment.ageMs : 0;
    const ageMs = !studyPlayback.playing && selected ? selected.endMs : clockAge;
    return clockPointerView(
      frame,
      `${playback.frame}`,
      ageMs,
      limitMs,
      studyPlayback.playing,
      studyPlayback.speed,
    );
  }
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
 * The participant's pointer over a recorded capture: a dark arrowhead with a light edge and a glow,
 * gliding between recorded positions. It has no tail, so it never reads as the real pointer each
 * capture already shows. It leans into its travel and squishes as a press lands, where a ring
 * blooms. On a touch screen it is a fingertip instead, shown only while it touches. Paused, it
 * names the action it last finished. It is drawn from the action trace in the desktop-pixel box
 * of the capture, and moves between the positions the captures show.
 */
export function PointerCursor({ view, viewport }: { view: PointerView; viewport: Size }) {
  const rootRef = useRef<HTMLDivElement>(null);
  // When this anchor began, kept across re-renders that bring an equal anchor, such as a poll
  // that rebuilds the same participant's frames, so the pointer does not restart mid-move.
  const clock = useRef<{ anchor: string; at: number } | null>(null);
  const { frame, ageMs, playing, speed, limitMs, anchor } = view;
  const { width, height } = viewport;
  // Drawn before paint: a pointer remounted on the next capture appears where it is, and only a
  // pointer appearing for the first time fades in.
  useLayoutEffect(() => {
    const root = rootRef.current;
    const mark = root?.querySelector<HTMLElement | SVGElement>(".pointer-arrow, .pointer-touch");
    const ring = root?.querySelector<HTMLElement>(".pointer-ring");
    const caption = root?.querySelector<HTMLElement>(".pointer-caption");
    if (!root || !mark || !ring || !caption) return;
    if (clock.current?.anchor !== anchor) clock.current = { anchor, at: performance.now() };
    const started = clock.current.at;
    const still =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = (age: number) => {
      const moment = Math.min(limitMs, Math.max(0, age));
      // Reduced motion shows each move where it ends, from the moment it starts.
      const pose = pointerPose(frame, still ? endOfCurrentMove(frame, moment) : moment, still);
      const position = pose.point ? pinPosition(pose.point, { width, height }) : null;
      root.toggleAttribute("data-placed", position !== null);
      if (position) {
        root.style.left = String(position.left);
        root.style.top = String(position.top);
      }
      // Paused, the pointer names what it last did, on the side with room.
      const label = playing || !pose.point ? null : lastLabelAt(frame, moment);
      caption.textContent = label ?? "";
      root.toggleAttribute("data-captioned", label !== null);
      if (pose.point) {
        root.toggleAttribute("data-caption-left", pose.point.x / width > 0.6);
        root.toggleAttribute("data-caption-above", pose.point.y / height > 0.75);
      }
      root.toggleAttribute("data-held", pose.held);
      root.toggleAttribute("data-moving", pose.moving);
      root.toggleAttribute("data-pressed", pose.ring.opacity > 0);
      mark.style.transform = `rotate(${pose.leanDeg.toFixed(2)}deg) scale(${pose.squish.toFixed(3)})`;
      mark.style.opacity = pose.fade.toFixed(3);
      ring.style.opacity = pose.ring.opacity.toFixed(3);
      ring.style.transform = `translate(-50%, -50%) scale(${pose.ring.scale.toFixed(3)})`;
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
    <div
      className="pointer-cursor"
      ref={rootRef}
      aria-hidden="true"
      data-testid="pointer-cursor"
      data-input={frame.touch ? "touch" : "mouse"}
    >
      <span className="pointer-ring" />
      {frame.touch ? (
        <span className="pointer-touch" />
      ) : (
        <svg className="pointer-arrow" viewBox="0 0 20 22" focusable="false">
          <path d="M3 2.8 L17 9.2 Q18 9.7 17 10.1 L10.7 12 Q10.2 12.15 10.05 12.65 L8.1 19.1 Q7.75 20.1 7.35 19.1 Z" />
        </svg>
      )}
      <span className="pointer-caption" />
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
