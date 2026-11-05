import type { PointerPoint } from "../../src/actors/computer-use/pointer-motion.js";
import { pointerAt, PRESS_RING_MS, type FramePointer } from "./pointer-track";

/** How the drawn pointer looks at one moment, beyond where it is. */
export interface PointerPose {
  readonly point: PointerPoint | null;
  /** Degrees the arrowhead leans across its heading; 0 at rest. */
  readonly leanDeg: number;
  /** The mark's scale: for the arrowhead a short dip and a slight overshoot as a press lands, for
   *  a fingertip a quick grow as it touches down. */
  readonly squish: number;
  /** The mark's opacity: 1, except a fingertip fading as it lifts. */
  readonly fade: number;
  /** The press ring's scale and opacity, growing and fading after a press. */
  readonly ring: { readonly scale: number; readonly opacity: number };
  readonly held: boolean;
  /** True while a move is under way. */
  readonly moving: boolean;
}

// The heading is measured over this window, about two frames.
const HEADING_WINDOW_MS = 24;
const MAX_LEAN_DEG = 10;
// Desktop pixels a millisecond at which the lean reaches its cap; a long glide's peak speed.
const FULL_LEAN_SPEED = 1.5;
// The arrowhead's own axis, from its notch to its tip, in screen degrees (y down): up and to the left.
const TIP_AXIS_RAD = Math.atan2(-9.6, -7.1);
const SQUISH_DOWN_MS = 60;
const SQUISH_UP_MS = 180;
const SQUISH_DEPTH = 0.12;
const TOUCH_DOWN_MS = 90;
// A fingertip stays at full strength this long after it lands, then fades by the ring's end.
const TOUCH_HOLD_MS = 150;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
// A back-out: past 1 by about 2% near the end, then settles, so the press springs back.
const easeOutBack = (t: number) => {
  const c = 1.2;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

/**
 * The pointer's pose at `ageMs` after the capture: its position, a lean across its heading while it
 * moves, a squish as a press lands, and the press ring after it. Reduced motion (`still`) keeps the
 * arrowhead upright and its ring still.
 */
export function pointerPose(frame: FramePointer, ageMs: number, still = false): PointerPose {
  const state = pointerAt(frame, ageMs);
  const moving = frame.moves.some((move) => ageMs >= move.startMs && ageMs < move.endMs);
  let leanDeg = 0;
  if (moving && !still && state.point) {
    const before = pointerAt(frame, Math.max(0, ageMs - HEADING_WINDOW_MS)).point;
    if (before) {
      const dx = state.point.x - before.x;
      const dy = state.point.y - before.y;
      const speed = Math.hypot(dx, dy) / HEADING_WINDOW_MS;
      if (speed > 0) {
        const across = Math.sin(Math.atan2(dy, dx) - TIP_AXIS_RAD);
        leanDeg = MAX_LEAN_DEG * clamp01(speed / FULL_LEAN_SPEED) * across;
      }
    }
  }
  const pressed = state.pressedAgoMs;
  const ringProgress = pressed === null ? 1 : clamp01(pressed / PRESS_RING_MS);
  const ring = {
    scale: still ? 1 : 0.4 + 0.8 * easeOutExpo(ringProgress),
    opacity: ringProgress >= 1 ? 0 : 0.6 * (1 - ringProgress) ** 2,
  };
  if (frame.touch) {
    const touch = touchMark(frame, ageMs, pressed, still);
    return { point: state.point, leanDeg: 0, ...touch, ring, held: state.held, moving };
  }
  let squish = 1;
  if (pressed !== null && !still) {
    if (pressed < SQUISH_DOWN_MS)
      squish = 1 - SQUISH_DEPTH * easeOutCubic(pressed / SQUISH_DOWN_MS);
    else if (pressed < SQUISH_DOWN_MS + SQUISH_UP_MS)
      squish =
        1 - SQUISH_DEPTH + SQUISH_DEPTH * easeOutBack((pressed - SQUISH_DOWN_MS) / SQUISH_UP_MS);
  }
  return {
    point: state.point,
    leanDeg,
    squish,
    fade: 1,
    ring,
    held: state.held,
    moving,
  };
}

/**
 * A fingertip's scale and opacity: it grows in as it touches down, at the start of a drag or as a
 * tap lands, holds while the finger is down, and fades as it lifts. Reduced motion shows it whole
 * until it goes.
 */
function touchMark(
  frame: FramePointer,
  ageMs: number,
  pressed: number | null,
  still: boolean,
): { squish: number; fade: number } {
  if (still) return { squish: 1, fade: 1 };
  const touching = frame.moves.find((move) => ageMs >= move.startMs && ageMs <= move.endMs);
  // Down since the touch began: a tap lands where it ends, a drag where its path starts.
  const began = touching ?? frame.moves.findLast((move) => move.endMs <= ageMs);
  const downFor = began ? ageMs - began.startMs : 0;
  const squish = 0.7 + 0.3 * easeOutCubic(clamp01(downFor / TOUCH_DOWN_MS));
  if (touching || pressed === null || pressed < TOUCH_HOLD_MS) return { squish, fade: 1 };
  const lifting = clamp01((pressed - TOUCH_HOLD_MS) / (PRESS_RING_MS - TOUCH_HOLD_MS));
  return { squish, fade: 1 - easeOutCubic(lifting) };
}
