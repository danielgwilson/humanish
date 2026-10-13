// The budget sizing pass: a session ends because the participant finished, and the budget a
// researcher sets is the study's, not a participant's.
//
// Also pins the closing-observation fix the first live funnel run exposed: a done turn takes no
// actions, so the loop never observed the participant's final state: both participants reached
// the dashboard and the funnel said 0/2.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import type { ActorCapabilities, ActorPersonaRef } from "../../../src/actors/contract.js";
import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaObservation,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { createInProcessDesktop } from "../../../src/routes/computer-use/in-process-desktop.js";
import { runCuaParticipant } from "../../../src/routes/computer-use/participant-execution.js";
import { makeCuaRunBudget } from "../../../src/routes/computer-use/participant-model.js";
import type {
  CuaParticipantDeps,
  CuaRunBudget,
  ParticipantRunOutcome,
} from "../../../src/routes/computer-use/types.js";
import { prepareSelectedOutputDirectory } from "../../../src/run/contained-output.js";
import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA } from "../../../src/study/types.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { participantPlanOf, participantRun } from "../../helpers/participant-run.js";

const FAKE_CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
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
    return (
      turn ?? { actions: [], pendingSafetyChecks: [], done: true, message: "done (exhausted)" }
    );
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

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A model priced at gpt-5.5's rates that clicks on every turn and reports `input` tokens a turn. */
function clickingProvider(input: number, requests: CuaTurnRequest[]): CuaProvider {
  return {
    id: "fake-cua",
    version: "gpt-5.5",
    capabilities: FAKE_CAPS,
    async nextTurn(request) {
      requests.push(request);
      return {
        actions: [{ kind: "click", x: 10, y: 20 }],
        pendingSafetyChecks: [],
        done: false,
        usage: { input, output: 0 },
      };
    },
  };
}

/** A live in-process study's participant runner inputs, sharing one study budget ledger. */
async function inProcessParticipantDeps(
  runBudget: CuaRunBudget,
): Promise<(provider: CuaProvider, executor: CuaExecutor) => CuaParticipantDeps> {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-study-budget-"));
  temporary.push(cwd);
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "study-budget",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: { type: "openai-computer-use", persona: "first-time-visitor", mission: "Save a note." },
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  const artifactRoot = await prepareSelectedOutputDirectory(cwd, "artifacts");
  return (provider, executor) => {
    const deps: CuaParticipantDeps = {
      residual: parsed.config,
      studyId: parsed.config.id,
      caps: { maxTotalUsd: runBudget.maxTotalUsd },
      brain: { kind: "caller" },
      appUrl: "http://127.0.0.1:3000/",
      subject: { kind: "app-url", appUrl: "http://127.0.0.1:3000/", publicTargets: false },
      env: {},
      openaiApiKey: "",
      e2bApiKey: "",
      requestTimeoutMs: 60_000,
      sandboxMs: 60_000,
      timeoutMs: 60_000,
      participantCount: 2,
      artifactRoot,
      studyCwd: cwd,
      redactScreenshots: false,
      scrubKnownValues: (value) => value,
      runBudget,
      runSession: runCuaActorSession,
      now: Date.now,
      desktopModule: async () => {
        throw new Error("An in-process participant must never load an E2B desktop");
      },
      createProvider: async () => provider,
      inProcessExecutor: async () => executor,
      onStream: async () => undefined,
      reportSubjectPhase: () => undefined,
    };
    deps.createDesktop = () => createInProcessDesktop(deps);
    return deps;
  };
}

/** A desktop whose every look shows a new screen; `during` runs inside each look or each action. */
function changingDesktop(
  during: { look?: () => Promise<void>; action?: () => Promise<void> } = {},
): CuaExecutor {
  let looks = 0;
  const screenshot = frame();
  return {
    observe: async () => {
      await during.look?.();
      return { screenshot, stateSignature: `s${(looks += 1)}` };
    },
    execute: async () => {
      await during.action?.();
    },
  };
}

/**
 * Two participants share a $1 study budget. During the first participant's opening look or its
 * first click, the second runs: its one reply crosses the budget and it stops. At gpt-5.5's $5 per
 * million input tokens, the first participant's 10,000-token turn is $0.05 and the second's
 * 400,000-token turn is $2.
 */
async function siblingCrossesBudget(during: "look" | "action") {
  const runBudget = makeCuaRunBudget(1);
  const participantDeps = await inProcessParticipantDeps(runBudget);
  const persona = { id: "first-time-visitor", traitsApplied: [], promptDigest: "synthetic" };
  const run = (id: string, index: number) =>
    participantRun({ id, index, persona, instructions: "Save a note." });
  const siblingRequests: CuaTurnRequest[] = [];
  const siblingDeps = participantDeps(
    clickingProvider(400_000, siblingRequests),
    changingDesktop(),
  );
  let sibling: ParticipantRunOutcome | undefined;
  const runSibling = async () => {
    sibling ??= await runCuaParticipant(run("second", 1), siblingDeps);
  };
  const requests: CuaTurnRequest[] = [];
  const outcome = await runCuaParticipant(
    run("first", 0),
    participantDeps(clickingProvider(10_000, requests), changingDesktop({ [during]: runSibling })),
  );
  return { outcome, requests, sibling, siblingRequests };
}

describe("the closing observation feeds the funnel (first live study's miss)", () => {
  it("completes a task from the final state a done turn would otherwise never observe", async () => {
    const provider = new ScriptedProvider([
      { actions: [{ kind: "click", x: 10, y: 20 }], pendingSafetyChecks: [], done: false },
      {
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        message: "Signed in; I can see the documents area.",
      },
    ]);
    const executor = new ObservationSequenceExecutor([
      { screenshot: frame(), stateSignature: "s0", url: "http://127.0.0.1:3000/verify-email/tok" },
      // Post-action observation: navigation still settling, not the dashboard yet.
      { screenshot: frame(), stateSignature: "s1", url: "http://127.0.0.1:3000/verify-email/tok" },
      // The closing observation after the model says done: the participant's real final state.
      {
        screenshot: frame(),
        stateSignature: "s2",
        url: "http://127.0.0.1:3000/t/personal/documents",
      },
    ]);

    const result = await runComputerUseLoop({
      instructions: "Finish signing in.",
      provider,
      executor,
      persona,
      redaction: defaultRedactionHooks,
      timeoutMs: 10_000_000,
      now: monotonicClock(),
      tasks: [
        {
          id: "reach-dashboard",
          goal: "Get to your documents area.",
          success: { any: [{ id: "docs", urlIncludes: "/documents" }] },
        },
      ],
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.taskFunnel?.completed).toBe(1);
    expect(result.trace.taskFunnel?.stoppedAt).toBeUndefined();
  });
});

describe("the study budget stops a participant with budget_reached", () => {
  it("ends with budget_reached (incomplete), never gave_up, when the run budget is exhausted", async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 10 }, () => ({
        actions: [{ kind: "click", x: 10, y: 20 }] as CuaAction[],
        pendingSafetyChecks: [],
        done: false,
        usage: { input: 1000, output: 50 },
      })),
    );
    const executor = new ObservationSequenceExecutor(
      Array.from({ length: 12 }, (_, index) => ({
        screenshot: frame(),
        stateSignature: `s${index}`,
      })),
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
          ? "study budget reached: the run's estimated model spend $12.10 crossed caps.maxTotalUsd=$12"
          : null;
      },
    });

    expect(result.completionReason).toBe("budget_reached");
    expect(result.status).toBe("incomplete");
    expect(result.reason).toContain("maxTotalUsd");
  });

  it("sends no further request once a sibling's spend crosses the study budget", async () => {
    const { outcome, requests, sibling, siblingRequests } = await siblingCrossesBudget("action");
    expect(siblingRequests).toHaveLength(1);
    expect(sibling?.session?.trace.stopCause).toBe("study_spend_limit");
    expect(outcome.session?.completionReason).toBe("budget_reached");
    expect(outcome.session?.trace.stopCause).toBe("study_spend_limit");
    expect(requests).toHaveLength(1);
  });

  it("sends no first request when a sibling crossed the study budget before it", async () => {
    const { outcome, requests, sibling, siblingRequests } = await siblingCrossesBudget("look");
    expect(siblingRequests).toHaveLength(1);
    expect(sibling?.session?.trace.stopCause).toBe("study_spend_limit");
    expect(outcome.session?.completionReason).toBe("budget_reached");
    expect(outcome.session?.trace.stopCause).toBe("study_spend_limit");
    expect(requests).toHaveLength(0);
  });

  it("sums participant estimates on the shared ledger and ignores unpriceable readings", () => {
    const budget = makeCuaRunBudget(10);
    expect(budget.note("lane-a", 2)).toBe(2);
    expect(budget.note("lane-b", 3)).toBe(5);
    // A participant's estimate replaces its previous reading: running totals, not increments.
    expect(budget.note("lane-a", 4)).toBe(7);
    expect(budget.note("lane-b", null)).toBe(7);
    expect(budget.maxTotalUsd).toBe(10);
  });
});

describe("caps parsing and session defaults", () => {
  const baseLab = {
    schema: "humanish.study.v3",
    id: "sizing-test",
    title: "sizing",
    route: "computer-use",
    mode: "dry-run",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: { type: "openai-computer-use", mission: "Look around." },
    execution: { target: "e2b-desktop" },
  };

  it("parses caps.maxTotalUsd and refuses a negative one", () => {
    const good = parseStudy({ ...baseLab, caps: { maxTotalUsd: 25 } });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.config.caps?.maxTotalUsd).toBe(25);

    const bad = parseStudy({ ...baseLab, caps: { maxTotalUsd: -1 } });
    expect(bad.ok).toBe(false);
  });

  it("defaults an app-url session to 30 minutes", () => {
    const parsed = parseStudy(baseLab);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(participantPlanOf(parsed.config).perLaneSessionBudgetMs).toBe(30 * 60_000);
  });

  it("derives a provisioned-route default that fits the one-hour sandbox cap", () => {
    const parsed = parseStudy({
      ...baseLab,
      subject: {
        source: "clone",
        repos: ["example/app"],
        serve: { install: "npm install", start: "npm start", url: "http://localhost:3000/" },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 60m cap − 30m provisioning − 10m teardown buffer = 20 minutes of session room.
    expect(participantPlanOf(parsed.config).perLaneSessionBudgetMs).toBe(20 * 60_000);
  });

  it("subtracts declared state seeding from the derived default", () => {
    const parsed = parseStudy({
      ...baseLab,
      subject: {
        source: "clone",
        repos: ["example/app"],
        serve: { install: "npm install", start: "npm start", url: "http://localhost:3000/" },
        state: {
          seed: [
            { name: "migrate", command: "npm run migrate", when: "before-start" },
            { name: "seed", command: "npm run seed", when: "before-start" },
          ],
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // Two 5-minute default seed steps shrink the room to 10 minutes.
    expect(participantPlanOf(parsed.config).perLaneSessionBudgetMs).toBe(10 * 60_000);
  });
});
