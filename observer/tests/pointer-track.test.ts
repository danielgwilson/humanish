import { describe, expect, it } from "vitest";
import type { PlayerModel, PlayerRow } from "../lib/player-model";
import {
  framePointers,
  lastLabelAt,
  nextChangeMs,
  pointerAt,
  PRESS_RING_MS,
} from "../lib/pointer-track";

const frames = [0, 1, 2].map((index) => ({
  index,
  itemId: `turn-${index}`,
  title: `turn-${index}`,
  href: `../screenshots/turn-${index}.png`,
  atMs: 10_000 * (index + 1),
}));

function row(patch: Partial<PlayerRow> & Pick<PlayerRow, "id" | "frameIndex">): PlayerRow {
  return { kind: "ui_action", title: patch.id, isFrame: false, ...patch };
}

function model(rows: PlayerRow[], timed = true): PlayerModel {
  return {
    frames: timed ? frames : frames.map(({ atMs: _atMs, ...frame }) => frame),
    rows,
    avgFrameMs: 10_000,
    paced: timed ? "recorded" : "avg",
    touch: false,
  };
}

describe("framePointers", () => {
  const click = row({
    id: "click-1",
    frameIndex: 0,
    atMs: 18_000,
    coord: { x: 400, y: 300 },
    pointerPath: [{ x: 400, y: 300 }],
  });
  const move = row({
    id: "move-1",
    frameIndex: 1,
    atMs: 25_000,
    pointerPath: [{ x: 100, y: 100 }],
  });

  it("hides the pointer before any recorded position and lands the click at its time", () => {
    const [first] = framePointers(model([click, move]), "p1");
    expect(first!.rest).toBeNull();
    expect(pointerAt(first!, 0).point).toBeNull();
    expect(pointerAt(first!, 8_000)).toEqual({
      point: { x: 400, y: 300 },
      pressedAgoMs: 0,
      held: false,
    });
    expect(pointerAt(first!, 9_000).pressedAgoMs).toBe(1_000);
  });

  it("starts the next capture where the last action left the pointer and glides to the next", () => {
    const [, second] = framePointers(model([click, move]), "p1");
    expect(second!.rest).toEqual({ x: 400, y: 300 });
    expect(pointerAt(second!, 0).point).toEqual({ x: 400, y: 300 });
    const glide = second!.moves[0]!;
    expect(glide.endMs).toBe(5_000);
    expect(glide.startMs).toBeLessThan(5_000);
    expect(glide.startMs).toBeGreaterThan(4_400);
    const middle = pointerAt(second!, (glide.startMs + glide.endMs) / 2).point!;
    expect(middle.x).toBeLessThan(400);
    expect(middle.x).toBeGreaterThan(100);
    expect(pointerAt(second!, 6_000)).toEqual({
      point: { x: 100, y: 100 },
      pressedAgoMs: null,
      held: false,
    });
  });

  it("glides to where a drag presses, then holds the button along every recorded point", () => {
    const drag = row({
      id: "drag-1",
      frameIndex: 0,
      atMs: 15_000,
      pointerPath: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    });
    const before = row({
      id: "move-0",
      frameIndex: 0,
      atMs: 11_000,
      pointerPath: [{ x: 300, y: 300 }],
    });
    const [first] = framePointers(model([before, drag]), "p1");
    const { startMs, endMs } = first!.moves[1]!;
    const seen = Array.from({ length: 81 }, (_, step) =>
      pointerAt(first!, startMs + ((endMs - startMs) * step) / 80),
    );
    const firstHeld = seen.findIndex((state) => state.held);
    expect(firstHeld).toBeGreaterThan(0);
    expect(seen.slice(0, firstHeld).every((state) => !state.held)).toBe(true);
    expect(
      seen.some((s) => s.held && s.point!.x === 100 && s.point!.y > 0 && s.point!.y < 100),
    ).toBe(true);
    expect(seen.at(-1)).toEqual({ point: { x: 100, y: 100 }, pressedAgoMs: null, held: false });
  });
});

describe("framePointers at the edges of the evidence", () => {
  const click = row({
    id: "click-1",
    frameIndex: 0,
    atMs: 18_000,
    coord: { x: 400, y: 300 },
    pointerPath: [{ x: 400, y: 300 }],
  });
  const move = row({
    id: "move-1",
    frameIndex: 1,
    atMs: 25_000,
    pointerPath: [{ x: 100, y: 100 }],
  });

  it("draws no movement for untimed captures, only where the pointer rests at each", () => {
    const untimed = [
      row({ id: "a", frameIndex: 0, coord: { x: 1, y: 1 }, pointerPath: [{ x: 1, y: 1 }] }),
      row({ id: "b", frameIndex: 0, pointerPath: [{ x: 50, y: 50 }] }),
    ];
    const [first, second] = framePointers(model(untimed, false), "p1");
    expect(first!.moves).toEqual([]);
    expect(second!.rest).toEqual({ x: 50, y: 50 });
  });

  it("rests an action recorded before its capture on that capture without replaying it", () => {
    const early = row({
      id: "early",
      frameIndex: 0,
      atMs: 9_000,
      coord: { x: 7, y: 7 },
      pointerPath: [{ x: 7, y: 7 }],
    });
    const [first] = framePointers(model([early]), "p1");
    expect(first!.moves).toEqual([]);
    expect(pointerAt(first!, 0)).toEqual({
      point: { x: 7, y: 7 },
      pressedAgoMs: null,
      held: false,
    });
  });

  it("rings for a press and not for a release", () => {
    const up = row({
      id: "up",
      title: "mouse up left (5, 5)",
      frameIndex: 0,
      atMs: 12_000,
      coord: { x: 5, y: 5 },
      pointerPath: [{ x: 5, y: 5 }],
    });
    const [first] = framePointers(model([click, up]), "p1");
    expect(first!.moves.map((move) => move.press)).toEqual([true, false]);
  });

  it("shows an older bundle's pointer only at each click and its ring", () => {
    const legacy = row({ id: "old-click", frameIndex: 1, atMs: 24_000, coord: { x: 60, y: 40 } });
    const [, second] = framePointers(model([legacy]), "p1");
    expect(second!.pressesOnly).toBe(true);
    expect(pointerAt(second!, 1_000).point).toBeNull();
    expect(pointerAt(second!, 4_100)).toMatchObject({ point: { x: 60, y: 40 }, pressedAgoMs: 100 });
    expect(pointerAt(second!, 4_000 + PRESS_RING_MS).point).toBeNull();
  });

  it("draws a recorded glide through its own points, one every 16 ms, then lands", () => {
    const glided = row({
      id: "glided",
      frameIndex: 1,
      atMs: 25_000,
      coord: { x: 430, y: 300 },
      pointerPath: [{ x: 430, y: 300 }],
      pointerApproach: [
        { x: 400, y: 300 },
        { x: 410, y: 290 },
        { x: 420, y: 295 },
      ],
    });
    const [, second] = framePointers(model([click, glided]), "p1");
    const move = second!.moves[0]!;
    expect(move.endMs - move.startMs).toBe(48);
    expect(pointerAt(second!, move.startMs + 16).point).toEqual({ x: 410, y: 290 });
    expect(pointerAt(second!, move.startMs + 24).point).toEqual({ x: 415, y: 292.5 });
    expect(pointerAt(second!, move.endMs).point).toEqual({ x: 430, y: 300 });
  });

  it("names when the drawn pointer next changes so playback can idle between moves", () => {
    const [, second] = framePointers(model([click, move]), "p1");
    const glide = second!.moves[0]!;
    expect(nextChangeMs(second!, 0)).toBe(glide.startMs);
    expect(nextChangeMs(second!, glide.startMs + 1)).toBe(0);
    expect(nextChangeMs(second!, glide.endMs + PRESS_RING_MS + 1)).toBeNull();
  });

  it("never runs a move backwards when recorded times are out of order", () => {
    const early = row({ id: "late", frameIndex: 0, atMs: 17_000, pointerPath: [{ x: 9, y: 9 }] });
    const earlier = row({
      id: "early",
      frameIndex: 0,
      atMs: 12_000,
      pointerPath: [{ x: 1, y: 1 }],
    });
    const [first] = framePointers(model([early, earlier]), "p1");
    const [one, two] = first!.moves;
    expect(two!.startMs).toBeGreaterThanOrEqual(one!.endMs);
    expect(two!.endMs).toBeGreaterThanOrEqual(two!.startMs);
  });
});

describe("framePointers on a touch screen", () => {
  const touchModel = (rows: PlayerRow[]): PlayerModel => ({ ...model(rows), touch: true });
  const tap = row({
    id: "tap",
    title: "click (400, 300)",
    frameIndex: 0,
    atMs: 18_000,
    coord: { x: 400, y: 300 },
    pointerPath: [{ x: 400, y: 300 }],
    pointerApproach: [
      { x: 100, y: 100 },
      { x: 250, y: 200 },
    ],
  });
  const hover = row({
    id: "hover",
    frameIndex: 1,
    atMs: 22_000,
    pointerPath: [{ x: 600, y: 500 }],
  });
  const swipe = row({
    id: "swipe",
    title: "drag (100, 700) to (100, 200)",
    frameIndex: 1,
    atMs: 26_000,
    coord: { x: 100, y: 700 },
    pointerPath: [
      { x: 100, y: 700 },
      { x: 100, y: 200 },
    ],
  });

  it("shows a fingertip only where a tap lands, with no approach, until its ring ends", () => {
    const [first] = framePointers(touchModel([tap]), "p1");
    expect(first!.rest).toBeNull();
    expect(pointerAt(first!, 7_999).point).toBeNull();
    expect(pointerAt(first!, 8_000).point).toEqual({ x: 400, y: 300 });
    expect(pointerAt(first!, 8_000 + PRESS_RING_MS - 1).point).toEqual({ x: 400, y: 300 });
    expect(pointerAt(first!, 8_000 + PRESS_RING_MS).point).toBeNull();
  });

  it("draws nothing for a move without a press and follows a drag held from its first point", () => {
    const [, second] = framePointers(touchModel([tap, hover, swipe]), "p1");
    expect(second!.moves.map((move) => move.rowId)).toEqual(["swipe"]);
    expect(pointerAt(second!, 0).point).toBeNull();
    const drag = second!.moves[0]!;
    expect(pointerAt(second!, drag.startMs)).toMatchObject({
      point: { x: 100, y: 700 },
      held: true,
    });
    expect(pointerAt(second!, drag.endMs).point).toEqual({ x: 100, y: 200 });
  });

  it("names the action the pointer last finished", () => {
    const [first] = framePointers(model([tap]), "p1");
    expect(lastLabelAt(first!, 7_000)).toBeNull();
    expect(lastLabelAt(first!, 8_000)).toBe("click (400, 300)");
  });
});
