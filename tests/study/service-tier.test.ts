// actor.serviceTier: fast asks OpenAI for Fast mode on every participant request. It is a priced,
// declared setting: a study is refused when humanish cannot price the tier or the route cannot send it.
import { describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { computerUseParticipants } from "../../src/study/plan-participants.js";
import { STUDY_SCHEMA } from "../../src/study/types.js";

function study(actor: Record<string, unknown>) {
  return parseStudy({
    schema: STUDY_SCHEMA,
    id: "service-tier",
    route: "computer-use",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    actor: { mission: "Add a task.", ...actor },
  });
}

describe("actor.serviceTier", () => {
  it("gives every computer-use participant the declared tier", () => {
    const result = study({ type: "openai-computer-use", serviceTier: "fast" });
    expect(result.ok ? "ok" : result.error.message).toBe("ok");
    if (!result.ok) return;
    const participants = computerUseParticipants(result.config);
    expect(participants.map((participant) => participant.limits.serviceTier)).toEqual(["fast"]);
  });

  it("refuses a model humanish has no Fast mode rate for", () => {
    const result = study({ type: "openai-computer-use", model: "gpt-5.5", serviceTier: "fast" });
    expect(result.ok ? "ok" : result.error.message).toMatch(/gpt-5\.5.*Fast mode rate/);
  });

  it("refuses a route that does not send it", () => {
    const result = study({ type: "local-agent", localAgent: "claude", serviceTier: "fast" });
    expect(result.ok ? "ok" : result.error.message).toMatch(/serviceTier/);
  });

  it("refuses a tier other than fast", () => {
    const result = study({ type: "openai-computer-use", serviceTier: "flex" });
    expect(result.ok ? "ok" : result.error.message).toMatch(/serviceTier/);
  });
});
