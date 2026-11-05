// execution.pointer decides how a computer-use participant's pointer reaches each target. It is
// parsed with the study and carried to every participant's plan, where the loop reads it.

import { describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { computerUseParticipants } from "../../src/study/plan-participants.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";

const study = (execution: Record<string, unknown>) => ({
  schema: STUDY_SCHEMA,
  id: "pointer-option",
  route: "computer-use",
  mode: "live",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
  actor: { type: "openai-computer-use" },
  participants: [{ id: "first" }, { id: "second" }],
  execution: { target: "e2b-desktop", ...execution },
  review: { analysis: false },
});

describe("execution.pointer", () => {
  it("carries glide to every participant's plan and leaves it out when absent", () => {
    const glide = parseStudy(study({ pointer: "glide" }));
    const absent = parseStudy(study({}));
    if (!glide.ok || !absent.ok) throw new Error("the study did not parse");
    expect(glide.config.execution?.pointer).toBe("glide");
    expect(computerUseParticipants(glide.config).map((entry) => entry.limits.pointer)).toEqual([
      "glide",
      "glide",
    ]);
    expect(computerUseParticipants(absent.config)[0]?.limits.pointer).toBeUndefined();
  });

  it("jumps a phone participant's pointer unless the study asks for a glide", () => {
    const phones = (execution: Record<string, unknown>) => {
      const parsed = parseStudy(study({ ...execution, desktop: { device: "mobile" } }));
      if (!parsed.ok) throw new Error(parsed.error.message);
      return computerUseParticipants(parsed.config).map((entry) => entry.limits.pointer);
    };
    expect(phones({})).toEqual(["jump", "jump"]);
    expect(phones({ pointer: "glide" })).toEqual(["glide", "glide"]);
  });

  it("refuses a value other than glide or jump, naming both", () => {
    const parsed = parseStudy(study({ pointer: "smooth" }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toMatch(/execution\.pointer.*glide.*jump/);
  });
});
