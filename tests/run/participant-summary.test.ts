// The sentence a participant's simulation record carries in run.json, on each route that writes
// one: how the session ended, why it never ran, or that it is still running.
import { describe, expect, it } from "vitest";

import type { ActorTrace } from "../../src/actors/contract.js";
import { participantSummary } from "../../src/run/outcomes.js";
import liveBundle from "../golden/labs/live.json" with { type: "json" };

function trace(completionReason: ActorTrace["completionReason"]): ActorTrace {
  return {
    ...structuredClone(liveBundle.streams[0]!.actor),
    status: "abandoned",
    completionReason,
    items: [],
  } as ActorTrace;
}

const NAME = "Pat (lane-02)";
const FANOUT = { name: "the app", target: "https://notes.example.test/" };
const HOSTED = { ...FANOUT, place: "in a hosted desktop browser" };
const SHARED = { name: "the shared app" };

describe("a participant's summary sentence", () => {
  it("says how an ended session ended", () => {
    expect(participantSummary(NAME, FANOUT, { trace: trace("gave_up"), inProgress: false })).toBe(
      "Pat (lane-02) used the app and gave up.",
    );
    expect(participantSummary(NAME, SHARED, { trace: trace("timed_out"), inProgress: true })).toBe(
      "Pat (lane-02) used the shared app and ran out of time.",
    );
  });

  it("puts a comma after the place the browser ran", () => {
    expect(participantSummary(NAME, HOSTED, { trace: trace("gave_up"), inProgress: false })).toBe(
      "Pat (lane-02) used the app in a hosted desktop browser, and gave up.",
    );
  });

  it("says why the run skipped a participant", () => {
    expect(
      participantSummary(NAME, FANOUT, {
        skippedReason: "skipped after another participant failed",
        inProgress: false,
      }),
    ).toBe("Pat (lane-02) was skipped after another participant failed.");
  });

  it("quotes the error of a session that did not finish, ahead of the run being in progress", () => {
    expect(
      participantSummary(NAME, SHARED, {
        sessionError: "the desktop stopped answering.",
        inProgress: true,
      }),
    ).toBe("Pat (lane-02) did not finish a session: the desktop stopped answering.");
  });

  it("says a participant with no outcome yet is using the app, and where", () => {
    expect(participantSummary(NAME, FANOUT, { inProgress: true })).toBe(
      "Pat (lane-02) is using the app.",
    );
    expect(participantSummary(NAME, HOSTED, { inProgress: true })).toBe(
      "Pat (lane-02) is using the app in a hosted desktop browser.",
    );
    expect(participantSummary(NAME, SHARED, { inProgress: true })).toBe(
      "Pat (lane-02) is using the shared app.",
    );
  });

  it("names what a participant that never ran would have used", () => {
    expect(participantSummary(NAME, HOSTED, { inProgress: false })).toBe(
      "Pat (lane-02) would use https://notes.example.test/; no session ran.",
    );
    expect(participantSummary(NAME, SHARED, { inProgress: false })).toBe(
      "Pat (lane-02) would use the shared app; no session ran.",
    );
  });
});
