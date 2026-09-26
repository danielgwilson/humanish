// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecordingVideo } from "../components/recording-video";
import type { RecordingInterval } from "../lib/grid-recording";

const startMs = Date.parse("2026-09-26T10:00:00.000Z");
const interval: RecordingInterval = {
  startMs,
  endMs: startMs + 10_000,
  recording: {
    schema: "humanish.desktop-recording.v1", path: "recordings/participant.mp4", mimeType: "video/mp4",
    startedAt: new Date(startMs).toISOString(), durationMs: 10_000, bytes: 2048,
    audioSources: ["microphone-input", "speaker-output"], complete: false
  }
};

let container: HTMLDivElement;
let root: Root;
const originalCurrentTime = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  if (originalCurrentTime) Object.defineProperty(HTMLMediaElement.prototype, "currentTime", originalCurrentTime);
  vi.restoreAllMocks();
});

describe("desktop recording playback", () => {
  it("seeks on deliberate cursor changes and lets the video advance between study ticks", async () => {
    let currentTime = 0;
    const assignments: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => { currentTime = value; assignments.push(value); }
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const render = async (atMs: number, seekRevision: number, playing = true) => act(async () => root.render(
      <RecordingVideo interval={interval} atMs={atMs} playing={playing} speed={2} seekRevision={seekRevision} label="Participant 1" />
    ));

    await render(startMs + 1000, 1);
    expect(assignments.at(-1)).toBe(1);
    const afterInitialSeek = assignments.length;
    await render(startMs + 1500, 1);
    expect(assignments).toHaveLength(afterInitialSeek);
    await render(startMs + 4000, 2);
    expect(assignments.at(-1)).toBe(4);
    await render(startMs + 6000, 3, false);
    expect(assignments.at(-1)).toBe(6);
    expect(pause).toHaveBeenCalled();
    expect(container.querySelector("video")?.getAttribute("src")).toBe("../recordings/participant.mp4");
    expect(container.textContent).toContain("Microphone input offered");
    expect(container.textContent).toContain("Speaker output");
    expect(container.textContent).toContain("Partial desktop recording");
  });
});
