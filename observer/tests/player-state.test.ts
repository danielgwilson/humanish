import { describe, expect, it } from "vitest";
import { boundedWindow, frameAtElapsedMs, frameElapsedMs, groupPlayerRows, type PlayerModel, type PlayerRow } from "../lib/player-model";
import { openPlayback, playbackIndex, seekPlayback } from "../lib/player-state";
import { formatHash, parseHash } from "../lib/route";
import { fittedSize, pinPosition } from "../components/player-stage";

function model(count = 3): PlayerModel {
  return { paced: "recorded", avgFrameMs: 1000, rows: [], frames: Array.from({ length: count }, (_, index) => ({ index, itemId: `frame-${index}`, href: `../screenshots/${index}.png`, title: `Capture ${index}`, atMs: 10_000 + index * index * 1000 })) };
}

describe("explicit playback intent", () => {
  it("keeps paused latest evidence stable while a following viewer advances", () => {
    const before = model();
    const paused = seekPlayback(before, 2);
    const following = openPlayback(before, true, null, null);
    expect(playbackIndex(paused, model(4))).toBe(2);
    expect(playbackIndex(following, model(4))).toBe(3);
    expect(paused.mode).toBe("replay");
  });
  it("retains frame identity when earlier frames change and names missing evidence", () => {
    const before = model();
    const state = seekPlayback(before, 2);
    const after = { ...before, frames: before.frames.slice(1) };
    expect(playbackIndex(state, after)).toBe(1);
    expect(playbackIndex(state, { ...before, frames: before.frames.slice(0, 2) })).toBe(-1);
    expect(playbackIndex(openPlayback(before, false, 99, null), before)).toBe(-1);
  });
  it("handles explicit live reload, replay addressing and screenshot-free streams", () => {
    const data = model();
    expect(openPlayback(data, true, 0, null).mode).toBe("replay");
    expect(openPlayback(data, true, null, "live").mode).toBe("live");
    expect(playbackIndex(openPlayback(model(0), true, null, null), model(0))).toBe(-1);
    expect(parseHash(formatHash("lane/one", null, "live"))).toEqual({ laneId: "lane/one", frame: null, mode: "live" });
    expect(parseHash("#/lane/%E0%A4%A")).toEqual({ laneId: null, frame: null });
    expect(parseHash("#/lane/example/f/999999999999999999999999999999").frame).toBeNull();
  });
});

describe("recorded geometry and time", () => {
  it("contains every portrait pixel and uses the same raster rectangle for pins", () => {
    expect(fittedSize({ width: 500, height: 1000 }, { width: 800, height: 600 }, "fit")).toEqual({ width: 300, height: 600 });
    expect(fittedSize({ width: 500, height: 1000 }, { width: 800, height: 600 }, "actual")).toEqual({ width: 500, height: 1000 });
    expect(pinPosition({ x: 250, y: 500 }, { width: 500, height: 1000 })).toEqual({ left: "50%", top: "50%" });
    expect(pinPosition({ x: 501, y: 2 }, { width: 500, height: 1000 })).toBeNull();
  });
  it("seeks irregular capture stamps without inventing intermediate screenshots", () => {
    const data = model(5);
    expect(frameElapsedMs(data, 4)).toBe(16_000);
    expect(frameAtElapsedMs(data, 8000)).toBe(2);
    expect(frameAtElapsedMs(data, 9000)).toBe(3);
    expect(frameAtElapsedMs(data, -10)).toBe(0);
  });
  it("groups waits without changing evidence and bounds large projections", () => {
    const rows: PlayerRow[] = Array.from({ length: 291 }, (_, index) => ({ id: `wait-${index}`, kind: "ui_action", title: "wait 1s", isFrame: false, frameIndex: 2 }));
    const groups = groupPlayerRows(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(291);
    expect(groupPlayerRows(rows, false)).toHaveLength(291);
    expect(rows).toHaveLength(291);
    expect(boundedWindow(10_000, 5000, 100)).toEqual({ start: 4950, end: 5050 });
    expect(boundedWindow(10_000, 9999, 100)).toEqual({ start: 9900, end: 10_000 });
  });
});
