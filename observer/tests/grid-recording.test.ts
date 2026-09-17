import { describe, expect, it } from "vitest";
import live from "../../tests/golden/observer-data/live.json";
import { buildGridRecording, clampGridTime, gridMoment } from "../lib/grid-recording";
import type { ObserverData, ObserverStream } from "../lib/observer-data";

const data = live as unknown as ObserverData;
const origin = Date.parse("2026-09-01T10:00:00.000Z");
type Item = NonNullable<ObserverStream["actor"]>["items"][number];

function capture(id: string, offset: number | string | null): Item {
  return {
    id, kind: "screenshot", lifecycle: "completed", title: id,
    screenshotRef: { path: `screenshots/${id}.png`, redaction: "none" },
    ...(offset === null ? {} : { at: typeof offset === "number" ? new Date(origin + offset).toISOString() : offset })
  };
}

function lane(id: string, items: Item[]): ObserverStream {
  const stream = structuredClone(data.streams[0]!);
  stream.id = id;
  stream.actor!.items = items;
  // Neither metadata timestamp nor duration defines visual coverage.
  stream.sim.startedAt = "2020-01-01T00:00:00.000Z";
  stream.updatedAt = "2030-01-01T00:00:00.000Z";
  stream.actor!.durationMs = 999_000;
  return stream;
}

describe("Whole-grid recorded capture clock", () => {
  it("preserves staggered coverage and selects no future capture", () => {
    const early = lane("early", [capture("early-1", 0), capture("early-2", 2000)]);
    const late = lane("late", [capture("late-1", 1000), capture("late-2", 5000)]);
    const recording = buildGridRecording([early, late]);
    expect(recording.startMs).toBe(origin);
    expect(recording.endMs).toBe(origin + 5000);
    expect(recording.boundariesMs).toEqual([0, 1000, 2000, 5000].map((time) => origin + time));
    expect(gridMoment(recording, "late", origin + 999)).toEqual({ kind: "before-first" });
    expect(gridMoment(recording, "early", origin + 1999)).toMatchObject({
      kind: "capture", frame: { index: 0, itemId: "early-1" }, ageMs: 1999, coverage: "within"
    });
    expect(gridMoment(recording, "early", origin + 2000)).toMatchObject({
      kind: "capture", frame: { index: 1, itemId: "early-2" }, ageMs: 0, coverage: "within"
    });
    expect(gridMoment(recording, "early", origin + 5000)).toMatchObject({
      kind: "capture", frame: { index: 1, itemId: "early-2" }, ageMs: 3000, coverage: "after-last"
    });
  });

  it("deduplicates seek boundaries while keeping original duplicate-frame identity", () => {
    const stream = lane("duplicate", [capture("first", 0), capture("second", 1000), capture("third", 1000)]);
    const recording = buildGridRecording([stream, lane("other", [capture("other-first", 1000)])]);
    expect(recording.boundariesMs).toEqual([origin, origin + 1000]);
    const moment = gridMoment(recording, stream.id, origin + 1000);
    expect(moment).toMatchObject({ kind: "capture", frame: { index: 2, itemId: "third" }, ageMs: 0 });
    if (moment.kind !== "capture") throw new Error("Expected the original captured frame");
    expect(moment.frame).toBe(recording.lanes.get(stream.id)?.model?.frames[2]);
  });

  it.each([
    ["missing", [capture("first", 0), capture("missing", null)]],
    ["invalid", [capture("first", 0), capture("invalid", "not-a-timestamp")]],
    ["descending", [capture("first", 2000), capture("earlier", 1000)]]
  ] as const)("keeps %s timestamp lanes unavailable without manufacturing shared coverage", (_name, items) => {
    const stream = lane("unavailable", [...items]);
    const recording = buildGridRecording([stream, lane("valid", [capture("valid", 10_000)])]);
    expect(recording.lanes.get(stream.id)?.timing).toBe("unavailable");
    expect(recording.lanes.get(stream.id)?.times).toBeNull();
    expect(recording.lanes.get(stream.id)?.model?.frames.map((frame) => frame.itemId)).toEqual(items.map((item) => item.id));
    expect(recording.boundariesMs).toEqual([origin + 10_000]);
    expect(gridMoment(recording, stream.id, origin + 10_000)).toEqual({ kind: "timing-unavailable" });
  });

  it("uses a single real timestamp even though one capture cannot establish recorded pacing", () => {
    const recording = buildGridRecording([lane("single", [capture("only", 1234)])]);
    expect(recording.lanes.get("single")?.model?.paced).toBe("avg");
    expect(recording.lanes.get("single")?.timing).toBe("recorded");
    expect(recording.startMs).toBe(origin + 1234);
    expect(recording.endMs).toBe(origin + 1234);
    expect(clampGridTime(recording, origin)).toBe(origin + 1234);
    expect(gridMoment(recording, "single", origin + 1233)).toEqual({ kind: "before-first" });
    expect(gridMoment(recording, "single", origin + 1234)).toMatchObject({ kind: "capture", ageMs: 0, coverage: "within" });
    expect(gridMoment(recording, "single", origin + 1235)).toMatchObject({ kind: "capture", ageMs: 1, coverage: "after-last" });
  });

  it("does not borrow terminal tails, status timestamps or final contextual screenshots", () => {
    const terminal = lane("terminal", [{ id: "command", kind: "command", lifecycle: "completed", title: "check", at: new Date(origin).toISOString() }]);
    terminal.kind = "terminal";
    terminal.terminalPlain = "Final output, retained without a screen capture.";
    const notice = lane("notice", [{ ...capture("context-only", 9000), kind: "notice" }]);
    const visual = lane("visual", [capture("original", 1000), { ...capture("context-after", 9000), kind: "notice" }]);
    const recording = buildGridRecording([terminal, notice, visual]);
    expect(recording.boundariesMs).toEqual([origin + 1000]);
    for (const id of ["terminal", "notice", "unknown"]) expect(gridMoment(recording, id, origin + 10_000)).toEqual({ kind: "no-captures" });
    expect(gridMoment(recording, "visual", origin)).toEqual({ kind: "before-first" });
    expect(gridMoment(recording, "visual", origin + 10_000)).toMatchObject({
      kind: "capture", frame: { itemId: "original", href: "../screenshots/original.png", index: 0 }, ageMs: 9000
    });
  });

  it("keeps scripted action captures and mid-run captures on their original frame IDs", () => {
    const scripted = lane("scripted", [{ ...capture("action", 1000), kind: "ui_action" }]);
    const active = lane("active", []);
    active.liveActor = { schema: "humanish.live-actor.v1", updatedAt: active.updatedAt, items: [capture("live-capture", 2000)] };
    delete active.actor;
    const recording = buildGridRecording([scripted, active]);
    expect(gridMoment(recording, scripted.id, origin + 1000)).toMatchObject({ kind: "capture", frame: { index: 0, itemId: "action" } });
    expect(gridMoment(recording, active.id, origin + 2000)).toMatchObject({ kind: "capture", frame: { index: 0, itemId: "live-capture" } });
  });

  it("leaves empty and wholly untimed recordings without a fabricated range", () => {
    for (const streams of [[], [lane("empty", [])], [lane("untimed", [capture("old", null)])]]) {
      const recording = buildGridRecording(streams);
      expect(recording.startMs).toBeNull();
      expect(recording.endMs).toBeNull();
      expect(recording.boundariesMs).toEqual([]);
      expect(clampGridTime(recording, origin)).toBeNull();
    }
  });

  it("clamps finite requests and rejects invalid cursors without exposing a future frame", () => {
    const recording = buildGridRecording([lane("recorded", [capture("first", 1000), capture("last", 3000)])]);
    expect(clampGridTime(recording, origin)).toBe(origin + 1000);
    expect(clampGridTime(recording, origin + 2000)).toBe(origin + 2000);
    expect(clampGridTime(recording, origin + 4000)).toBe(origin + 3000);
    for (const cursor of [NaN, Infinity, -Infinity]) {
      expect(clampGridTime(recording, cursor)).toBeNull();
      expect(gridMoment(recording, "recorded", cursor)).toEqual({ kind: "timing-unavailable" });
    }
  });
});
