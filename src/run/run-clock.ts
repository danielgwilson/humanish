// The run clock: the Observer's study timeline, and the clock a reviewer note's time counts from.
// It runs from the first to the last moment any participant recorded: a timed capture, or the start
// or end of a desktop video. The Observer bundles this module, so it imports types only
// (docs/decisions/0002-observer-is-one-self-contained-file.md).

import type { ActorTraceItem } from "../actors/contract.js";
import type { RunDesktopRecording } from "../evidence/desktop-recording-types.js";

/** What the clock reads from a stream. A run.json stream and an Observer stream both have it. */
export interface ClockStream {
  actor?: { items: readonly ActorTraceItem[] };
  liveActor?: { items: readonly ActorTraceItem[] };
  recording?: RunDesktopRecording;
}

/** Where the run clock starts and ends, in epoch ms. */
export interface RunClock {
  startMs: number;
  endMs: number;
  /** Every moment on the clock, ascending without repeats, for keyboard seeking. */
  boundariesMs: number[];
}

/** A desktop video's place on the run clock, in epoch ms. */
export interface RecordingInterval {
  startMs: number;
  endMs: number;
  recording: RunDesktopRecording;
}

/**
 * A stream's recorded trace items: the finished actor's, else the flush of a participant still
 * running, so every reader of a live run sees the items grow.
 */
export function traceItems(stream: ClockStream): readonly ActorTraceItem[] {
  return stream.actor?.items ?? stream.liveActor?.items ?? [];
}

/**
 * Whether a trace item is a capture, a frame of the participant's replay: a screenshot, or a
 * scripted action that carries its own screenshot. A notice can cite an earlier screenshot for
 * context, and does not capture it again.
 */
export function isCapture<Item extends Pick<ActorTraceItem, "kind" | "screenshotRef">>(
  item: Item,
): item is Item & { screenshotRef: NonNullable<ActorTraceItem["screenshotRef"]> } {
  return (item.kind === "screenshot" || item.kind === "ui_action") && Boolean(item.screenshotRef);
}

/**
 * A participant's capture times in epoch ms, in recorded order. Null when a capture has no stamp
 * or a stamp goes back: such a participant adds nothing to the run clock, and its replay runs at
 * an average pace. Times are never made up from the actor's duration.
 */
export function captureTimes(stamps: readonly (number | undefined)[]): number[] | null {
  const times: number[] = [];
  for (const time of stamps) {
    if (time === undefined || !Number.isFinite(time) || time < (times.at(-1) ?? -Infinity))
      return null;
    times.push(time);
  }
  return times;
}

/** Where a desktop video sits on the run clock; null without a readable start and a length. */
export function recordingInterval(
  recording: RunDesktopRecording | undefined,
): RecordingInterval | null {
  if (!recording) return null;
  const startMs = Date.parse(recording.startedAt);
  const endMs = startMs + recording.durationMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || recording.durationMs <= 0)
    return null;
  return { startMs, endMs, recording };
}

/** The run clock of every stream of a run, or null when none has a timed capture or a video. */
export function runClock(streams: readonly ClockStream[]): RunClock | null {
  const moments = new Set<number>();
  for (const stream of streams) {
    const stamps = traceItems(stream)
      .filter(isCapture)
      .map((item) => (item.at === undefined ? Number.NaN : Date.parse(item.at)));
    for (const time of captureTimes(stamps) ?? []) moments.add(time);
    const video = recordingInterval(stream.recording);
    if (video) moments.add(video.startMs).add(video.endMs);
  }
  const boundariesMs = [...moments].sort((a, b) => a - b);
  if (boundariesMs.length === 0) return null;
  return { startMs: boundariesMs[0]!, endMs: boundariesMs.at(-1)!, boundariesMs };
}

/** A run clock time or span in whole minutes and seconds: `02:31`. Minutes go past 59. */
export function formatRunTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
