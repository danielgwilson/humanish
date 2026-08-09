// Tasks: the researcher's protocol, and the wall between it and the participant.
//
// A lab could declare a prose mission and nothing else. That is a brief, not a protocol, and it
// left "where did people get stuck" answerable only from the actor's own narration — the one source
// a study should not have to take on faith.
//
// The half of this that needs guarding is the split. `goal` is what the participant is asked to do;
// `success` is how the researcher measures it, and a moderator does not read the success criterion
// aloud. A persona told "you succeed when the URL contains /dashboard" goes and finds that URL,
// which measures the instruction rather than the product.
import { describe, expect, it } from "vitest";

import { TaskTracker, formatTaskFunnel, renderTaskPrompt, type LabTask } from "../src/tasks.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

const PROTOCOL: LabTask[] = [
  { id: "sign-up", goal: "Create an account.", success: { any: [{ urlIncludes: "/verify-email" }] } },
  { id: "verify", goal: "Confirm your email address.", success: { any: [{ urlPathEquals: "/documents" }] } },
  { id: "reflect", goal: "Tell us what felt confusing." } // narrative-only: asked for, not measurable
];

describe("the participant never sees the success criteria", () => {
  it("renders goals and nothing else", () => {
    const prompt = renderTaskPrompt(PROTOCOL) ?? "";

    expect(prompt).toContain("Create an account.");
    expect(prompt).toContain("Confirm your email address.");
    // The measurement is the researcher's instrument. Leaking it turns the study into a treasure
    // hunt for the criterion.
    expect(prompt).not.toContain("/verify-email");
    expect(prompt).not.toContain("/documents");
    expect(prompt).not.toContain("urlIncludes");
    expect(prompt).not.toContain("success");
  });

  it("numbers them in order, like a protocol a person could follow", () => {
    const prompt = renderTaskPrompt(PROTOCOL) ?? "";
    expect(prompt).toContain("1. Create an account.");
    expect(prompt).toContain("2. Confirm your email address.");
    expect(prompt).toContain("3. Tell us what felt confusing.");
  });

  it("says nothing at all when no protocol was declared, so a prose mission stands alone", () => {
    // Tasks are additive. A lab with only a mission is a valid lab and must not gain boilerplate.
    expect(renderTaskPrompt([])).toBeUndefined();
  });
});

describe("TaskTracker", () => {
  it("completes a task from an OBSERVATION, not from the actor saying so", () => {
    const tracker = new TaskTracker(PROTOCOL);

    // The actor claiming success changes nothing; only the observed world does.
    expect(tracker.observe({ text: "I have signed up successfully!" }, 3)).toEqual([]);

    const completed = tracker.observe({ url: "https://app.test/verify-email?token=x" }, 4);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ id: "sign-up", turn: 4, matchedKinds: ["urlIncludes"] });
  });

  it("keeps a task complete once it happened", () => {
    const tracker = new TaskTracker(PROTOCOL);
    tracker.observe({ url: "https://app.test/verify-email" }, 2);
    // Navigating away does not un-sign-up.
    tracker.observe({ url: "https://app.test/" }, 5);
    expect(tracker.funnel().tasks.find((task) => task.id === "sign-up")?.completed).toBe(true);
  });

  it("reports where the participant stopped, which is the finding", () => {
    const tracker = new TaskTracker(PROTOCOL);
    tracker.observe({ url: "https://app.test/verify-email" }, 2);

    const funnel = tracker.funnel();
    expect(funnel.completed).toBe(1);
    expect(funnel.total).toBe(3);
    expect(funnel.stoppedAt).toBe("verify");
  });

  it("never blames a participant for a gap in the protocol", () => {
    // A task with no criterion could not have been proven either way, so it cannot be the place
    // they stopped.
    const tracker = new TaskTracker([
      { id: "narrative", goal: "Think aloud." },
      { id: "measured", goal: "Sign in.", success: { any: [{ urlPathEquals: "/home" }] } }
    ]);
    tracker.observe({ url: "https://app.test/home" }, 1);

    const funnel = tracker.funnel();
    expect(funnel.unobservable).toBe(1);
    expect(funnel.stoppedAt).toBeUndefined(); // everything measurable was reached
  });

  it("reports an empty protocol without inventing an outcome", () => {
    const funnel = new TaskTracker([]).funnel();
    expect(funnel).toMatchObject({ total: 0, completed: 0, unobservable: 0 });
    expect(funnel.stoppedAt).toBeUndefined();
  });
});

describe("formatTaskFunnel", () => {
  it("leads with the denominator and names where they stopped", () => {
    const tracker = new TaskTracker(PROTOCOL);
    tracker.observe({ url: "https://app.test/verify-email" }, 2);
    const line = formatTaskFunnel(tracker.funnel());

    expect(line).toContain("1/3 tasks completed");
    expect(line).toContain('stopped at "verify"');
    expect(line).toContain("1 with no completion criterion");
  });

  it("says so plainly when a lab declared no protocol", () => {
    expect(formatTaskFunnel(new TaskTracker([]).funnel())).toBe("no tasks declared");
  });
});

describe("tasks config parsing", () => {
  const lab = (actor: Record<string, unknown>) =>
    parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "task-lab",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", ...actor }],
      execution: { target: "e2b-desktop" },
      scenario: { mode: "live" }
    });

  it("a prose mission on its own is still a complete lab", () => {
    // Tasks are additive. Requiring a protocol would break every lab that exists.
    const parsed = lab({ mission: "Explore the app and stop." });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.actors[0]?.tasks).toBeUndefined();
  });

  it("accepts a protocol alongside the mission", () => {
    const parsed = lab({
      mission: "You are trying out a document signing tool.",
      tasks: [
        { id: "sign-up", goal: "Create an account.", success: { any: [{ urlIncludes: "/verify" }] } },
        { id: "reflect", goal: "Say what confused you." }
      ]
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const tasks = parsed.config.actors[0]?.tasks ?? [];
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({ id: "sign-up", goal: "Create an account." });
    // A task with no criterion is legal — not everything you ask for is observable.
    expect(tasks[1]?.success).toBeUndefined();
  });

  it("requires the participant-facing half, because a task nobody was asked to do is not a task", () => {
    const parsed = lab({ tasks: [{ id: "x", success: { any: [{ urlIncludes: "/a" }] } }] });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("goal");
  });

  it("refuses duplicate ids, which would make the funnel ambiguous", () => {
    const parsed = lab({
      tasks: [
        { id: "same", goal: "One." },
        { id: "same", goal: "Two." }
      ]
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.message).toContain("duplicate");
  });

  it("validates the success criterion with the same parser stop conditions use", () => {
    const parsed = lab({ tasks: [{ id: "x", goal: "Do it.", success: { any: [] } }] });
    expect(parsed.ok).toBe(false);
  });
});
