import { describe, expect, it } from "vitest";

import type { CuaAction } from "../../../src/actors/computer-use/loop.js";
import {
  DONE,
  MINUTE,
  NEW_ROW,
  QUIET,
  ROW,
  WAIT,
  frame,
  runWatching,
  turnOf,
  waitItems,
  watchesOf,
  type WatchRun,
} from "../../helpers/watching-loop.js";

// A turn that only waits watches the screen: no wait goes to the desktop, the loop looks every
// idleWaitMs, and the next model request comes when the screen changes and holds still, or when
// the wait time passes. The fake desktop's screen is a function of the injected clock, which moves
// only when the loop sleeps, so every request time below is exact.

describe("a participant that sends one wait per turn on a screen that changes once", () => {
  it("makes 9 requests by the change at minute 17 with idleWaitMs 5 s and maxWaitMs 30 min", async () => {
    const run = await runWatching({
      screen: (atMs) => (atMs >= 17 * MINUTE ? NEW_ROW : QUIET),
      turn: (request) => (request.observation.screenshot === NEW_ROW ? DONE : turnOf([WAIT])),
      loop: { idleWaitMs: 5_000, maxWaitMs: 30 * MINUTE },
    });
    // Watch n lasts 5 s x 2^(n-1) while the screen stays the same, and starts when the ones
    // before it end: at 0, 5, 15, 35, 75, 155, 315 and 635 s. Watch 8 would last 640 s, to 1,275 s,
    // but its 77th look (635 s + 77 x 5 s = 1,020 s, minute 17) sees the new row move and its quick
    // look 0.5 s later sees it still, so request 9 comes at 1,020.5 s with the new row: 9 requests.
    // Today each 5 s wait ends in a request, about 204 by minute 17; the design's flat rule made 2.
    expect(run.requests.map((request) => request.at)).toEqual([
      0, 5_000, 15_000, 35_000, 75_000, 155_000, 315_000, 635_000, 1_020_500,
    ]);
    expect(run.requests.at(-1)?.observation.screenshot).toBe(NEW_ROW);
    expect(run.executed).toEqual([]);
    expect(watchesOf(run.result).map((watch) => [watch.limitMs, watch.wake, watch.looks])).toEqual([
      [5_000, "limit", 1],
      [10_000, "limit", 2],
      [20_000, "limit", 4],
      [40_000, "limit", 8],
      [80_000, "limit", 16],
      [160_000, "limit", 32],
      [320_000, "limit", 64],
      [640_000, "changed", 78],
    ]);
    expect(watchesOf(run.result).at(-1)?.area).toEqual({ x: 0, y: 64, width: 160, height: 48 });
  });
});

describe("the watch length over idle turns in a row", () => {
  const limits = (run: WatchRun) => watchesOf(run.result).map((watch) => watch.limitMs);

  it("doubles on a static screen from today's wait length up to maxWaitMs", async () => {
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => (n <= 7 ? turnOf([WAIT]) : DONE),
      loop: { maxWaitMs: 60_000 },
    });
    expect(limits(run)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    // Steady state: one request per maxWaitMs.
    expect(run.requests.map((request) => request.at)).toEqual([
      0, 5_000, 15_000, 35_000, 75_000, 135_000, 195_000, 255_000,
    ]);
  });

  it("doubles on a screen that never holds still, as with a video, and wakes on none of it", async () => {
    // The row's grey changes at every observe, so no look sees one of its 30 tiles still: each
    // watch ends at its limit and the next lasts twice as long, as on a static screen.
    const shades = [20, 60, 100, 140, 180];
    let observes = 0;
    const run = await runWatching({
      screen: () => frame([ROW], shades[observes++ % shades.length]),
      turn: (_request, n) => (n <= 5 ? turnOf([WAIT]) : DONE),
    });
    expect(watchesOf(run.result).map((watch) => [watch.limitMs, watch.wake])).toEqual([
      [5_000, "limit"],
      [10_000, "limit"],
      [20_000, "limit"],
      [40_000, "limit"],
      [80_000, "limit"],
    ]);
    expect(run.requests.map((request) => request.at)).toEqual([
      0, 5_000, 15_000, 35_000, 75_000, 155_000,
    ]);
  });

  it("starts again from today's length after a watch the screen changed", async () => {
    // Watch 3 runs from 15 s for 20 s; its look at 25 s sees the new row and its quick look at
    // 25.5 s sees it still. The screen then stays the same.
    const run = await runWatching({
      screen: (atMs) => (atMs >= 25_000 ? NEW_ROW : QUIET),
      turn: (_request, n) => (n <= 5 ? turnOf([WAIT]) : DONE),
    });
    expect(watchesOf(run.result).map((watch) => [watch.limitMs, watch.wake])).toEqual([
      [5_000, "limit"],
      [10_000, "limit"],
      [20_000, "changed"],
      [5_000, "limit"],
      [10_000, "limit"],
    ]);
  });

  it("starts again from today's length after a turn with another action", async () => {
    const script = [[WAIT], [WAIT], [{ kind: "click", x: 5, y: 5 } satisfies CuaAction], [WAIT]];
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => (n <= script.length ? turnOf(script[n - 1]!) : DONE),
    });
    expect(limits(run)).toEqual([5_000, 10_000, 5_000]);
  });

  it("keeps today's pacing on a static screen when maxWaitMs equals idleWaitMs", async () => {
    // Three waits with no duration plan 3 x 5 s; the cap is the larger of that and maxWaitMs.
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => (n <= 3 ? turnOf([WAIT, WAIT, WAIT]) : DONE),
      loop: { idleWaitMs: 5_000, maxWaitMs: 5_000 },
    });
    expect(run.requests.map((request) => request.at)).toEqual([0, 15_000, 30_000, 45_000]);
  });
});

describe("the turn a watch ends", () => {
  it("hands the look that woke the participant to its next request, with no observe after it", async () => {
    // Looks at 5, 10 and 15 s; the one at 20 s sees the new row and the quick look at 20.5 s sees
    // it still.
    const run = await runWatching({
      screen: (atMs) => (atMs >= 20_000 ? NEW_ROW : QUIET),
      turn: (_request, n) => (n === 1 ? turnOf([{ kind: "wait", ms: 60_000 }]) : DONE),
    });
    expect(run.observes).toEqual([0, 5_000, 10_000, 15_000, 20_000, 20_500]);
    expect(run.requests.map((request) => request.at)).toEqual([0, 20_500]);
    expect(run.requests[1]?.observation.screenshot).toBe(NEW_ROW);
    expect(run.requests[1]?.hint).toBe(
      "Your wait lasted 21 seconds and ended when the screen changed.",
    );
    expect(
      run.result.trace.items.filter((item) => item.kind === "screenshot").map((item) => item.title),
    ).toEqual(["turn-00-start", "turn-01"]);
  });

  it("titles a turn's waits with the part of the watch each covered, in order", async () => {
    // Three waits with no duration plan 5 s each. The row appears at 3 s: the look at 5 s sees it
    // move and the quick look at 5.5 s sees it still, half a second into the second wait.
    const run = await runWatching({
      screen: (atMs) => (atMs >= 3_000 ? NEW_ROW : QUIET),
      turn: (_request, n) => (n === 1 ? turnOf([WAIT, WAIT, WAIT]) : DONE),
    });
    expect(waitItems(run.result).map((item) => [item.title, item.watch?.wake])).toEqual([
      ["wait 5000ms", undefined],
      ["wait 500ms", "changed"],
      ["wait 0ms", undefined],
    ]);
    expect(run.result.trace.counts.actions).toBe(3);
  });

  it("runs no watch for a turn of only a screenshot or a 0 ms wait, and counts a negative wait as 0", async () => {
    const script: CuaAction[][] = [
      [{ kind: "screenshot" }],
      [{ kind: "wait", ms: 0 }],
      [
        { kind: "wait", ms: -5_000 },
        { kind: "wait", ms: 5_000 },
      ],
    ];
    const run = await runWatching({
      screen: () => QUIET,
      turn: (_request, n) => (n <= script.length ? turnOf(script[n - 1]!) : DONE),
    });
    expect(run.executed).toEqual([{ kind: "screenshot" }, { kind: "wait", ms: 0 }]);
    expect(watchesOf(run.result).map((watch) => watch.limitMs)).toEqual([5_000]);
    expect(waitItems(run.result).map((item) => item.title)).toEqual([
      "wait 0ms",
      "wait 0ms",
      "wait 5000ms",
    ]);
  });

  it("counts a change that woke the participant as progress the frame hash missed", async () => {
    // Each turn waits 20 s and the progress key never changes. The row appears or goes 3 s into
    // each watch: its look at 5 s sees it move and the quick look at 5.5 s sees it still, so the
    // screen toggles at 3 s and then every 5.5 s. Without the wake counted, the fourth wait would
    // trip the no-progress backstop at 3.
    const run = await runWatching({
      screen: (atMs) =>
        atMs >= 3_000 && Math.floor((atMs - 3_000) / 5_500) % 2 === 0 ? NEW_ROW : QUIET,
      observe: () => ({ stateSignature: "same" }),
      turn: (_request, n) => (n <= 6 ? turnOf([{ kind: "wait", ms: 20_000 }]) : DONE),
      loop: { noProgressSteps: 3 },
    });
    expect(watchesOf(run.result).map((watch) => watch.wake)).toEqual(Array(6).fill("changed"));
    expect(run.requests.map((request) => request.at)).toEqual([
      0, 5_500, 11_000, 16_500, 22_000, 27_500, 33_000,
    ]);
    expect(run.result.completionReason).toBe("goal_satisfied");
    expect(run.result.trace.counts.noProgressTurns).toBe(0);
  });
});
