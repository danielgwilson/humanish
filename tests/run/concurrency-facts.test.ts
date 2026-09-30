import { describe, expect, it } from "vitest";

import { concurrencyFacts } from "../../src/run/shared-world-evidence.js";

// concurrencyFacts is what verify's shared-world pass gate and the judge both read.
const windows = (...spans: Array<[number, number]>) =>
  spans.map(([startedAt, endedAt]) => ({ startedAt, endedAt }));
const series = (...points: Array<[number, string]>) =>
  points.map(([timestamp, digest]) => ({ timestamp, digest }));

describe("concurrencyFacts", () => {
  it("finds overlap only when two windows share time", () => {
    expect(concurrencyFacts(windows([0, 10], [5, 15]), undefined)).toEqual({ overlap: true });
    // Touching windows do not overlap, and a missing participant's [0, 0] window never does.
    expect(concurrencyFacts(windows([0, 10], [10, 20], [0, 0]), undefined)).toEqual({
      overlap: false,
    });
  });

  it("on the provisioned plane, needs a state change at or after the first overlap", () => {
    // Overlap starts at 5; the digest changes at 6.
    expect(concurrencyFacts(windows([0, 10], [5, 15]), series([0, "a"], [6, "b"]))).toEqual({
      overlap: true,
      stateChangedUnderOverlap: true,
    });
    // The only change is at 4, before the overlap.
    expect(
      concurrencyFacts(windows([0, 10], [5, 15]), series([0, "a"], [4, "b"], [9, "b"])),
    ).toEqual({ overlap: true, stateChangedUnderOverlap: false });
    // A change exactly at the overlap start counts; order in the series does not matter.
    expect(concurrencyFacts(windows([5, 15], [0, 10]), series([5, "b"], [0, "a"]))).toEqual({
      overlap: true,
      stateChangedUnderOverlap: true,
    });
  });

  it("reports no state change under overlap when nothing overlapped", () => {
    expect(concurrencyFacts(windows([0, 4], [5, 9]), series([0, "a"], [6, "b"]))).toEqual({
      overlap: false,
      stateChangedUnderOverlap: false,
    });
  });
});
