// The study result carries its denominator (docs/principles/three-roles.md).
//
// `review.verdict` answers a gate-shaped question and has to collapse a run to one word. That is
// the wrong shape for the research question: a run where two of three participants finished is not
// usefully "fail", and a run where the harness broke is a different thing from one where a persona
// gave up. A stakeholder watching through the glass forms conclusions from vivid moments, so every
// number shown to one travels with its count — otherwise it is a machine for manufacturing
// certainty from n=1.
import { describe, expect, it } from "vitest";

import type { ActorStatus } from "../src/actor-contract.js";
import { formatParticipantOutcomes, tallyParticipantOutcomes } from "../src/run.js";

describe("tallyParticipantOutcomes", () => {
  it("separates what happened to people from what happened to the harness", () => {
    const tally = tallyParticipantOutcomes([
      "passed",
      "passed",
      "abandoned",
      "incomplete",
      "blocked",
      "failed"
    ]);
    expect(tally).toEqual({
      total: 6,
      reachedGoal: 2,
      abandoned: 1,
      ranOut: 1,
      blocked: 1,
      // The only member that says the instrument, rather than the product, is what went wrong.
      harnessFailed: 1
    });
  });

  it("counts a timeout as running out, because that is what happened to the participant", () => {
    const tally = tallyParticipantOutcomes(["timed_out", "incomplete"]);
    expect(tally.ranOut).toBe(2);
    expect(tally.harnessFailed).toBe(0);
  });

  it("never lets the parts exceed the whole", () => {
    const statuses = ["passed", "abandoned", "incomplete", "blocked", "failed"] as ActorStatus[];
    const tally = tallyParticipantOutcomes(statuses);
    const parts = tally.reachedGoal + tally.abandoned + tally.ranOut + tally.blocked + tally.harnessFailed;
    expect(parts).toBeLessThanOrEqual(tally.total);
    expect(tally.total).toBe(statuses.length);
  });

  it("handles a study nobody finished", () => {
    expect(tallyParticipantOutcomes([])).toEqual({
      total: 0,
      reachedGoal: 0,
      abandoned: 0,
      ranOut: 0,
      blocked: 0,
      harnessFailed: 0
    });
  });
});

describe("formatParticipantOutcomes", () => {
  it("always leads with the denominator", () => {
    expect(formatParticipantOutcomes(tallyParticipantOutcomes(["passed", "passed", "abandoned"]))).toContain(
      "2/3 reached the goal"
    );
  });

  it("names what happened to everyone who did not finish", () => {
    const line = formatParticipantOutcomes(
      tallyParticipantOutcomes(["passed", "abandoned", "incomplete", "blocked", "failed"])
    );
    expect(line).toContain("1/5 reached the goal");
    expect(line).toContain("1 gave up");
    expect(line).toContain("1 ran out of session");
    expect(line).toContain("1 blocked on an approval");
    expect(line).toContain("1 lost to a harness failure");
  });

  it("stays quiet about outcomes that did not happen", () => {
    const line = formatParticipantOutcomes(tallyParticipantOutcomes(["passed", "passed"]));
    expect(line).toBe("2/2 reached the goal");
    expect(line).not.toContain("gave up");
    expect(line).not.toContain("harness");
  });

  it("says so plainly when there is nothing to report", () => {
    expect(formatParticipantOutcomes(tallyParticipantOutcomes([]))).toContain("no participants");
  });
});
