import type { PointerPoint } from "../../src/actors/computer-use/pointer-motion.js";
import { pointerAt, PRESS_RING_MS, type FramePointer } from "./pointer-track";

/** How the drawn pointer looks at one moment, beyond where it is. */
export interface PointerPose {
  readonly point: PointerPoint | null;
  /** Degrees the arrowhead leans across its heading; 0 at rest. */
  readonly leanDeg: number;
  /** The arrowhead's scale: a short dip and a slight overshoot as a press lands, then 1. */
  readonly squish: number;
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
    ring: {
      scale: still ? 1 : 0.4 + 0.8 * easeOutExpo(ringProgress),
      opacity: ringProgress >= 1 ? 0 : 0.6 * (1 - ringProgress) ** 2,
    },
    held: state.held,
    moving,
  };
}
