import { describe, expect, it } from "vitest";

import { formatDuration, runArtifactHref } from "../lib/artifact-href";
import type { ObserverStream } from "../lib/observer-data";
import { buildPlayerModel, parseClickCoord } from "../lib/player-model";
import { NOTABLE_COMPLETION } from "../lib/signal";

describe("runArtifactHref containment", () => {
  it("prefixes run-root-relative paths for the observer/ vantage point", () => {
    expect(runArtifactHref("screenshots/lane/turn-01.png")).toBe("../screenshots/lane/turn-01.png");
  });

  it("refuses absolute paths, traversal, schemes, and data URIs", () => {
    expect(runArtifactHref("/etc/passwd")).toBeNull();
    expect(runArtifactHref("../secret.txt")).toBeNull();
    expect(runArtifactHref("shots/../../secret.txt")).toBeNull();
    expect(runArtifactHref("https://example.com/x.png")).toBeNull();
    expect(runArtifactHref("data:image/png;base64,AAAA")).toBeNull();
    expect(runArtifactHref("")).toBeNull();
  });
});

describe("notable completions", () => {
  it("covers every non-clean ActorCompletionReason and nothing clean", () => {
    expect(Object.keys(NOTABLE_COMPLETION).sort()).toEqual([
      "actor_error",
      "blocked_approval",
      "budget_reached",
      "gave_up",
      "harness_error",
      "step_failed",
      "timed_out"
    ]);
    expect(NOTABLE_COMPLETION["goal_satisfied"]).toBeUndefined();
    expect(NOTABLE_COMPLETION["turn_completed"]).toBeUndefined();
  });
});

describe("player model", () => {
  function streamWith(items: unknown[], durationMs = 20_000): ObserverStream {
    return { actor: { items, durationMs } } as unknown as ObserverStream;
  }

  it("parses recorded click coordinates from action titles, nothing else", () => {
    expect(parseClickCoord("click (700, 420)")).toEqual({ x: 700, y: 420 });
    expect(parseClickCoord("double-click (10, 20)")).toEqual({ x: 10, y: 20 });
    expect(parseClickCoord("keypress TAB")).toBeNull();
    expect(parseClickCoord("click somewhere")).toBeNull();
  });

  it("associates each row with the most recent frame, clamping pre-frame actions to 0", () => {
    const model = buildPlayerModel(
      streamWith([
        { id: "a0", kind: "ui_action", lifecycle: "completed", title: "wait" },
        { id: "s0", kind: "screenshot", lifecycle: "completed", title: "turn-00", screenshotRef: { path: "shots/t0.png", redaction: "none" } },
        { id: "a1", kind: "ui_action", lifecycle: "completed", title: "click (5, 6)" },
        { id: "s1", kind: "screenshot", lifecycle: "completed", title: "turn-01", screenshotRef: { path: "shots/t1.png", redaction: "none" } }
      ])
    );
    expect(model).not.toBeNull();
    expect(model?.frames.map((f) => f.href)).toEqual(["../shots/t0.png", "../shots/t1.png"]);
    expect(model?.rows.map((r) => r.frameIndex)).toEqual([0, 0, 0, 1]);
    expect(model?.rows[2]?.coord).toEqual({ x: 5, y: 6 });
    expect(model?.avgFrameMs).toBe(10_000);
  });

  it("returns null for a lane with no frames", () => {
    expect(buildPlayerModel(streamWith([{ id: "a", kind: "ui_action", lifecycle: "completed", title: "wait" }]))).toBeNull();
    expect(buildPlayerModel({} as unknown as ObserverStream)).toBeNull();
  });
});

describe("formatDuration", () => {
  it("renders minutes and zero-padded seconds", () => {
    expect(formatDuration(191_864)).toBe("3m 12s");
    expect(formatDuration(61_000)).toBe("1m 01s");
    expect(formatDuration(9_400)).toBe("9s");
  });
});
