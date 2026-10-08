import { describe, expect, it } from "vitest";

import type { ActorTraceItem } from "../../src/actors/contract.js";
import type { RunDesktopRecording } from "../../src/evidence/desktop-recording-types.js";
import {
  captureTimes,
  formatRunTime,
  isCapture,
  recordingInterval,
  runClock,
  type ClockStream,
} from "../../src/run/run-clock.js";

const origin = Date.parse("2026-09-01T10:00:00.000Z");

function item(id: string, offsetMs: number | null, kind: ActorTraceItem["kind"]): ActorTraceItem {
  return {
    id,
    kind,
    lifecycle: "completed",
    title: id,
    screenshotRef: { path: `screenshots/${id}.png`, redaction: "blurred" },
    ...(offsetMs === null ? {} : { at: new Date(origin + offsetMs).toISOString() }),
  };
}

const captures = (...offsets: Array<number | null>): ClockStream => ({
  actor: { items: offsets.map((offset, index) => item(`capture-${index}`, offset, "screenshot")) },
});

function video(startedAt: string, durationMs: number): RunDesktopRecording {
  return {
    schema: "humanish.desktop-recording.v1",
    path: "recordings/desktop.mp4",
    mimeType: "video/mp4",
    startedAt,
    durationMs,
    bytes: 1,
    audioSources: [],
    complete: true,
  };
}

describe("the run clock", () => {
  it("runs from the first to the last capture of any participant", () => {
    expect(runClock([captures(0, 3000, 9000), captures(1000, 6000)])).toEqual({
      startMs: origin,
      endMs: origin + 9000,
      boundariesMs: [0, 1000, 3000, 6000, 9000].map((offset) => origin + offset),
    });
  });

  it("leaves out a participant whose stamps go back or are missing", () => {
    const clock = runClock([captures(0, 3000), captures(5000, 4000, 8000), captures(500, null)]);

    expect(clock).toEqual({
      startMs: origin,
      endMs: origin + 3000,
      boundariesMs: [origin, origin + 3000],
    });
  });

  it("starts with a desktop video that starts before the first capture", () => {
    const stream = {
      ...captures(2000, 4000),
      recording: video("2026-09-01T10:00:00.500Z", 9000),
    };

    expect(runClock([stream])).toEqual({
      startMs: origin + 500,
      endMs: origin + 9500,
      boundariesMs: [500, 2000, 4000, 9500].map((offset) => origin + offset),
    });
  });

  it("reads a running participant's flushed captures and a scripted action's own capture", () => {
    const running: ClockStream = { liveActor: { items: [item("live", 7000, "screenshot")] } };
    const scripted: ClockStream = { actor: { items: [item("action", 2000, "ui_action")] } };

    expect(runClock([running, scripted])?.boundariesMs).toEqual([origin + 2000, origin + 7000]);
  });

  it("counts no notice that cites a screenshot, no command and no video without a length", () => {
    const streams: ClockStream[] = [
      { actor: { items: [item("context", 1000, "notice"), item("check", 2000, "command")] } },
      { actor: { items: [] }, recording: video("2026-09-01T10:00:03.000Z", 0) },
      { recording: video("not a time", 5000) },
    ];

    expect(runClock(streams)).toBeNull();
    expect(runClock([])).toBeNull();
  });
});

describe("a participant's captures", () => {
  it("are screenshots and scripted actions that carry their own screenshot", () => {
    expect(isCapture(item("shot", 0, "screenshot"))).toBe(true);
    expect(isCapture(item("click", 0, "ui_action"))).toBe(true);
    expect(isCapture({ kind: "ui_action" })).toBe(false);
    expect(isCapture(item("context", 0, "notice"))).toBe(false);
  });

  it("have times only when every stamp is there and none goes back", () => {
    expect(captureTimes([1000, 1000, 4000])).toEqual([1000, 1000, 4000]);
    expect(captureTimes([])).toEqual([]);
    expect(captureTimes([2000, 1000])).toBeNull();
    expect(captureTimes([1000, undefined])).toBeNull();
    expect(captureTimes([Number.NaN])).toBeNull();
  });
});

describe("a desktop video on the run clock", () => {
  it("spans its start and length, and has no place without a usable start or a length", () => {
    const recording = video("2026-09-01T10:00:01.000Z", 8000);

    expect(recordingInterval(recording)).toEqual({
      startMs: origin + 1000,
      endMs: origin + 9000,
      recording,
    });
    expect(recordingInterval(video("2026-09-01T10:00:01.000Z", 0))).toBeNull();
    expect(recordingInterval(video("yesterday", 8000))).toBeNull();
    expect(recordingInterval(undefined)).toBeNull();
  });
});

describe("a run clock time", () => {
  it.each([
    [0, "00:00"],
    [999, "00:00"],
    [151_900, "02:31"],
    [3_600_000, "60:00"],
    [-5, "00:00"],
  ])("%d ms reads %s", (ms, text) => {
    expect(formatRunTime(ms)).toBe(text);
  });
});
