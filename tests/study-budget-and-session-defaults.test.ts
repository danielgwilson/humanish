// The budget sizing pass: a session ends because the participant finished, and the budget a
// researcher sets is the STUDY's, not a lane's (#299).
//
// Also pins the closing-observation fix the first live funnel run exposed: a done turn takes no
// actions, so the loop never observed the participant's final state — both participants reached
// the dashboard and the funnel said 0/2.

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
import { makeCuaRunBudget, resolveCuaLanePlan } from "../src/cua-actor-lab.js";
import { parseLabConfig } from "../src/lab-config.js";
import { defaultRedactionHooks } from "../src/redaction.js";

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

const persona: ActorPersonaRef = { id: "dana", traitsApplied: [], promptDigest: "abc123def456" };

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

class ScriptedProvider implements CuaProvider {
  readonly id = "fake-cua";
  readonly version = "fake-1";
  readonly capabilities = FAKE_CAPS;
  private i = 0;
  constructor(private readonly turns: CuaTurn[]) {}
  async nextTurn(_req: CuaTurnRequest): Promise<CuaTurn> {
    const turn = this.turns[this.i];
    this.i += 1;
    return turn ?? { actions: [], pendingSafetyChecks: [], done: true, message: "done (exhausted)" };
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

describe("the closing observation feeds the funnel (first live study's miss)", () => {
  it("completes a task from the final state a done turn would otherwise never observe", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false },
      { actions: [], pendingSafetyChecks: [], done: true, message: "Signed in; I can see the documents area." }
    ]);
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "s0", url: "http://127.0.0.1:3000/verify-email/tok" },
      // Post-action observation: navigation still settling — NOT the dashboard yet.
      { screenshot: frame(), stateSignature: "s1", url: "http://127.0.0.1:3000/verify-email/tok" },
      // The closing observation after the model says done: the participant's real final state.
      { screenshot: frame(), stateSignature: "s2", url: "http://127.0.0.1:3000/t/personal/documents" }
    ]);

    const result = await runComputerUseLoop({
      instructions: "Finish signing in.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      tasks: [{
        id: "reach-dashboard",
        goal: "Get to your documents area.",
        success: { any: [{ id: "docs", urlIncludes: "/documents" }] }
      }]
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.taskFunnel?.completed).toBe(1);
    expect(result.trace.taskFunnel?.stoppedAt).toBeUndefined();
  });
});

describe("the study budget stops a lane honestly (#299)", () => {
  it("ends with budget_reached (incomplete), never gave_up, when the RUN budget is exhausted", async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 10 }, () => ({
        actions: [{ kind: "click", x: 10, y: 20 }] as CuaAction[],
        pendingSafetyChecks: [],
        done: false,
        usage: { input: 1000, output: 50 }
      }))
    );
    const executor = new ObservationSequenceExecutor(
      Array.from({ length: 12 }, (_, index) => ({
        screenshot: frame(),
        stateSignature: `s${index}`
      }))
    );

    let calls = 0;
    const result = await runComputerUseLoop({
      instructions: "Do the study.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      overRunBudget: () => {
        calls += 1;
        return calls >= 3
          ? "study budget reached: the run's estimated model spend $12.10 crossed execution.caps.maxTotalUsd=$12"
          : null;
      }
    });

    expect(result.completionReason).toBe("budget_reached");
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("maxTotalUsd");
  });

  it("sums lane estimates on the shared ledger and ignores unpriceable readings", () => {
    const budget = makeCuaRunBudget(10);
    expect(budget.note("lane-a", 2)).toBe(2);
    expect(budget.note("lane-b", 3)).toBe(5);
    // A lane's estimate REPLACES its previous reading — running totals, not increments.
    expect(budget.note("lane-a", 4)).toBe(7);
    expect(budget.note("lane-b", null)).toBe(7);
    expect(budget.maxTotalUsd).toBe(10);
  });
});

describe("caps parsing and session defaults", () => {
  const baseLab = {
    schema: "humanish.lab.v2",
    id: "sizing-test",
    title: "sizing",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [{ type: "openai-computer-use", mission: "Look around." }],
    execution: { target: "e2b-desktop" },
    scenario: { mode: "dry-run" }
  };

  it("parses execution.caps.maxTotalUsd and refuses a negative one", () => {
    const good = parseLabConfig({
      ...baseLab,
      execution: { target: "e2b-desktop", caps: { maxTotalUsd: 25 } }
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.config.execution?.caps?.maxTotalUsd).toBe(25);

    const bad = parseLabConfig({
      ...baseLab,
      execution: { target: "e2b-desktop", caps: { maxTotalUsd: -1 } }
    });
    expect(bad.ok).toBe(false);
  });

  it("defaults an app-url session to 30 minutes", () => {
    const parsed = parseLabConfig(baseLab);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(resolveCuaLanePlan(parsed.config).perLaneSessionBudgetMs).toBe(30 * 60_000);
  });

  it("derives a provisioned-route default that fits the one-hour sandbox cap", () => {
    const parsed = parseLabConfig({
      ...baseLab,
      subject: { source: "clone", repos: ["example/app"], serve: { install: "npm install", start: "npm start", url: "http://localhost:3000/" } }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 60m cap − 30m provisioning − 10m teardown buffer = 20 minutes of session room.
    expect(resolveCuaLanePlan(parsed.config).perLaneSessionBudgetMs).toBe(20 * 60_000);
  });

  it("subtracts declared state seeding from the derived default", () => {
    const parsed = parseLabConfig({
      ...baseLab,
      subject: {
        source: "clone",
        repos: ["example/app"],
        serve: { install: "npm install", start: "npm start", url: "http://localhost:3000/" },
        state: { seed: [
          { name: "migrate", command: "npm run migrate", when: "before-start" },
          { name: "seed", command: "npm run seed", when: "before-start" }
        ] }
      }
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Two 5-minute default seed steps shrink the room to 10 minutes.
    expect(resolveCuaLanePlan(parsed.config).perLaneSessionBudgetMs).toBe(10 * 60_000);
  });
});
