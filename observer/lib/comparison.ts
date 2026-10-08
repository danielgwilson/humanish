import { captureTimes } from "../../src/run/run-clock.js";
import type { PlayerModel } from "./player-model";

/**
 * Frame times on the run clock (`shared`), or from the first frame (`elapsed`). Unstamped frames
 * have no `shared` times, and take the average pace for `elapsed`.
 */
export function frameTimes(model: PlayerModel, clock: "shared" | "elapsed"): number[] | null {
  const times = captureTimes(model.frames.map((frame) => frame.atMs));
  if (clock === "shared") return times;
  const origin = times?.[0] ?? 0;
  return times
    ? times.map((time) => time - origin)
    : model.frames.map((_frame, index) => index * model.avgFrameMs);
}
/** Never select a future capture. Outside coverage remains explicit. */
export function comparisonFrame(
  times: number[],
  time: number,
): { index: number; ageMs: number; coverage: "before" | "within" | "after" } | null {
  if (!times.length) return null;
  if (time < (times[0] ?? 0)) return { index: -1, ageMs: 0, coverage: "before" };
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((times[mid] ?? Infinity) <= time) lo = mid + 1;
    else hi = mid;
  }
  const index = lo - 1;
  return {
    index,
    ageMs: time - (times[index] ?? time),
    coverage: time > (times.at(-1) ?? time) ? "after" : "within",
  };
}
