import {
  minimumJerk,
  planPointerGlide,
  POINTER_GLIDE_STEP_MS,
  pointerMoveMs,
  type PointerGlide,
  type PointerPoint,
} from "../../src/actors/computer-use/pointer-motion.js";
import { frameHoldMs, type PlayerModel, type PlayerRow } from "./player-model";

/** How long a press ring shows after the press lands. */
export const PRESS_RING_MS = 450;

/** One action's pointer movement within a capture interval, in ms after the capture. */
interface PointerMove {
  readonly rowId: string;
  readonly startMs: number;
  readonly endMs: number;
  /** The action pressed a button where the move ended: a click, or a press at a point. */
  readonly press: boolean;
  /** What the action did, shown beside the pointer when playback pauses on it. */
  readonly label: string;
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
  /** A touch screen: a fingertip shows only while it touches, so nothing travels between presses. */
  readonly touch: boolean;
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
 * identical across replays. On a touch screen a finger lands where it presses and lifts after, so
 * a press has no approach, a drag follows only its own path, and a move without a press draws
 * nothing.
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
      const press = row.coord !== undefined && !/^mouse up/i.test(row.title);
      if (model.touch) {
        last = target;
        if (!press && path.length === 1) continue;
        const motion = path.length === 1 ? still(target) : { ...polyline(path), heldFrom: 0 };
        moves.push({
          rowId: row.id,
          label: row.title,
          startMs: Math.max(previousEnd, endMs - motion.durationMs),
          endMs,
          press,
          ...(path.length === 1 ? {} : { heldFrom: 0 }),
          position: motion.position,
        });
        previousEnd = endMs;
        continue;
      }
      const start = recorded ? (last ?? path[0]!) : target;
      // A recorded glide is drawn from its own points; otherwise the glide is planned.
      const approach =
        row.pointerApproach === undefined
          ? planPointerGlide(start, path[0]!, `${seed}:${row.id}`)
          : timedPath([...row.pointerApproach, path[0]!]);
      const motion: PointerGlide & { heldFrom?: number } =
        path.length === 1 ? approach : dragMotion(approach, path);
      moves.push({
        rowId: row.id,
        label: row.title,
        startMs: Math.max(previousEnd, endMs - motion.durationMs),
        endMs,
        press,
        ...(motion.heldFrom === undefined ? {} : { heldFrom: motion.heldFrom }),
        position: motion.position,
      });
      previousEnd = endMs;
      last = target;
    }
    return {
      rest: recorded && !model.touch ? rest : null,
      moves,
      pressesOnly: !recorded,
      touch: model.touch,
    };
  });
}

/** The pointer at `ageMs` after the capture: resting, moving, or where its last move ended. */
export function pointerAt(frame: FramePointer, ageMs: number): PointerState {
  const fleeting = frame.pressesOnly || frame.touch;
  let point = fleeting ? null : frame.rest;
  let pressedAgoMs: number | null = null;
  let held = false;
  for (const move of frame.moves) {
    if (ageMs < move.startMs) break;
    const span = move.endMs - move.startMs;
    const fraction = span > 0 ? Math.min(1, (ageMs - move.startMs) / span) : 1;
    point = move.position(fraction);
    held = move.heldFrom !== undefined && fraction >= move.heldFrom && fraction < 1;
    if (ageMs >= move.endMs && move.press) pressedAgoMs = ageMs - move.endMs;
    if (fleeting && ageMs >= move.endMs + PRESS_RING_MS) point = null;
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

/** A press with no travel: the point it lands on. */
function still(point: PointerPoint): PointerGlide {
  return { durationMs: 0, position: () => point };
}

/** What the last action to finish by `ageMs` did, or null before the first one finishes. */
export function lastLabelAt(frame: FramePointer, ageMs: number): string | null {
  let label: string | null = null;
  for (const move of frame.moves) {
    if (ageMs < move.endMs) break;
    label = move.label;
  }
  return label;
}

/** A drag: the glide to where the button goes down, then the dragged path with the button held. */
function dragMotion(
  approach: PointerGlide,
  path: readonly PointerPoint[],
): PointerGlide & { heldFrom: number } {
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

/**
 * A glide the desktop took, drawn as it was sent: one point every glide step, so the drawn pointer
 * passes each point at the time the desktop moved there.
 */
function timedPath(points: readonly PointerPoint[]): PointerGlide {
  const last = points.length - 1;
  return {
    durationMs: last * POINTER_GLIDE_STEP_MS,
    position(fraction) {
      const at = Math.min(1, Math.max(0, fraction)) * last;
      const index = Math.min(last - 1, Math.floor(at));
      if (index < 0) return points[0]!;
      const from = points[index]!;
      const to = points[index + 1]!;
      const share = at - index;
      return { x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share };
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
