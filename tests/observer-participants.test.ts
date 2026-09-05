// The viewing room reports participants, not lanes (docs/principles/three-roles.md).
//
// "2 of 3 lanes passed" is a fact about the harness. "2/3 reached the goal, 1 gave up" is the study
// result, and it is what the person watching through the glass came for. The denominator travels
// with it, because a stakeholder forms conclusions from vivid moments and a viewing room that shows
// a number without its count is a machine for manufacturing certainty from n=1.
import { describe, expect, it } from "vitest";

import liveBundle from "./golden/labs/live.json" with { type: "json" };
import { buildObserverData } from "../src/observer-data.js";
import { tallyParticipantOutcomes } from "../src/run.js";
import type { RunBundle } from "../src/run.js";

/** The smallest bundle buildObserverData will accept, with a review we control. */
function bundleWith(review: Partial<RunBundle["review"]>): RunBundle {
  return {
    schema: "humanish.run-bundle.v1",
    runId: "cua-test",
    mode: "live",
    simCount: 1,
    createdAt: "2026-08-09T00:00:00.000Z",
    cwd: ".",
    artifactRoot: ".humanish/runs/cua-test",
    source: { packageName: "humanish", humanishSource: "present", git: null },
    persona: { id: "p", name: "P", source: "test", sourceDigest: "d" },
    scenario: { id: "s", title: "T", source: "test", sourceDigest: "d" },
    lifecycle: [],
    simulations: [],
    streams: [],
    events: [],
    artifacts: [],
    redaction: { status: "passed", screenshots: "raw" },
    feedbackCandidates: [],
    review: {
      schema: "humanish.review.v1",
      verdict: "fail",
      summary: "s",
      gaps: [],
      ...review
    }
  } as unknown as RunBundle;
}

describe("observer data: participants", () => {
  it.each(["passed", "complete"] as const)("shows a declared blocker when the protocol status is %s", (status) => {
    const bundle = structuredClone(liveBundle) as unknown as RunBundle;
    const stream = bundle.streams[0]!;
    stream.status = status;
    stream.actor!.completionReason = "goal_satisfied";
    stream.actor!.declaredOutcome = "blocked";
    stream.actor!.reason = "The edit control was unavailable.";
    bundle.review.participants = tallyParticipantOutcomes(["blocked"]);
    const original = structuredClone(bundle);

    const data = buildObserverData(bundle);

    expect(data.streams[0]!.status).toBe("blocked");
    expect(data.streams[0]!.statusLabel).toBe("Blocked");
    expect(data.summary.blocked).toBe(1);
    expect(data.run.participantsLine).toBe("0/1 reached the goal, 1 blocked");
    expect(data.streams[0]!.actor).toEqual(original.streams[0]!.actor);
    expect(data.streams[0]!.sim).toEqual(original.simulations[0]);
    expect(bundle).toEqual(original);
  });

  it.each(["running", "preparing", "failed", "timed_out"] as const)("preserves %s even with a blocked declaration", (status) => {
    const bundle = structuredClone(liveBundle) as unknown as RunBundle;
    bundle.streams[0]!.status = status;
    bundle.streams[0]!.actor!.completionReason = "goal_satisfied";
    bundle.streams[0]!.actor!.declaredOutcome = "blocked";
    expect(buildObserverData(bundle).streams[0]!.status).toBe(status);
  });

  it.each([undefined, "reached", "not_reached"] as const)("does not reclassify declarations of %s from prose", (declaredOutcome) => {
    const bundle = structuredClone(liveBundle) as unknown as RunBundle;
    const stream = bundle.streams[0]!;
    stream.status = "passed";
    stream.actor!.completionReason = "goal_satisfied";
    if (declaredOutcome === undefined) delete stream.actor!.declaredOutcome;
    else stream.actor!.declaredOutcome = declaredOutcome;
    stream.actor!.reason = "BLOCKED";
    expect(buildObserverData(bundle).streams[0]!.statusLabel).toBe("Passed");
  });

  it("does not override a different completion reason", () => {
    const bundle = structuredClone(liveBundle) as unknown as RunBundle;
    bundle.streams[0]!.status = "passed";
    bundle.streams[0]!.actor!.completionReason = "timed_out";
    bundle.streams[0]!.actor!.declaredOutcome = "blocked";
    expect(buildObserverData(bundle).streams[0]!.status).toBe("passed");
  });

  it("carries the tally and a rendered line a viewer cannot strip the denominator from", () => {
    const participants = tallyParticipantOutcomes(["passed", "passed", "abandoned"]);
    const data = buildObserverData(bundleWith({ participants }));

    expect(data.run.participants).toEqual(participants);
    expect(data.run.participantsLine).toBe("2/3 reached the goal, 1 gave up");
  });

  it("distinguishes a persona giving up from the harness breaking", () => {
    const gaveUp = buildObserverData(bundleWith({ participants: tallyParticipantOutcomes(["abandoned"]) }));
    const broke = buildObserverData(bundleWith({ participants: tallyParticipantOutcomes(["failed"]) }));

    expect(gaveUp.run.participantsLine).toContain("gave up");
    expect(gaveUp.run.participantsLine).not.toContain("harness");
    expect(broke.run.participantsLine).toContain("harness failure");
    expect(broke.run.participantsLine).not.toContain("gave up");
  });

  it("is honestly absent when a bundle has no participants at all", () => {
    const data = buildObserverData(bundleWith({ verdict: "contract_proof_only" }));
    expect(data.run.participants).toBeUndefined();
    expect(data.run.participantsLine).toBeUndefined();
  });

  it("keeps the gate verdict separate from the study result", () => {
    // Both live in the payload, answering different questions: `status` gates, `participants` reports.
    const data = buildObserverData(
      bundleWith({ verdict: "fail", participants: tallyParticipantOutcomes(["passed", "abandoned"]) })
    );
    expect(data.run.status).toBe("fail");
    expect(data.run.participantsLine).toBe("1/2 reached the goal, 1 gave up");
  });
});
