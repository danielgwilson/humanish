import { describe, expect, it } from "vitest";

import { addressedRecipients, recipientParticipantId } from "../../src/lab/parse/comms.js";

describe("comms recipients by participant", () => {
  const recipients = [
    { lane: "signup-01", address: "signup-01@example.test" },
    { lane: "browse-01" },
    { lane: "signup-02", address: "signup-02@example.test" },
  ];

  it("keeps only addressed recipients, in declaration order, by participant id", () => {
    expect(addressedRecipients({ recipients })).toEqual([
      { participantId: "signup-01", address: "signup-01@example.test" },
      { participantId: "signup-02", address: "signup-02@example.test" },
    ]);
    expect(addressedRecipients({})).toEqual([]);
  });

  it("names the participant a recipient belongs to, addressed or not", () => {
    expect(recipients.map(recipientParticipantId)).toEqual(["signup-01", "browse-01", "signup-02"]);
  });
});
