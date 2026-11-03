import {
  minimumJerk,
  planPointerGlide,
  pointerMoveMs,
  type PointerGlide,
  type PointerPoint,
} from "../../src/actors/computer-use/pointer-motion.js";
import { frameHoldMs, type PlayerModel, type PlayerRow } from "./player-model";

/** How long a press ring shows after the press lands. */
export const PRESS_RING_MS = 600;

/** One action's pointer movement within a capture interval, in ms after the capture. */
interface PointerMove {
  readonly rowId: string;
  readonly startMs: number;
  readonly endMs: number;
  /** The action pressed a button where the move ended: a click, or a press at a point. */
  readonly press: boolean;
  /** For a drag: the fraction of the move from which the button is held. */
  readonly heldFrom?: number;
  /** Where the pointer is at `fraction` of this move. */
  readonly position: (fraction: number) => PointerPoint;
}

/** The pointer over one capture interval: where it rested at the capture, then each move. */
export interface FramePointer {
  /** Null until a recorded action has placed the pointer. */
  readonly rest: PointerPoint | null;
  readonly moves: readonly PointerMove[];
  /** Shown only at each press and its ring. A bundle from before pointer paths recorded clicks
   *  alone, so where its pointer was between them is unknown. */
  readonly pressesOnly: boolean;
}

/** Where the pointer is drawn at a moment, how long ago its last press landed, and whether a
 * drag holds the button. */
export interface PointerState {
  readonly point: PointerPoint | null;
  readonly pressedAgoMs: number | null;
  readonly held: boolean;
}

/**
 * The pointer for every capture of `model`. A move ends at its action's recorded time, so a click
 * lands when the participant clicked, and its planned glide starts before that. An action recorded
 * before the capture moves only where the pointer rests on it; a capture or action without a
 * recorded time draws no movement. `seed` keeps one participant's glides apart from another's and
 * identical across replays.
 */
export function framePointers(model: PlayerModel, seed: string): FramePointer[] {
  const recorded = model.rows.some((row) => row.pointerPath !== undefined);
  const byFrame = new Map<number, Array<{ row: PlayerRow; path: readonly PointerPoint[] }>>();
  for (const row of model.rows) {
    const path = recorded ? row.pointerPath : row.coord ? [row.coord] : undefined;
    if (path === undefined || path.length === 0) continue;
    const entry = { row, path };
    const list = byFrame.get(row.frameIndex);
    if (list) list.push(entry);
    else byFrame.set(row.frameIndex, [entry]);
  }
  let last: PointerPoint | null = null;
  return model.frames.map((frame, index) => {
    const hold = frameHoldMs(model, index);
    let rest = last;
    const moves: PointerMove[] = [];
    let previousEnd = 0;
    for (const { row, path } of byFrame.get(index) ?? []) {
      const target = path[path.length - 1]!;
      const offset =
        row.atMs !== undefined && frame.atMs !== undefined ? row.atMs - frame.atMs : undefined;
      if (offset === undefined || offset < 0) {
        if (offset !== undefined) rest = target;
        last = target;
        continue;
      }
      const endMs = Math.max(previousEnd, Math.min(hold, offset));
      const start = recorded ? (last ?? path[0]!) : target;
      const motion: PointerGlide & { heldFrom?: number } =
        path.length === 1
          ? planPointerGlide(start, target, `${seed}:${row.id}`)
          : dragMotion(start, path, `${seed}:${row.id}`);
      moves.push({
        rowId: row.id,
        startMs: Math.max(previousEnd, endMs - motion.durationMs),
        endMs,
        press: row.coord !== undefined && !/^mouse up/i.test(row.title),
        ...(motion.heldFrom === undefined ? {} : { heldFrom: motion.heldFrom }),
        position: motion.position,
      });
      previousEnd = endMs;
      last = target;
    }
    return { rest: recorded ? rest : null, moves, pressesOnly: !recorded };
  });
}

/** The pointer at `ageMs` after the capture: resting, moving, or where its last move ended. */
export function pointerAt(frame: FramePointer, ageMs: number): PointerState {
  let point = frame.pressesOnly ? null : frame.rest;
  let pressedAgoMs: number | null = null;
  let held = false;
  for (const move of frame.moves) {
    if (ageMs < move.startMs) break;
    const span = move.endMs - move.startMs;
    const fraction = span > 0 ? Math.min(1, (ageMs - move.startMs) / span) : 1;
    point = move.position(fraction);
    held = move.heldFrom !== undefined && fraction >= move.heldFrom && fraction < 1;
    if (ageMs >= move.endMs && move.press) pressedAgoMs = ageMs - move.endMs;
    if (frame.pressesOnly && ageMs >= move.endMs + PRESS_RING_MS) point = null;
  }
  return { point, pressedAgoMs, held };
}

/**
 * How long after `ageMs` the drawn pointer next changes: 0 while a move or a ring is under way,
 * the time to the next move's start, or null when nothing changes again in this capture.
 */
export function nextChangeMs(frame: FramePointer, ageMs: number): number | null {
  for (const move of frame.moves) {
    if (ageMs < move.startMs) return move.startMs - ageMs;
    if (ageMs < move.endMs + PRESS_RING_MS) return 0;
  }
  return null;
}

/** A drag: a glide to where the button goes down, then the dragged path with the button held. */
function dragMotion(
  start: PointerPoint,
  path: readonly PointerPoint[],
  seed: string,
): PointerGlide & { heldFrom: number } {
  const approach = planPointerGlide(start, path[0]!, seed);
  const dragged = polyline(path);
  const durationMs = approach.durationMs + dragged.durationMs;
  const heldFrom = durationMs > 0 ? approach.durationMs / durationMs : 0;
  return {
    durationMs,
    heldFrom,
    position(fraction) {
      if (fraction < heldFrom) return approach.position(fraction / heldFrom);
      return dragged.position(heldFrom < 1 ? (fraction - heldFrom) / (1 - heldFrom) : 1);
    },
  };
}

/** A recorded path, traversed by length on the same eased profile a planned glide uses. */
function polyline(points: readonly PointerPoint[]): PointerGlide {
  const lengths = points.slice(1).map((point, index) => {
    const before = points[index]!;
    return Math.hypot(point.x - before.x, point.y - before.y);
  });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const lastPoint = points[points.length - 1]!;
  return {
    durationMs: pointerMoveMs(total),
    position(fraction) {
      const t = Math.min(1, Math.max(0, fraction));
      if (total === 0 || t === 1) return lastPoint;
      let remaining = total * minimumJerk(t);
      for (const [index, length] of lengths.entries()) {
        const from = points[index]!;
        const to = points[index + 1]!;
        if (remaining <= length && length > 0) {
          const share = remaining / length;
          return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
        }
        remaining -= length;
      }
      return lastPoint;
    },
  };
}
