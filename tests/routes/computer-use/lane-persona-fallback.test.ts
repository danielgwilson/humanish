import { describe, expect, it } from "vitest";
import { LAB_CONFIG_SCHEMA } from "../../../src/lab/types.js";
import { parseLabConfig } from "../../../src/lab/config.js";
import { resolveCuaParticipantPlan } from "../../../src/routes/computer-use/participant-runs.js";

// With a `lanes` roster present, participant persona resolution once read only `lane.persona`. Every
// fan-out participant of every study that declared `actors[0].persona` therefore ran with no
// persona: no personaLine in the prompt, traitsApplied empty, and nothing warned. The field's own
// doc comment in src/lab/types.ts says "Default: actors[0].persona", and its sibling fields
// (stopWhen, reasoningEffort) already fell back that way. Doc and code disagreed; code won.
//
// personas drive the app. A fan-out result produced without one is not the study that was
// declared, so this is a fidelity bug, not a cosmetic one.

function planFor(actor: Record<string, unknown>) {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "lane-persona-fallback",
    title: "Lane persona fallback",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:8000/" },
    actors: [actor],
    execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
    scenario: { mode: "dry-run" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return resolveCuaParticipantPlan(parsed.config, { dryRun: true });
}

describe("participant persona resolution", () => {
  it("falls back to actors[0].persona when a participant does not name one", () => {
    const plan = planFor({
      type: "openai-computer-use",
      persona: "synthetic-new-user",
      mission: "Look at the page.",
      lanes: [
        { id: "mobile", device: "mobile" },
        { id: "desktop", device: "desktop" },
      ],
    });
    expect(plan.lanes).toHaveLength(2);
    for (const lane of plan.lanes) {
      expect(lane.persona).toBe("synthetic-new-user");
    }
  });

  it("lets a participant override the actor's persona", () => {
    const plan = planFor({
      type: "openai-computer-use",
      persona: "synthetic-new-user",
      mission: "Look at the page.",
      lanes: [{ id: "a", persona: "power-user" }, { id: "b" }],
    });
    expect(plan.lanes[0]?.persona).toBe("power-user");
    // The un-overridden participant still inherits, so one override does not strip the rest.
    expect(plan.lanes[1]?.persona).toBe("synthetic-new-user");
  });

  it("uses the documented default when neither the participant nor the actor names one", () => {
    // src/routes/computer-use/participant-prompt.ts falls back to `cua-operator`. Asserted so the fallback chain is
    // pinned end to end: participant, then actor, then the built-in default.
    const plan = planFor({
      type: "openai-computer-use",
      mission: "Look at the page.",
      lanes: [{ id: "a" }],
    });
    expect(plan.lanes[0]?.persona).toBe("cua-operator");
  });

  it("still resolves the persona with no roster at all", () => {
    // The non-roster path was always correct; keep it that way.
    const plan = planFor({
      type: "openai-computer-use",
      persona: "synthetic-new-user",
      mission: "Look at the page.",
    });
    expect(plan.lanes[0]?.persona).toBe("synthetic-new-user");
  });
});
