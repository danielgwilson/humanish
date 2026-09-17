// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import type { ObserverData, ObserverStream } from "../lib/observer-data";
import { useStudyPlayback } from "../lib/use-study-playback";

const origin = Date.parse("2026-09-01T10:00:00.000Z");
let container: HTMLDivElement;
let root: Root;
let playback: ReturnType<typeof useStudyPlayback>;

function lane(id: string, times: (number | null)[], ids?: string[]): ObserverStream {
  const stream = structuredClone((live as unknown as ObserverData).streams[0]!);
  stream.id = id;
  stream.actor!.items = times.map((offset, index) => ({
    id: ids?.[index] ?? `${id}-${index}`, kind: "screenshot", lifecycle: "completed", title: `Capture ${index}`,
    ...(offset === null ? {} : { at: new Date(origin + offset).toISOString() }),
    screenshotRef: { path: `screenshots/${id}-${index}.png`, redaction: "none" }
  }));
  return stream;
}

function Probe({ streams, runId }: { streams: ObserverStream[]; runId: string }) {
  playback = useStudyPlayback(runId, streams);
  return null;
}

async function render(streams: ObserverStream[], runId = "study") {
  await act(async () => { root.render(<Probe streams={streams} runId={runId} />); });
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("Study playback controller", () => {
  it("keeps exact capture identity at duplicate stamps and preserves missing evidence", async () => {
    const stream = lane("duplicate", [0, 1000, 1000], ["first", "second", "third"]);
    await render([stream]);
    await act(async () => playback.selectFrame("duplicate", 1, "selected-action"));
    expect(playback.atMs).toBe(origin + 1000);
    expect(playback.playerControl("duplicate")).toMatchObject({ moment: { kind: "capture", frame: { itemId: "second" } }, eventId: "selected-action" });
    await render([lane("duplicate", [0, 1000], ["first", "third"])]);
    expect(playback.playerControl("duplicate")).toMatchObject({ moment: { kind: "no-captures" }, unavailableFrame: true, eventId: "selected-action" });
    await act(async () => playback.seek(origin + 1000));
    expect(playback.playerControl("duplicate")).toMatchObject({ moment: { kind: "capture", frame: { itemId: "third" } }, eventId: null });
  });

  it("holds an absolute cursor through removal, recovery and appended captures", async () => {
    await render([lane("one", [0, 1000, 10_000])]);
    await act(async () => playback.seek(origin + 5000));
    await render([lane("one", [8000, 10_000])]);
    expect(playback.atMs).toBe(origin + 5000);
    expect(playback.cursorUnavailable).toBe(true);
    expect(playback.playerControl("one").moment.kind).toBe("before-first");
    await render([lane("one", [])]);
    expect(playback.atMs).toBe(origin + 5000);
    expect(playback.playerControl("one").moment.kind).toBe("no-captures");
    await render([lane("one", [0, 1000, 10_000, 20_000])]);
    expect(playback.atMs).toBe(origin + 5000);
    expect(playback.playing).toBe(false);
    expect(playback.playerControl("one").moment).toMatchObject({ kind: "capture", frame: { index: 1 }, ageMs: 4000 });
  });

  it("continues one elapsed clock across unchanged polls and participant projections", async () => {
    vi.useFakeTimers();
    const streams = [lane("early", [0, 10_000]), lane("late", [5000, 20_000])];
    await render(streams);
    await act(async () => playback.seek(origin + 2000));
    await act(async () => playback.toggle());
    await act(async () => vi.advanceTimersByTime(1000));
    expect(playback.atMs).toBe(origin + 3000);
    expect(playback.playerControl("late").moment.kind).toBe("before-first");
    await render(structuredClone(streams));
    await act(async () => vi.advanceTimersByTime(2500));
    expect(playback.atMs).toBe(origin + 5500);
    expect(playback.playerControl("late")).toMatchObject({ playing: true, moment: { kind: "capture", ageMs: 500 } });
    await act(async () => playback.playerControl("early").onToggle());
    expect(playback.playing).toBe(false);
    expect(playback.atMs).toBe(origin + 5500);
  });

  it("does not invent timing for legacy lanes and resets when the study changes", async () => {
    await render([lane("timed", [0, 10_000]), lane("old", [null, null])]);
    await act(async () => playback.seek(origin + 5000));
    expect(playback.playerControl("old").moment.kind).toBe("timing-unavailable");
    await render([lane("single", [1000])], "different-study");
    expect(playback.reviewing).toBe(false);
    expect(playback.playing).toBe(false);
    expect(playback.recording.startMs).toBe(origin + 1000);
    expect(playback.recording.endMs).toBe(origin + 1000);
    expect(playback.selection).toBeNull();
  });
});
