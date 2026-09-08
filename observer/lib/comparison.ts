import type { PlayerModel } from "./player-model";

export function frameTimes(model: PlayerModel, clock: "shared" | "elapsed"): number[] | null {
  const stamped = model.frames.every((frame, index) => frame.atMs !== undefined && Number.isFinite(frame.atMs) && (index === 0 || frame.atMs >= (model.frames[index - 1]?.atMs ?? Infinity)));
  if (clock === "shared" && !stamped) return null;
  const origin = clock === "shared" ? 0 : model.frames[0]?.atMs ?? 0;
  return model.frames.map((frame, index) => stamped ? (frame.atMs ?? 0) - origin : index * model.avgFrameMs);
}
/** Never select a future capture. Outside coverage remains explicit. */
export function comparisonFrame(times: number[], time: number): { index: number; ageMs: number; coverage: "before" | "within" | "after" } | null {
  if (!times.length) return null;
  if (time < (times[0] ?? 0)) return { index: -1, ageMs: 0, coverage: "before" };
  let lo = 0; let hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if ((times[mid] ?? Infinity) <= time) lo = mid + 1; else hi = mid; }
  const index = lo - 1;
  return { index, ageMs: time - (times[index] ?? time), coverage: time > (times.at(-1) ?? time) ? "after" : "within" };
}
