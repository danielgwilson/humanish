import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_TYPING } from "../../../src/routes/computer-use/participant-prompt.js";
import { buildParticipantSpecs } from "../../../src/routes/shared-world/participant-specs.js";
import { planSharedWorldStudy } from "../../../src/routes/shared-world/plan.js";
import { concurrentSandboxes, sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";
import { concurrentConfig } from "../../helpers/shared-world-fakes.js";
import { writePersonaFiles } from "../../helpers/persona-files.js";

/** The personas this file's studies name, which need their files to run. */
const STUDY_PERSONAS = [
  "autonomous-creative-agent",
  "first-time-visitor",
  "persona-1",
  "persona-2",
  "persona-3",
] as const;

const mission = "Plan the week's rota together.";

describe("the shared-world route records the typing text its participants read", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-shared-typing-"));
    await writePersonaFiles(cwd, ...STUDY_PERSONAS);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** Each participant's composed prompt and the typing its assignment records. */
  async function specTyping(typing: string | false) {
    const config = concurrentConfig();
    config.actor.mission = mission;
    config.actor.typing = typing;
    const planned = planSharedWorldStudy(config, {
      dryRun: true,
      sandboxCeiling: sandboxCeiling({}),
      concurrentSandboxes: concurrentSandboxes({}),
    });
    if (!planned.ok) throw new Error(planned.refusal.message);
    const specs = await buildParticipantSpecs(planned.plan.plane.participants, cwd, (t) => t);
    return specs.map((spec) => {
      const paragraphs = spec.instructions.split("\n\n");
      return {
        recorded: spec.evidenceAssignment?.typing,
        afterMission: paragraphs[paragraphs.indexOf(mission) + 1],
        sentDefault: paragraphs.includes(DEFAULT_TYPING),
      };
    });
  }

  it("records false and sends no paragraph when the study sets false", async () => {
    const participants = await specTyping(false);
    expect(participants).toHaveLength(3);
    for (const participant of participants) {
      expect(participant.recorded).toBe(false);
      expect(participant.sentDefault).toBe(false);
      expect(participant.afterMission).not.toBe(DEFAULT_TYPING);
    }
  });

  it("records and sends the study's own text", async () => {
    const own = "Write as a shift lead writes on a group chat.";
    for (const participant of await specTyping(own)) {
      expect(participant.recorded).toBe(own);
      expect(participant.afterMission).toBe(own);
    }
  });
});
