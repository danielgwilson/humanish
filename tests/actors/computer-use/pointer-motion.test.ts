import { describe, expect, it } from "vitest";
import { planPointerGlide } from "../../../src/actors/computer-use/pointer-motion.js";

const from = { x: 100, y: 100 };
const to = { x: 700, y: 400 };

describe("planPointerGlide", () => {
  it("starts where the pointer was and ends on the target", () => {
    const glide = planPointerGlide(from, to, "participant-1:ui_action-004");
    expect(glide.position(0)).toEqual(from);
    expect(glide.position(1)).toEqual(to);
  });

  it("plans the same glide for the same seed and a different bow for another", () => {
    const sample = (seed: string) =>
      [0.25, 0.5, 0.75].map((t) => planPointerGlide(from, to, seed).position(t));
    expect(sample("a")).toEqual(sample("a"));
    const bows = new Set(
      Array.from({ length: 12 }, (_, index) => JSON.stringify(sample(`seed-${index}`))),
    );
    expect(bows.size).toBeGreaterThan(1);
  });

  it("takes longer for a longer move, within a bounded time", () => {
    const short = planPointerGlide(from, { x: 130, y: 100 }, "s").durationMs;
    const long = planPointerGlide(from, { x: 1900, y: 1000 }, "s").durationMs;
    expect(short).toBeLessThan(long);
    expect(short).toBeGreaterThanOrEqual(150);
    expect(long).toBeLessThanOrEqual(500);
  });

  it("does not move for a target where the pointer already is", () => {
    const glide = planPointerGlide(from, from, "s");
    expect(glide.durationMs).toBe(0);
    expect(glide.position(0.5)).toEqual(from);
  });

  it("bows off the straight line by a bounded amount and slows into the target", () => {
    const glide = planPointerGlide(from, to, "bow");
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const offLine = (point: { x: number; y: number }) =>
      Math.abs((to.x - from.x) * (from.y - point.y) - (from.x - point.x) * (to.y - from.y)) /
      length;
    const middle = glide.position(0.5);
    expect(offLine(middle)).toBeGreaterThan(0);
    expect(offLine(middle)).toBeLessThanOrEqual(24);
    const step = (a: number, b: number) =>
      Math.hypot(
        glide.position(b).x - glide.position(a).x,
        glide.position(b).y - glide.position(a).y,
      );
    expect(step(0.45, 0.55)).toBeGreaterThan(step(0.9, 1));
  });

  it("clamps fractions outside the glide to its ends", () => {
    const glide = planPointerGlide(from, to, "s");
    expect(glide.position(-1)).toEqual(from);
    expect(glide.position(2)).toEqual(to);
  });
});
