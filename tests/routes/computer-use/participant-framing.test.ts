import { describe, expect, it } from "vitest";

import {
  composeParticipantInstructions,
  DEFAULT_MISSION,
  SHARED_WORLD_MISSION,
  withInboxMission,
} from "../../../src/routes/computer-use/participant-prompt.js";
import { DEVICE_PRESETS } from "../../../src/study/device-presets.js";

// Words that tell a participant it is testing, being watched, or running inside a harness. A
// participant told that is a tester, whatever its persona says (docs/principles/actor-fidelity.md).
const TESTER_FRAMING = /\b(test(ing|er|s)?|harness|under observation|observed|lane|hitting)\b/i;

const device = { name: "desktop", preset: DEVICE_PRESETS.desktop };

describe("participant framing in harness-authored prompt text", () => {
  it("tells a participant with no mission that it is using the app", () => {
    const { instructions } = composeParticipantInstructions({ mission: DEFAULT_MISSION, device });
    expect(instructions).not.toMatch(TESTER_FRAMING);
  });

  it("tells a shared-world participant with no mission that it is one of many people using the app", () => {
    const { instructions } = composeParticipantInstructions({
      mission: SHARED_WORLD_MISSION,
      device,
    });
    expect(instructions).not.toMatch(TESTER_FRAMING);
  });

  it("labels a participant's focus in plain words", () => {
    const { instructions } = composeParticipantInstructions({
      mission: DEFAULT_MISSION,
      instruction: "the settings page",
      device,
    });
    expect(instructions).toContain("the settings page");
    expect(instructions).not.toMatch(TESTER_FRAMING);
  });

  it.each([
    ["checking captured mail", false],
    ["receiving mail the app sends", true],
  ])("gives the inbox without calling the address a test identity, %s", (_label, receiving) => {
    const spec = { instructions: "Arrange an event." } as Parameters<typeof withInboxMission>[0];
    const { instructions } = withInboxMission(
      spec,
      "http://127.0.0.1:8000",
      "pat@example.com",
      receiving,
    );
    expect(instructions).toContain("pat@example.com");
    expect(instructions).not.toMatch(TESTER_FRAMING);
  });
});
