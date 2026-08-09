// The viewing room reports participants, not lanes (docs/principles/three-roles.md).
//
// "2 of 3 lanes passed" is a fact about the harness. "2/3 reached the goal, 1 gave up" is the study
// result, and it is what the person watching through the glass came for. The denominator travels
// with it, because a stakeholder forms conclusions from vivid moments and a viewing room that shows
// a number without its count is a machine for manufacturing certainty from n=1.
import { describe, expect, it } from "vitest";

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
