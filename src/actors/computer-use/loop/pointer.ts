import { planPointerGlide, POINTER_GLIDE_STEP_MS, type PointerPoint } from "../pointer-motion.js";
import { CuaAbortError, CuaDeadlineError, raceSessionDeadline, requestScope } from "./race.js";
import type { LoopSession } from "./session.js";
import { notice } from "./trace.js";
import type { CuaAction, CuaActionResult } from "./types.js";

// Where a participant's pointer goes: the points each action moves it through, and, with
// `pointer: "glide"`, the curve it follows to get there.

/** The point a pointer action pressed at, for the Observer's pins; absent for the rest. */
export function pressedAt(action: CuaAction): PointerPoint | undefined {
  switch (action.kind) {
    case "click":
    case "double_click":
    case "triple_click":
      return { x: action.x, y: action.y };
    case "mouse_down":
    case "mouse_up":
      return action.x === undefined || action.y === undefined
        ? undefined
        : { x: action.x, y: action.y };
    default:
      return undefined;
  }
}

/** The points an action moves the pointer through, ending where it rests. */
export function movedThrough(action: CuaAction): PointerPoint[] | undefined {
  switch (action.kind) {
    case "move":
    case "scroll":
      return [{ x: action.x, y: action.y }];
    case "drag":
      return action.path.length > 0 ? action.path.map(({ x, y }) => ({ x, y })) : undefined;
    default: {
      const pressed = pressedAt(action);
      return pressed === undefined ? undefined : [pressed];
    }
  }
}

/**
 * The whole-pixel points a glide from `from` toward `target` passes through, one per step after
 * `from`, ending short of `target`: the action itself makes the last move, so a desktop that is
 * slow to confirm a move onto the pointer's own position never meets one.
 */
function glidePoints(from: PointerPoint, target: PointerPoint, seed: string): PointerPoint[] {
  const glide = planPointerGlide(from, target, seed);
  const steps = Math.max(2, Math.round(glide.durationMs / POINTER_GLIDE_STEP_MS));
  const points: PointerPoint[] = [];
  const end = { x: Math.round(target.x), y: Math.round(target.y) };
  for (let step = 1; step < steps; step++) {
    const { x, y } = glide.position(step / steps);
    const point = { x: Math.round(x), y: Math.round(y) };
    const previous = points.at(-1) ?? from;
    if (point.x === end.x && point.y === end.y) break;
    if (point.x !== previous.x || point.y !== previous.y) points.push(point);
  }
  return points;
}

/**
 * Glide the pointer toward `action`'s first target when the session glides, its executor can, and
 * the pointer's position is known. Resolves with the path taken, from where the pointer was, for
 * the action's trace item, or undefined when no glide was sent. A glide that fails is noted and
 * the action still runs: the pointer then reaches its target in one step, as without gliding.
 */
export async function glideBefore(
  session: LoopSession,
  action: CuaAction,
  seed: string,
): Promise<PointerPoint[] | undefined> {
  const from = session.pointerPosition;
  const target = movedThrough(action)?.[0];
  const glide = session.executor.glide;
  if (session.pointerMotion !== "glide" || !glide || !from || !target) return undefined;
  const points = glidePoints(from, target, seed);
  if (points.length === 0) return undefined;
  const scope = requestScope(session.signal);
  try {
    await raceSessionDeadline(
      glide.call(session.executor, points, POINTER_GLIDE_STEP_MS, scope.signal),
      session.remaining(),
      session.signal,
    );
  } catch (error) {
    if (error instanceof CuaAbortError || error instanceof CuaDeadlineError) throw error;
    session.trace.record("notice", () =>
      notice(
        "warn",
        "pointer glide failed",
        "the desktop did not take the glide toward the next action's target; the action moved the pointer there in one step",
      ),
    );
    return undefined;
  } finally {
    scope.end();
  }
  session.pointerPosition = points.at(-1);
  return [from, ...points];
}

/** Keep where the pointer is after an action: what a pointer read returned, else where it moved. */
export function notePointer(
  session: LoopSession,
  result: CuaActionResult | undefined,
  moved: readonly PointerPoint[] | undefined,
): void {
  if (result?.kind === "pointer") session.pointerPosition = { x: result.x, y: result.y };
  else if (moved !== undefined && moved.length > 0) session.pointerPosition = moved.at(-1);
}
