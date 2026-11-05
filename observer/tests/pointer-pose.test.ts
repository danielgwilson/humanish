import { describe, expect, it } from "vitest";
import { pointerPose } from "../lib/pointer-pose";
import type { FramePointer } from "../lib/pointer-track";

const frame = (fromX: number, toX: number): FramePointer => ({
  rest: { x: fromX, y: 300 },
  pressesOnly: false,
  touch: false,
  moves: [
    {
      rowId: "click",
      label: "click",
      startMs: 1_000,
      endMs: 1_400,
      press: true,
      position: (fraction) => ({ x: fromX + (toX - fromX) * fraction, y: 300 }),
    },
  ],
});

describe("pointerPose", () => {
  it("stands upright at rest and leans into its travel while it moves, within a cap", () => {
    const right = frame(100, 900);
    expect(pointerPose(right, 500).leanDeg).toBe(0);
    expect(pointerPose(right, 500).moving).toBe(false);
    const moving = pointerPose(right, 1_200);
    expect(moving.moving).toBe(true);
    expect(moving.leanDeg).toBeGreaterThan(0);
    expect(moving.leanDeg).toBeLessThanOrEqual(10);
    expect(pointerPose(frame(900, 100), 1_200).leanDeg).toBeLessThan(0);
  });

  it("dips as the press lands and springs back, with a ring that grows and fades", () => {
    const pose = (ms: number) => pointerPose(frame(100, 900), ms);
    expect(pose(1_460).squish).toBeCloseTo(0.88, 2);
    expect(pose(1_560).squish).toBeGreaterThan(pose(1_460).squish);
    expect(pose(1_700).squish).toBe(1);
    expect(pose(1_400).ring.opacity).toBeGreaterThan(pose(1_700).ring.opacity);
    expect(pose(1_400).ring.scale).toBeLessThan(pose(1_700).ring.scale);
    expect(pose(2_100)).toMatchObject({ ring: { opacity: 0 }, squish: 1 });
  });

  it("leans across its heading on a vertical move too", () => {
    const down: FramePointer = {
      rest: { x: 300, y: 100 },
      pressesOnly: false,
      touch: false,
      moves: [
        {
          rowId: "move",
          label: "move",
          startMs: 0,
          endMs: 400,
          press: false,
          position: (fraction) => ({ x: 300, y: 100 + 600 * fraction }),
        },
      ],
    };
    expect(Math.abs(pointerPose(down, 200).leanDeg)).toBeGreaterThan(3);
  });

  it("keeps the arrow upright and the ring still under reduced motion", () => {
    const pose = pointerPose(frame(100, 900), 1_200, true);
    expect(pose.leanDeg).toBe(0);
    expect(pointerPose(frame(100, 900), 1_450, true).ring.scale).toBe(1);
  });
});

describe("pointerPose on a touch screen", () => {
  const tap: FramePointer = {
    rest: null,
    pressesOnly: false,
    touch: true,
    moves: [
      {
        rowId: "tap",
        label: "tap",
        startMs: 1_000,
        endMs: 1_000,
        press: true,
        position: () => ({ x: 400, y: 300 }),
      },
    ],
  };

  it("grows in as the fingertip lands, holds, and fades as it lifts, without leaning", () => {
    const landing = pointerPose(tap, 1_000);
    const down = pointerPose(tap, 1_120);
    const lifting = pointerPose(tap, 1_300);
    expect(landing.squish).toBeLessThan(down.squish);
    expect([down.squish, down.fade, down.leanDeg]).toEqual([1, 1, 0]);
    expect(lifting.fade).toBeGreaterThan(0);
    expect(lifting.fade).toBeLessThan(1);
    expect(pointerPose(tap, 1_449).fade).toBeLessThan(0.01);
  });

  it("shows the fingertip whole until it goes under reduced motion", () => {
    expect(pointerPose(tap, 1_300, true)).toMatchObject({ squish: 1, fade: 1 });
  });
});
