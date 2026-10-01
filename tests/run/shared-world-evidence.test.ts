import { describe, expect, it } from "vitest";
import { participantIds } from "../../src/run/participant-records.js";
import { sharedWorldParticipantKeys } from "../../src/run/shared-world-evidence.js";

describe("sharedWorldParticipantKeys", () => {
  it("saves the participant id as roleId, then its labels, then its record and stream ids", () => {
    const keys = sharedWorldParticipantKeys(participantIds(1), "reviewer", {
      actorType: "initiator",
      surface: "web",
      caseGroup: "a",
    });
    expect(Object.keys(keys)).toEqual([
      "roleId",
      "actorType",
      "surface",
      "caseGroup",
      "simId",
      "streamId",
    ]);
    expect(keys).toEqual({
      roleId: "reviewer",
      actorType: "initiator",
      surface: "web",
      caseGroup: "a",
      simId: "sim-002",
      streamId: "stream-002",
    });
  });

  it("omits each label the participant does not declare", () => {
    const keys = sharedWorldParticipantKeys(participantIds(0), "host", { surface: "web" });
    expect(Object.keys(keys)).toEqual(["roleId", "surface", "simId", "streamId"]);
  });
});
