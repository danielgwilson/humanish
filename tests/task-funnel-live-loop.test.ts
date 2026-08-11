// #414 wired into the LIVE loop: a run with a declared protocol emits its funnel.
//
// The tasks model shipped pure and tested first, deliberately — the previous two features both had
// holes only a real run exposed. This is the wiring's deterministic half: the loop corroborates
// task completion from the same observations stopWhen reads, the funnel lands on the trace, the
// study roll-up carries a denominator on every number, and the success criteria never reach the
// prompt or the persisted evidence.

import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorPersonaRef } from "../src/actor-contract.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest
} from "../src/computer-use.js";
import { composeLaneInstructions } from "../src/cua-actor-lab.js";
import { DEVICE_PRESETS } from "../src/device-presets.js";
import { defaultRedactionHooks } from "../src/redaction.js";
import { aggregateTaskFunnels, formatStudyTaskFunnel } from "../src/run.js";
import type { LabTask, TaskFunnel } from "../src/tasks.js";

const FAKE_CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};

const persona: ActorPersonaRef = {
  id: "dana",
  traitsApplied: ["friction-tolerance:low"],
  promptDigest: "abc123def456"
};

function frame(): Buffer {
  const png = new PNG({ width: 200, height: 150 });
  for (let i = 0; i < 200 * 150; i += 1) {
    const o = i * 4;
    const v = i % 2 === 0 ? 0 : 255;
    png.data[o] = v;
    png.data[o + 1] = v;
    png.data[o + 2] = v;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

class RepeatProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = FAKE_CAPS;
  readonly seen: CuaTurnRequest[] = [];
  constructor(private readonly turn: CuaTurn) {}
  async nextTurn(req: CuaTurnRequest): Promise<CuaTurn> {
    this.seen.push(req);
    return this.turn;
  }
}

class ObservationSequenceExecutor implements CuaExecutor {
  private i = 0;
  readonly frame = frame();
  readonly actions: CuaAction[] = [];
  constructor(private readonly observations: CuaObservation[]) {}
  async observe(): Promise<CuaObservation> {
    const observation = this.observations[Math.min(this.i, this.observations.length - 1)];
    this.i += 1;
    return observation ?? { screenshot: this.frame, stateSignature: "fallback" };
  }
  async execute(action: CuaAction): Promise<void> {
    this.actions.push(action);
  }
}

function monotonicClock(step = 1000): () => number {
  let t = 0;
  return () => (t += step);
}

// A three-task signup protocol. The criterion VALUES ("/register", "check your email",
// "/dashboard") are the researcher's instrument — the tests below assert they appear in neither
// the prompt nor the persisted trace.
const PROTOCOL: LabTask[] = [
  {
    id: "reach-signup",
    goal: "Create an account with your email address.",
    success: { any: [{ id: "on-register", urlIncludes: "/register" }] }
  },
  {
    id: "see-verify-notice",
    goal: "Follow what the app tells you to do next.",
    success: { any: [{ id: "notice", textIncludes: "check your email" }] }
  },
  {
    id: "reach-dashboard",
    goal: "Get to your account's home area.",
    success: { any: [{ id: "on-dashboard", urlIncludes: "/dashboard" }] }
  }
];

describe("the live loop corroborates the protocol (#414 wiring)", () => {
  it("records completions from observations and lands the funnel on the trace", async () => {
    const provider = new RepeatProvider({
      actions: [{ kind: "click", x: 10, y: 20 }],
      pendingSafetyChecks: [],
      done: false
    });
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "s0", url: "http://127.0.0.1:3000/", text: "Welcome" },
      { screenshot: frame(), stateSignature: "s1", url: "http://127.0.0.1:3000/register", text: "Sign up" },
      { screenshot: frame(), stateSignature: "s2", url: "http://127.0.0.1:3000/register", text: "Almost there — check your email" },
      { screenshot: frame(), stateSignature: "s3", url: "http://127.0.0.1:3000/dashboard", text: "Your documents" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Sign up and reach your dashboard.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      tasks: PROTOCOL,
      // The stop condition and the final task coincide on purpose: the funnel must include the
      // very turn that ends the session.
      stopWhen: { any: [{ id: "done", urlIncludes: "/dashboard" }] }
    });

    expect(result.completionReason).toBe("goal_satisfied");
    const funnel = result.trace.taskFunnel;
    expect(funnel).toBeDefined();
    expect(funnel!.schema).toBe("humanish.task-funnel.v1");
    expect(funnel!.total).toBe(3);
    expect(funnel!.completed).toBe(3);
    expect(funnel!.stoppedAt).toBeUndefined();
    expect(funnel!.tasks.map((task) => ({ id: task.id, completed: task.completed }))).toEqual([
      { id: "reach-signup", completed: true },
      { id: "see-verify-notice", completed: true },
      { id: "reach-dashboard", completed: true }
    ]);
    // Turn-stamped: signup completed on turn 1's observation, the notice on turn 2, dashboard on 3.
    expect(funnel!.tasks.map((task) => task.turn)).toEqual([1, 2, 3]);

    // The trace narrates WHICH task completed, never WHAT counted as proof.
    const notices = result.trace.items.filter((item) => item.kind === "notice" && item.title.startsWith("task completed:"));
    expect(notices.map((item) => item.title)).toEqual([
      "task completed: reach-signup",
      "task completed: see-verify-notice",
      "task completed: reach-dashboard"
    ]);
    const persisted = JSON.stringify(result.trace);
    expect(persisted).not.toContain("/register");
    expect(persisted).not.toContain("check your email");
    expect(persisted).not.toContain("Your documents");
  });

  it("reports where the participant stopped when the session ends mid-protocol", async () => {
    const provider = new RepeatProvider({
      actions: [],
      pendingSafetyChecks: [],
      done: true,
      message: "I could not find the signup form, giving up."
    });
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "s0", url: "http://127.0.0.1:3000/register", text: "Sign up" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Sign up and reach your dashboard.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      tasks: PROTOCOL
    });

    const funnel = result.trace.taskFunnel;
    // The initial observation (turn 0) already satisfied reach-signup; nothing after it did.
    expect(funnel!.completed).toBe(1);
    expect(funnel!.tasks[0]).toMatchObject({ id: "reach-signup", completed: true, turn: 0 });
    expect(funnel!.stoppedAt).toBe("see-verify-notice");
  });

  it("emits no funnel when the lab declared no protocol — honest absence, not an empty one", async () => {
    const provider = new RepeatProvider({ actions: [], pendingSafetyChecks: [], done: true, message: "done" });
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "s0" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Look around.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock()
    });

    expect(result.trace.taskFunnel).toBeUndefined();
    expect(JSON.stringify(result.trace)).not.toContain("taskFunnel");
  });
});

describe("the participant never sees the researcher's criteria (composer)", () => {
  it("renders numbered goals into the lane prompt and nothing from `success`", () => {
    const composed = composeLaneInstructions({
      mission: "You heard about this document tool and want to try it.",
      tasks: PROTOCOL,
      device: { name: "desktop", preset: DEVICE_PRESETS.desktop }
    });

    expect(composed.instructions).toContain("Work through these in order:");
    expect(composed.instructions).toContain("1. Create an account with your email address.");
    expect(composed.instructions).toContain("3. Get to your account's home area.");
    // The Goodhart leak this pins: a persona told "you succeed when the URL contains /dashboard"
    // goes and finds that URL, which measures the instruction rather than the product.
    expect(composed.instructions).not.toContain("/register");
    expect(composed.instructions).not.toContain("/dashboard");
    expect(composed.instructions).not.toContain("check your email");
    expect(composed.instructions).not.toContain("urlIncludes");
    expect(composed.instructions).not.toContain("success");
  });

  it("changes nothing for a lab with no tasks", () => {
    const args = {
      mission: "You heard about this document tool and want to try it.",
      device: { name: "desktop", preset: DEVICE_PRESETS.desktop }
    } as const;
    expect(composeLaneInstructions({ ...args }).instructions)
      .toBe(composeLaneInstructions({ ...args, tasks: [] }).instructions);
  });
});

describe("the study roll-up keeps its denominators", () => {
  const funnelOf = (completed: boolean[]): TaskFunnel => ({
    schema: "humanish.task-funnel.v1",
    total: 3,
    completed: completed.filter(Boolean).length,
    unobservable: 0,
    ...(completed.every(Boolean) ? {} : { stoppedAt: PROTOCOL[completed.indexOf(false)]!.id }),
    tasks: PROTOCOL.map((task, index) => ({
      id: task.id,
      completed: completed[index] ?? false,
      observable: true,
      ...(completed[index] ? { turn: index + 1 } : {})
    }))
  });

  it("aggregates per-task completion across participants", () => {
    const study = aggregateTaskFunnels([funnelOf([true, true, true]), funnelOf([true, false, false])]);
    expect(study).toEqual({
      sessions: 2,
      tasks: [
        { id: "reach-signup", completed: 2, sessions: 2, observable: true },
        { id: "see-verify-notice", completed: 1, sessions: 2, observable: true },
        { id: "reach-dashboard", completed: 1, sessions: 2, observable: true }
      ]
    });
    expect(formatStudyTaskFunnel(study!)).toBe(
      "reach-signup 2/2 · see-verify-notice 1/2 · reach-dashboard 1/2"
    );
  });

  it("says which tasks could never be measured instead of counting them failed", () => {
    const unmeasured: TaskFunnel = {
      schema: "humanish.task-funnel.v1",
      total: 1,
      completed: 0,
      unobservable: 1,
      tasks: [{ id: "tell-us-what-confused-you", completed: false, observable: false }]
    };
    const study = aggregateTaskFunnels([unmeasured]);
    expect(formatStudyTaskFunnel(study!)).toBe("tell-us-what-confused-you (no completion criterion)");
  });

  it("returns undefined when no session measured a funnel — absence, never zeros", () => {
    expect(aggregateTaskFunnels([])).toBeUndefined();
  });
});
