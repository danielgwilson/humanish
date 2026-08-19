import { describe, expect, it } from "vitest";

import type { RunIndexEntry } from "../src/run-index.js";
import {
  expectationFor,
  expectationLine,
  formatDuration,
  groupRunsByLab,
  listWindow,
  livenessLabel,
  normalizeThought
} from "../src/run-projection.js";

const run = (over: Partial<RunIndexEntry> & { runId: string }): RunIndexEntry => ({
  derivedFrom: "status",
  liveness: "finished",
  ...over
});

describe("grouping runs by lab", () => {
  it("puts labs someone is working in first, then most recently used", () => {
    const { labs } = groupRunsByLab([
      run({ runId: "a1", lab: { id: "alpha" }, completedAt: "2026-08-19T10:00:00.000Z" }),
      run({ runId: "b1", lab: { id: "beta" }, liveness: "running", updatedAt: "2026-08-19T09:00:00.000Z" }),
      run({ runId: "a2", lab: { id: "alpha" }, completedAt: "2026-08-18T10:00:00.000Z" })
    ]);
    expect(labs.map((lab) => lab.labId)).toEqual(["beta", "alpha"]);
    expect(labs[0]?.live).toBe(1);
    expect(labs[0]?.liveRuns).toHaveLength(1);
    expect(labs[1]?.runs).toBe(2);
    expect(labs[1]?.latest?.runId).toBe("a1");
  });

  it("keeps unattributed runs separate rather than inventing a lab for them", () => {
    const { labs, unattributed } = groupRunsByLab([
      run({ runId: "x" }),
      run({ runId: "y", lab: { id: "alpha" } })
    ]);
    expect(labs.map((lab) => lab.labId)).toEqual(["alpha"]);
    expect(unattributed.map((entry) => entry.runId)).toEqual(["x"]);
  });
});

describe("what a lab may claim about itself", () => {
  it("reports median and range WITH the denominator, from finished runs only", () => {
    const expectation = expectationFor([
      run({ runId: "1", durationMs: 60_000, estimatedCostUsd: 1 }),
      run({ runId: "2", durationMs: 120_000, estimatedCostUsd: 2 }),
      run({ runId: "3", durationMs: 240_000, estimatedCostUsd: 3 }),
      // An interrupted run's duration is the length of an accident, not of a study.
      run({ runId: "4", liveness: "interrupted", durationMs: 5_000, estimatedCostUsd: 9 }),
      run({ runId: "5", liveness: "running", durationMs: 1_000 })
    ]);
    expect(expectation.sample).toBe(3);
    expect(expectation.medianDurationMs).toBe(120_000);
    expect(expectation.durationRangeMs).toEqual({ min: 60_000, max: 240_000 });
    expect(expectation.medianCostUsd).toBe(2);
    expect(expectationLine(expectation)).toBe("1m–4m · ~$2.00 median · 3 runs");
  });

  it("a declared-absent cost is excluded from the median AND counted, so the sample stays honest", () => {
    const expectation = expectationFor([
      run({ runId: "1", durationMs: 60_000, estimatedCostUsd: 1 }),
      run({ runId: "2", durationMs: 60_000, estimatedCostUsd: null })
    ]);
    expect(expectation.medianCostUsd).toBe(1);
    expect(expectation.costUnknown).toBe(1);
    expect(expectationLine(expectation)).toContain("2 runs, 1 unpriced");
  });

  it("no history says so — it never borrows numbers or invents a range", () => {
    const expectation = expectationFor([run({ runId: "1", liveness: "running" })]);
    expect(expectation.sample).toBe(0);
    expect(expectation.medianDurationMs).toBeUndefined();
    expect(expectationLine(expectation)).toBe("no runs yet");
  });

  it("a single run says one run, not a fake range", () => {
    const line = expectationLine(expectationFor([run({ runId: "1", durationMs: 90_000, estimatedCostUsd: 0.5 })]));
    expect(line).toBe("1m 30s · ~$0.50 median · 1 run");
  });

  it("runs that finished but were never timed say so instead of showing a blank", () => {
    const line = expectationLine(expectationFor([run({ runId: "1" }), run({ runId: "2" })]));
    expect(line).toBe("2 runs, nothing timed");
  });
});

describe("normalizing a participant's recorded thinking", () => {
  const thought =
    "**Figuring out table creation**\n\nI've created a table but I'm considering if I should rename it and create additional columns.";

  it("drops markdown syntax and hard newlines, keeps the words, wraps to the budget", () => {
    const { lines, truncated } = normalizeThought(thought, { width: 40, maxLines: 3 });
    expect(lines.every((line) => line.length <= 40)).toBe(true);
    expect(lines[0]).toContain("Figuring out table creation");
    expect(lines.join(" ")).not.toContain("**");
    expect(lines.join(" ")).not.toContain("\n");
    // This thought happens to fit the budget exactly, so nothing was cut — and the flag says so
    // rather than defaulting to "probably truncated".
    expect(truncated).toBe(false);
    // Every word survives: wrapping is the only transformation, never summarizing.
    expect(lines.join(" ").replace(/\s+/g, " ")).toBe(
      "Figuring out table creation I've created a table but I'm considering if I should rename it and create additional columns."
    );
  });

  it("reports truncation with an ellipsis instead of cutting silently", () => {
    const { lines, truncated } = normalizeThought(thought, { width: 30, maxLines: 1 });
    expect(lines).toHaveLength(1);
    expect(truncated).toBe(true);
    expect(lines[0]?.endsWith("…")).toBe(true);
  });

  it("does not claim truncation when the whole thought fits", () => {
    const { lines, truncated } = normalizeThought("Short thought.", { width: 40, maxLines: 2 });
    expect(lines).toEqual(["Short thought."]);
    expect(truncated).toBe(false);
  });

  it("has a defined empty case — no thought is no lines, never a placeholder", () => {
    expect(normalizeThought("", { width: 40, maxLines: 2 })).toEqual({ lines: [], truncated: false });
    expect(normalizeThought("   \n  ", { width: 40, maxLines: 2 })).toEqual({ lines: [], truncated: false });
  });

  it("cuts an unbreakable token rather than letting it overflow the pane", () => {
    const { lines } = normalizeThought("https://example.test/a-very-long-path-that-never-breaks", {
      width: 20,
      maxLines: 2
    });
    expect(lines.every((line) => line.length <= 20)).toBe(true);
  });
});

describe("list windowing (Ink has no scroll container)", () => {
  it("shows everything when it fits", () => {
    expect(listWindow({ total: 4, selected: 2, viewport: 10 })).toEqual({ start: 0, end: 4 });
  });

  it("keeps the selection inside the window as it moves down and back up", () => {
    const viewport = 5;
    for (let selected = 0; selected < 20; selected += 1) {
      const { start, end } = listWindow({ total: 20, selected, viewport });
      expect(end - start).toBe(viewport);
      expect(selected).toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(end);
    }
  });

  it("clamps at both ends instead of scrolling past them", () => {
    expect(listWindow({ total: 20, selected: 0, viewport: 5 }).start).toBe(0);
    expect(listWindow({ total: 20, selected: 19, viewport: 5 })).toEqual({ start: 15, end: 20 });
  });

  it("survives nonsense inputs without producing an impossible window", () => {
    expect(listWindow({ total: 0, selected: 5, viewport: 5 })).toEqual({ start: 0, end: 0 });
    // A zero viewport still has to draw something: it clamps to one row rather than an empty
    // window that would make the list vanish.
    const degenerate = listWindow({ total: 3, selected: -2, viewport: 0 });
    expect(degenerate).toEqual({ start: 0, end: 1 });
    // And a selection past the end clamps inside the list instead of scrolling into nothing.
    const pastEnd = listWindow({ total: 3, selected: 99, viewport: 2 });
    expect(pastEnd.end).toBe(3);
    expect(pastEnd.start).toBe(1);
  });
});

describe("small shared formatters", () => {
  it("formats durations the way the surfaces read them", () => {
    expect(formatDuration(900)).toBe("1s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(109_000)).toBe("1m 49s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(5_400_000)).toBe("1h 30m");
  });

  it("labels a run by state, and a finished one by its own verdict", () => {
    expect(livenessLabel({ liveness: "running" })).toBe("running");
    expect(livenessLabel({ liveness: "interrupted" })).toBe("interrupted");
    expect(livenessLabel({ liveness: "finished", verdict: "pass" })).toBe("pass");
    expect(livenessLabel({ liveness: "finished" })).toBe("finished");
  });
});
