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
    currentTime = 0;
    const video = container.querySelector("video")!;
    await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
    expect(assignments.at(-1)).toBe(1);
    const afterInitialSeek = assignments.length;
    await render(startMs + 1500, 1);
    expect(assignments).toHaveLength(afterInitialSeek);
    Object.defineProperty(video, "readyState", { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
    currentTime = 1;
    await render(startMs + 3000, 1);
    expect(assignments.at(-1)).toBe(3);
    await render(startMs + 4000, 2);
    expect(assignments.at(-1)).toBe(4);
    await render(startMs + 6000, 3, false);
    expect(assignments.at(-1)).toBe(6);
    expect(pause).toHaveBeenCalled();
    expect(container.querySelector("video")?.getAttribute("src")).toBe("../recordings/participant.mp4");
    expect(container.textContent).toContain("Microphone input offered");
    expect(container.textContent).toContain("Speaker output");
    expect(container.textContent).toContain("Partial desktop recording");
    expect(container.textContent).toContain("Desktop video · 10s");
  });

  it("resynchronizes on reentry and retries a blocked play from the explicit audio control", async () => {
    let currentTime = 0;
    const assignments: number[] = [];
    Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => { currentTime = value; assignments.push(value); }
    });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const view = (atMs: number) => <RecordingVideo interval={interval} atMs={atMs} playing speed={1} seekRevision={4} label="Participant 1" />;

    await act(async () => root.render(view(startMs + 2000)));
    await act(async () => Promise.resolve());
    expect(container.textContent).toContain("Playback was blocked by the browser");
    const beforeToggle = assignments.length;
    const audio = container.querySelector<HTMLButtonElement>('[aria-label="Enable recorded audio"]')!;
    await act(async () => { audio.click(); await Promise.resolve(); });
    expect(container.querySelector("video")?.muted).toBe(false);
    expect(assignments).toHaveLength(beforeToggle);
    expect(currentTime).toBe(2);
    expect(container.textContent).not.toContain("Playback was blocked by the browser");

    await act(async () => root.render(null));
    currentTime = 0;
    await act(async () => root.render(view(startMs + 7000)));
    expect(assignments.at(-1)).toBe(7);
    expect(play).toHaveBeenCalled();
  });

  it("returns to muted playback when the selected participant changes", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const render = async (selected: RecordingInterval) => act(async () => root.render(
      <RecordingVideo key={selected.recording.path} interval={selected} atMs={selected.startMs + 1000}
        playing={false} speed={1} seekRevision={1} label="Selected participant" />
    ));
    await render(interval);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Enable recorded audio"]')!.click());
    const first = container.querySelector("video")!;
    expect(first.muted).toBe(false);

    await render({ ...interval, recording: { ...interval.recording, path: "recordings/other.mp4" } });
    expect(container.querySelector("video")).not.toBe(first);
    expect(container.querySelector("video")?.muted).toBe(true);
  });
});
