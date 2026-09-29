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

export interface RecordingInterval {
  startMs: number;
  endMs: number;
  recording: NonNullable<ObserverStream["recording"]>;
}

export type GridMoment =
  | { kind: "no-captures" | "timing-unavailable" | "before-first" }
  | {
      kind: "capture";
      frame: PlayerFrame;
      ageMs: number;
      coverage: "within" | "after-last";
    };

/** Pass every study stream. Visible cards must not redefine the recording clock. */
export function buildGridRecording(allStreams: readonly ObserverStream[]): GridRecording {
  const lanes: GridRecording["lanes"] = new Map();
  const boundaries = new Set<number>();
  for (const stream of allStreams) {
    const model = buildPlayerModel(stream);
    const times = model ? frameTimes(model, "shared") : null;
    const media = recordingInterval(stream);
    lanes.set(stream.id, {
      model,
      times,
      media,
      timing: !model ? "no-captures" : times ? "recorded" : "unavailable",
    });
    // A one-frame recording can have a valid stamp even when the player cannot
    // calculate a recorded pace. Never manufacture stamps from actor duration.
    if (times) for (const time of times) boundaries.add(time);
    if (media) {
      boundaries.add(media.startMs);
      boundaries.add(media.endMs);
    }
  }
  const boundariesMs = [...boundaries].sort((a, b) => a - b);
  return {
    startMs: boundariesMs[0] ?? null,
    endMs: boundariesMs.at(-1) ?? null,
    boundariesMs,
    lanes,
  };
}

export function recordingInterval(stream: ObserverStream): RecordingInterval | null {
  const recording = stream.recording;
  if (!recording) return null;
  const startMs = Date.parse(recording.startedAt);
  const endMs = startMs + recording.durationMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || recording.durationMs <= 0)
    return null;
  return { startMs, endMs, recording };
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
