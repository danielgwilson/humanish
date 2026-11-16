import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  CLOSING_LINE_DIRECTIVE,
  composeParticipantInstructions,
  DEFAULT_TYPING,
} from "../../../src/routes/computer-use/participant-prompt.js";
import { DEVICE_PRESETS } from "../../../src/study/device-presets.js";
import { participantRunsAndPlan } from "../../../src/routes/computer-use/participant-runs.js";
import { planComputerUseStudy } from "../../../src/routes/computer-use/plan.js";
import { parseStudy } from "../../../src/study/config.js";
import { concurrentSandboxes, sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";

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
  it("is the fixed text that names only a chat and a search box", () => {
    expect(DEFAULT_TYPING).toBe(
      "When you type into a chat or a search box in the app, type as this person would at their own keyboard when nobody is grading them. People type little there: a few plain words, often without a greeting or a thank-you, one thing at a time, and only as much of a search as it takes for the result to show up. Anything else you write in the app (a task, a note, a post, an answer on a form) is as long as this person would really make it.",
    );
  });

  it("sits between the mission and the closing line in a study with no tasks or focus", () => {
    const paragraphs = composeParticipantInstructions({ mission, device }).instructions.split(
      "\n\n",
    );
    const at = paragraphs.indexOf(mission);
    expect(paragraphs.slice(at, at + 3)).toEqual([mission, DEFAULT_TYPING, CLOSING_LINE_DIRECTIVE]);
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

describe("the typing text the composer reports it sent", () => {
  it.each([
    ["the built-in paragraph when the study sets none", undefined, undefined, DEFAULT_TYPING],
    ["false when the study sets false", false, undefined, false],
    ["the study's own text", "Type in full sentences.", undefined, "Type in full sentences."],
    ["false on a terminal surface when the study sets none", undefined, "desktop-cli", false],
    [
      "the study's own text on a terminal surface",
      "Type in full sentences.",
      "desktop-cli",
      "Type in full sentences.",
    ],
  ] as const)("is %s", (_label, typing, surface, sent) => {
    const composed = composeParticipantInstructions({
      mission,
      device,
      ...(typing === undefined ? {} : { typing }),
      ...(surface === undefined ? {} : { surface }),
    });
    expect(composed.typing).toBe(sent);
    const paragraphs = composed.instructions.split("\n\n");
    const afterMission = paragraphs[paragraphs.indexOf(mission) + 1];
    if (sent === false) expect(paragraphs).not.toContain(DEFAULT_TYPING);
    else expect(afterMission).toBe(sent);
  });
});

const routeFixtures = JSON.parse(
  await readFile(new URL("../../fixtures/task-route-preflight/labs.json", import.meta.url), "utf8"),
) as Array<{ name: string; config: Record<string, unknown> }>;

/** Each computer-use participant's composed prompt and the typing its assignment records. */
function plannedTyping(fixture: string, typing?: string | false) {
  const raw = structuredClone(routeFixtures.find(({ name }) => name === fixture)!.config);
  const actor = raw.actor as Record<string, unknown>;
  actor.mission = mission;
  if (typing !== undefined) actor.typing = typing;
  const parsed = parseStudy(raw);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const planned = planComputerUseStudy(parsed.config, {
    dryRun: true,
    sandboxCeiling: sandboxCeiling({}),
    concurrentSandboxes: concurrentSandboxes({}),
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return participantRunsAndPlan(planned.plan).runs.map((run) => {
    const paragraphs = run.instructions.split("\n\n");
    return {
      recorded: run.evidenceAssignment?.typing,
      afterMission: paragraphs[paragraphs.indexOf(mission) + 1],
      sentDefault: paragraphs.includes(DEFAULT_TYPING),
    };
  });
}

describe("the computer-use route records the typing text its participants read", () => {
  const own = "Write the way a court clerk writes a filing.";

  it("records false and sends no paragraph when the study sets false", () => {
    for (const participant of plannedTyping("cua-openai-computer-use-app-url", false)) {
      expect(participant.recorded).toBe(false);
      expect(participant.sentDefault).toBe(false);
      expect(participant.afterMission).not.toBe(DEFAULT_TYPING);
    }
  });

  it("records and sends the study's own text", () => {
    for (const participant of plannedTyping("cua-openai-computer-use-app-url", own)) {
      expect(participant.recorded).toBe(own);
      expect(participant.afterMission).toBe(own);
    }
  });

  it("sends no paragraph to a participant at a terminal when the study sets none", () => {
    for (const participant of plannedTyping("cua-openai-computer-use-desktop-cli")) {
      expect(participant.recorded).toBe(false);
      expect(participant.sentDefault).toBe(false);
    }
  });

  it("sends the study's own text to a participant at a terminal", () => {
    for (const participant of plannedTyping("cua-openai-computer-use-desktop-cli", own)) {
      expect(participant.recorded).toBe(own);
      expect(participant.afterMission).toBe(own);
    }
  });
});
