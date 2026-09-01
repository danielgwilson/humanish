import { describe, expect, it } from "vitest";
import { TaskTracker } from "../src/tasks.js";
import type { LabTask } from "../src/tasks.js";

// #514: a three-lane study declared `reach-prices` with `urlIncludes: pricing`, and every lane
// opened on a URL containing that literal substring. The funnel reported `completed: 0, sessions:
// 3`, and the summary rendered "reach-prices 0/3", which reads as "no participant could find the
// pricing page". What actually happened is that the observer never supplied a url, so the criterion
// was never evaluated against anything.
//
// 0-because-they-failed and 0-because-we-never-looked are different facts. Reporting them
// identically hands the harness's own gap to the reader as a finding about the participant, which
// is exactly what docs/principles/three-roles.md exists to prevent.

const urlTask: LabTask = {
  id: "reach-prices",
  goal: "Find where this product publishes what it charges.",
  success: { any: [{ id: "on-a-pricing-surface", urlIncludes: "pricing" }] }
};

const textTask: LabTask = {
  id: "sees-total",
  goal: "Get to a page showing the total.",
  success: { any: [{ id: "total-visible", textIncludes: "Total" }] }
};

describe("task funnel distinguishes unmeasured from failed (#514)", () => {
  it("marks a task unmeasured when its criterion's input never arrived", () => {
    const tracker = new TaskTracker([urlTask]);
    // Turns ran, but the browser-state observer yielded nothing with a url in it.
    tracker.observe({ text: "some page text" }, 0);
    tracker.observe({ text: "more page text" }, 1);

    const funnel = tracker.funnel();
    expect(funnel.completed).toBe(0);
    expect(funnel.unmeasured).toBe(1);
    expect(funnel.tasks[0]?.inputsObserved).toBe(false);
    // And it is NOT reported as where the participant stopped.
    expect(funnel.stoppedAt).toBeUndefined();
  });

  it("reports a genuine failure as a failure, not as unmeasured", () => {
    const tracker = new TaskTracker([urlTask]);
    // The url WAS observed. It simply never matched.
    tracker.observe({ url: "https://example.com/about" }, 0);

    const funnel = tracker.funnel();
    expect(funnel.completed).toBe(0);
    expect(funnel.unmeasured).toBe(0);
    expect(funnel.tasks[0]?.inputsObserved).toBe(true);
    // This one IS where they stopped, and saying so is fair.
    expect(funnel.stoppedAt).toBe("reach-prices");
  });

  it("reproduces the #514 case: a criterion true at turn 0 that was never measured", () => {
    const tracker = new TaskTracker([urlTask]);
    // Every lane opened on https://vercel.com/pricing. Had the url reached the tracker, this task
    // would have completed on turn 0 without a single action.
    const funnel = tracker.funnel();
    expect(funnel.unmeasured).toBe(1);

    const measured = new TaskTracker([urlTask]);
    measured.observe({ url: "https://vercel.com/pricing" }, 0);
    expect(measured.funnel().completed).toBe(1);
    expect(measured.funnel().tasks[0]?.turn).toBe(0);
  });

  it("does not mark a completed task unmeasured", () => {
    const tracker = new TaskTracker([urlTask]);
    tracker.observe({ url: "https://stripe.com/pricing" }, 2);
    const funnel = tracker.funnel();
    expect(funnel.completed).toBe(1);
    expect(funnel.unmeasured).toBe(0);
    expect(funnel.tasks[0]?.inputsObserved).toBeUndefined();
  });

  it("counts a task measured when ANY field its rules read arrived", () => {
    // `any` semantics: one satisfiable rule needing a field we saw is enough to call it measured.
    const tracker = new TaskTracker([
      { ...urlTask, success: { any: [{ id: "a", urlIncludes: "pricing" }, { id: "b", textIncludes: "Plans" }] } }
    ]);
    tracker.observe({ text: "Pricing overview" }, 0);
    expect(tracker.funnel().unmeasured).toBe(0);
  });

  it("leaves an unobservable task alone: it was never measurable by declaration", () => {
    const tracker = new TaskTracker([{ id: "report-a-number", goal: "Say the number out loud." }]);
    const funnel = tracker.funnel();
    expect(funnel.unobservable).toBe(1);
    expect(funnel.unmeasured).toBe(0);
    expect(funnel.tasks[0]?.inputsObserved).toBeUndefined();
  });

  it("separates the three states in one session", () => {
    const tracker = new TaskTracker([
      textTask,
      urlTask,
      { id: "narrate", goal: "Say what you think." }
    ]);
    tracker.observe({ text: "Total: $40" }, 1);

    const funnel = tracker.funnel();
    expect(funnel.completed).toBe(1);   // sees-total: observed and matched
    expect(funnel.unmeasured).toBe(1);  // reach-prices: url never arrived
    expect(funnel.unobservable).toBe(1); // narrate: no criterion by declaration
    expect(funnel.stoppedAt).toBeUndefined();
  });
});
