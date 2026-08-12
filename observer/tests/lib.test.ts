import { describe, expect, it } from "vitest";

import { formatDuration, runArtifactHref } from "../lib/artifact-href";
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

describe("formatDuration", () => {
  it("renders minutes and zero-padded seconds", () => {
    expect(formatDuration(191_864)).toBe("3m 12s");
    expect(formatDuration(61_000)).toBe("1m 01s");
    expect(formatDuration(9_400)).toBe("9s");
  });
});
