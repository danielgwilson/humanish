import { describe, expect, it } from "vitest";

import {
  composeParticipantInstructions,
  DEFAULT_TYPING,
} from "../../../src/routes/computer-use/participant-prompt.js";
import { DEVICE_PRESETS } from "../../../src/study/device-presets.js";

const device = { name: "desktop", preset: DEVICE_PRESETS.desktop };
const mission = "Plan a weekend trip for two.";
const tasks = [{ id: "pick", goal: "Pick a date." }];

/** The composed prompt's paragraphs, so a test can name what follows the mission. */
function paragraphsAfterMission(typing?: string | false): string[] {
  const { instructions } = composeParticipantInstructions({
    mission,
    tasks,
    device,
    ...(typing === undefined ? {} : { typing }),
  });
  const paragraphs = instructions.split("\n\n");
  return paragraphs.slice(paragraphs.indexOf(mission) + 1);
}

describe("the typing paragraph a participant reads", () => {
  it("is the fixed text the study brief gives", () => {
    expect(DEFAULT_TYPING).toBe(
      "When you type (a message, a search, a form answer), type as this person would at their own keyboard when nobody is grading them. People type little: a few plain words, often without a greeting or a thank-you, one thing at a time, and only as much of a search as it takes for the result to show up.",
    );
  });

  it("follows the mission and comes before the tasks when the study sets none", () => {
    const [afterMission, next] = paragraphsAfterMission();
    expect(afterMission).toBe(DEFAULT_TYPING);
    expect(next?.split("\n")[1]).toBe("1. Pick a date.");
  });

  it("is left out when the study sets typing to false", () => {
    const [afterMission] = paragraphsAfterMission(false);
    expect(afterMission?.split("\n")[1]).toBe("1. Pick a date.");
  });

  it("is replaced by the study's own text in the same place", () => {
    const own = "Write the way a court clerk writes a filing.";
    const [afterMission, next] = paragraphsAfterMission(own);
    expect(afterMission).toBe(own);
    expect(next?.split("\n")[1]).toBe("1. Pick a date.");
  });

  it("changes the prompt digest when it changes", () => {
    const digest = (typing?: string | false) =>
      composeParticipantInstructions({
        mission,
        device,
        ...(typing === undefined ? {} : { typing }),
      }).persona.promptDigest;
    expect(new Set([digest(), digest(false), digest("Type in full sentences.")]).size).toBe(3);
  });
});
