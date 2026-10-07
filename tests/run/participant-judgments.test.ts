import { describe, expect, it } from "vitest";
import { judgeParticipantRecords, type ParticipantRecordFacts } from "../../src/run/judge.js";

describe("participant judgments", () => {
  it("names the terminal status and reason when a shared-world participant did not pass", () => {
    const result = judgeParticipantRecords(
      [
        {
          id: "reader",
          status: "blocked",
          completionReason: "blocked_approval",
          reason: "The next step is unavailable.",
          skipped: false,
          noEngagement: false,
          selfReportedBlocker: false,
        },
      ],
      {
        sessionLabel: "Participant",
        missingSessionMessage: "Actor did not produce a terminal session.",
      },
    );
    expect(result.participants[0]?.notPassedMessage).toBe(
      "Participant ended with blocked: The next step is unavailable.",
    );
  });
  it("keeps actor evidence and judged outcomes together with their gaps and tally", () => {
    const facts = { skipped: false, noEngagement: false, selfReportedBlocker: false };
    const result = judgeParticipantRecords([
      { ...facts, id: "reader", status: "passed", reason: "Finished", noEngagement: true },
      { ...facts, id: "writer", status: "passed", reason: "Saved", reportedFriction: true },
      { ...facts, id: "waiting", skipped: true, skippedReason: "Earlier participant failed" },
      { ...facts, id: "missing" },
    ]);
    expect(result).toMatchObject({
      participants: [
        {
          status: "passed",
          judgedStatus: "incomplete",
          reason: "Finished",
          gapLine: "reader: Finished",
        },
        { status: "passed", judgedStatus: "passed", reason: "Saved", gapLine: undefined },
        {
          status: "blocked",
          judgedStatus: "blocked",
          reason: "Earlier participant failed",
          gapLine: "waiting: Earlier participant failed",
        },
        {
          status: "contract_proof_only",
          judgedStatus: undefined,
          gapLine: "missing: did not pass",
        },
      ],
      tally: {
        total: 2,
        reachedGoal: 1,
        abandoned: 0,
        ranOut: 1,
        blocked: 0,
        harnessFailed: 0,
        reportedFriction: 1,
      },
    });
  });

  it.each<Partial<ParticipantRecordFacts>>([
    { status: "passed", reason: "Finished" },
    { sessionError: "Desktop stopped" },
    { skipped: true, skippedReason: "Skipped" },
  ])("keeps an unfinished participant running despite terminal fields: %j", (fields) => {
    const result = judgeParticipantRecords(
      [
        {
          skipped: false,
          noEngagement: false,
          selfReportedBlocker: false,
          ...fields,
          inProgress: true,
        },
      ],
      { runningReason: "Still working" },
    );
    expect(result.participants[0]).toMatchObject({
      status: "running",
      judgedStatus: undefined,
      reason: "Still working",
      gapLine: undefined,
    });
    expect(result.tally.total).toBe(0);
  });

  it("keeps missing-session and skipped explanations separate from terminal failures", () => {
    const facts = { skipped: false, noEngagement: false, selfReportedBlocker: false };
    const result = judgeParticipantRecords(
      [facts, { ...facts, skipped: true, skippedReason: "Earlier participant failed" }],
      { missingSessionMessage: "Actor did not produce a terminal session." },
    );
    expect(result.participants.map((participant) => participant.notPassedMessage)).toEqual([
      "Actor did not produce a terminal session.",
      "Earlier participant failed",
    ]);
  });
  it("names the startup failure when a skipped participant also has a session error", () => {
    const result = judgeParticipantRecords([
      {
        skipped: true,
        skippedReason: "Host did not start",
        sessionError: "A physical browser is required",
        noEngagement: false,
        selfReportedBlocker: false,
      },
    ]);
    expect(result.participants[0]?.notPassedMessage).toBe("A physical browser is required");
  });
});
