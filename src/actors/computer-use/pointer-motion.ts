/** A glide's points are this far apart in time: one per frame at 60 frames a second. */
export const POINTER_GLIDE_STEP_MS = 16;

/** A point on the desktop, in desktop pixels. */
export interface PointerPoint {
  readonly x: number;
  readonly y: number;
}

/** One planned pointer move: how long it takes and where the pointer is along it. */
export interface PointerGlide {
  readonly durationMs: number;
  /** The pointer's position at `fraction` of the move's time, 0 at the start and 1 at the end. */
  position(fraction: number): PointerPoint;
}

// Fitts's law: movement time = a + b * log2(distance / width + 1), for a 16 px target. The clamp keeps a short hop
// visible and a long move near a third of a second: a glide adds to every pointer action, and an app
// that takes several clicks a turn pays it several times.
const FITTS_INTERCEPT_MS = 70;
const FITTS_SLOPE_MS = 55;
const TARGET_WIDTH_PX = 16;
const MIN_DURATION_MS = 120;
const MAX_DURATION_MS = 380;
// A hand's path bows off the straight line; a bow above about 24 px reads as a detour.
const BOW_SHARE = 0.08;
const MAX_BOW_PX = 24;

/**
 * Plan the pointer's move from `from` to `to`: a quadratic curve that bows to one side, timed by
 * Fitts's law and eased on the minimum-jerk profile that human reaching movements follow. The
 * same `seed` always gives the same move, so a replay and a rerun draw it identically.
 */
export function planPointerGlide(from: PointerPoint, to: PointerPoint, seed: string): PointerGlide {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { durationMs: 0, position: () => ({ x: to.x, y: to.y }) };
  const durationMs = pointerMoveMs(distance);
  const random = seededUnit(seed);
  const side = random < 0.5 ? -1 : 1;
  const bow =
    side * Math.min(MAX_BOW_PX, distance * BOW_SHARE) * (0.6 + 0.8 * Math.abs(random - 0.5));
  // The control point sits off the midpoint along the unit normal; a quadratic curve reaches half
  // that offset at its middle, so the control is twice the bow.
  const control = {
    x: (from.x + to.x) / 2 + (-dy / distance) * bow * 2,
    y: (from.y + to.y) / 2 + (dx / distance) * bow * 2,
  };
  return {
    durationMs,
    position(fraction) {
      const t = minimumJerk(Math.min(1, Math.max(0, fraction)));
      if (t === 0) return { x: from.x, y: from.y };
      if (t === 1) return { x: to.x, y: to.y };
      const u = 1 - t;
      return {
        x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
        y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
      };
    },
  };
}

/** How long a move of `distance` desktop pixels takes, by Fitts's law within the clamp. */
export function pointerMoveMs(distance: number): number {
  if (distance < 1) return 0;
  return Math.round(
    Math.min(
      MAX_DURATION_MS,
      Math.max(
        MIN_DURATION_MS,
        FITTS_INTERCEPT_MS + FITTS_SLOPE_MS * Math.log2(distance / TARGET_WIDTH_PX + 1),
      ),
    ),
  );
}

/** Progress along a minimum-jerk move at time fraction `t`: 10t^3 - 15t^4 + 6t^5. */
export function minimumJerk(t: number): number {
  return t * t * t * (10 + t * (-15 + 6 * t));
}

/** A number in [0, 1) fixed by `seed`: a 32-bit Fowler-Noll-Vo hash of its UTF-16 code units. */
function seededUnit(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}
