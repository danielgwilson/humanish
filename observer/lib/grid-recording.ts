import { recordingInterval, runClock, type RecordingInterval } from "../../src/run/run-clock.js";
import { comparisonFrame, frameTimes } from "./comparison";
import type { ObserverStream } from "./observer-data";
import { buildPlayerModel, type PlayerFrame, type PlayerModel } from "./player-model";

/** One recorded capture clock, independent of grid filtering and pagination. */
export interface GridRecording {
  startMs: number | null;
  endMs: number | null;
  /** Original capture boundaries, deduplicated for sparse keyboard seeking. */
  boundariesMs: number[];
  lanes: Map<
    string,
    {
      model: PlayerModel | null;
      times: number[] | null;
      media: RecordingInterval | null;
      timing: "recorded" | "unavailable" | "no-captures";
    }
  >;
}

export type GridMoment =
  | { kind: "no-captures" | "timing-unavailable" | "before-first" }
  | {
      kind: "capture";
      frame: PlayerFrame;
      ageMs: number;
      coverage: "within" | "after-last";
    };

/**
 * Pass every study stream. Visible cards must not redefine the recording clock. The clock is the
 * run clock a reviewer note counts from. Each participant's times follow the frames its player
 * shows.
 */
export function buildGridRecording(allStreams: readonly ObserverStream[]): GridRecording {
  const lanes: GridRecording["lanes"] = new Map();
  for (const stream of allStreams) {
    const model = buildPlayerModel(stream);
    const times = model ? frameTimes(model, "shared") : null;
    lanes.set(stream.id, {
      model,
      times,
      media: recordingInterval(stream.recording),
      timing: !model ? "no-captures" : times ? "recorded" : "unavailable",
    });
  }
  const clock = runClock(allStreams);
  return {
    startMs: clock?.startMs ?? null,
    endMs: clock?.endMs ?? null,
    boundariesMs: clock?.boundariesMs ?? [],
    lanes,
  };
}

export function recordingContains(
  interval: RecordingInterval | null,
  atMs: number | null,
): boolean {
  return (
    interval !== null &&
    atMs !== null &&
    Number.isFinite(atMs) &&
    atMs >= interval.startMs &&
    atMs <= interval.endMs
  );
}

/** Select only evidence already captured at the cursor, without interpolating it. */
export function gridMoment(
  recording: GridRecording,
  streamId: string,
  cursorMs: number,
): GridMoment {
  const lane = recording.lanes.get(streamId);
  if (!lane?.model) return { kind: "no-captures" };
  if (!lane.times || !Number.isFinite(cursorMs)) return { kind: "timing-unavailable" };
  const selection = comparisonFrame(lane.times, cursorMs);
  if (!selection || selection.coverage === "before") return { kind: "before-first" };
  const frame = lane.model.frames[selection.index];
  if (!frame) return { kind: "no-captures" };
  return {
    kind: "capture",
    frame,
    ageMs: selection.ageMs,
    coverage: selection.coverage === "after" ? "after-last" : "within",
  };
}

/** Invalid positions and recordings without timed captures have no shared time. */
export function clampGridTime(recording: GridRecording, requestedMs: number): number | null {
  if (recording.startMs === null || recording.endMs === null || !Number.isFinite(requestedMs))
    return null;
  return Math.max(recording.startMs, Math.min(recording.endMs, requestedMs));
}
