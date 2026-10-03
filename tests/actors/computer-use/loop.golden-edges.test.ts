import { PNG } from "pngjs";
import { it } from "vitest";

import { ComputerUseAdmissionLimitError } from "../../../src/actors/computer-use/admission-limit.js";
import { ComputerUseExecutorError } from "../../../src/actors/computer-use/executor-error.js";
import type { CuaProvider, CuaTurn } from "../../../src/actors/computer-use/loop.js";
import { PARTICIPANT_PROFILE } from "../../../src/actors/codex/restricted-participant-policy.js";
import {
  CAPABILITIES,
  FRAME,
  Probe,
  baseOptions,
  click,
  done,
  expectGolden,
  framed,
  loggedBudget,
  loggedEstimator,
  outcome,
  scriptedProvider,
  sequenceExecutor,
  turn,
  type LoopScenario,
} from "../../helpers/loop-golden.js";
import { dwellScenarios } from "../../helpers/loop-dwell-scenarios.js";

// Edge goldens for runComputerUseLoop: each file groups the less common branches of one concern.

async function expectGoldenRuns(
  name: string,
  scenarios: Record<string, LoopScenario>,
): Promise<void> {
  const runs: Record<string, unknown> = {};
  for (const [key, scenario] of Object.entries(scenarios)) {
    const probe = new Probe();
    const { provider, executor, options } = scenario(probe);
    runs[key] = await outcome(probe, baseOptions(probe, provider, executor, options));
  }
  await expectGolden(name, runs);
}

const receipt = { dispatched: true, usageComplete: true, cleanup: "confirmed" } as const;
const hang = (): Promise<never> => new Promise(() => {});
const commandExit = (): Error =>
  Object.assign(new Error("exit status 2"), {
    name: "CommandExitError",
    exitCode: 2,
    stderr: "zoom failed",
  });
function realPng(): Buffer {
  const png = new PNG({ width: 40, height: 30 });
  for (let i = 0; i < 40 * 30; i += 1) {
    const v = i % 2 === 0 ? 0 : 255;
    png.data.set([v, v, v, 255], i * 4);
  }
  return PNG.sync.write(png);
}

it("safety checks, stop conditions and dwell windows", async () => {
  const check = { id: "sc_9", code: "malicious_instructions", message: "be careful" };
  await expectGoldenRuns("harness-stops", {
    safetyAcknowledged: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({ actions: [click(1, 1)], pendingSafetyChecks: [check], responseId: "r1" }),
        turn({ actions: [click(2, 2)], responseId: "r2" }),
        done("done"),
      ]),
      executor: sequenceExecutor(probe, framed("s0", "s1", "s2")),
      options: { acknowledgeSafetyChecks: (checks) => checks },
    }),
    safetyBlocked: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({ actions: [click(1, 1)], pendingSafetyChecks: [check] }),
      ]),
      executor: sequenceExecutor(probe, framed("s0", "s1")),
    }),
    stopWhenBeforeFirstTurn: (probe) => ({
      provider: scriptedProvider(probe, []),
      executor: sequenceExecutor(probe, [
        { stateSignature: "s", appState: { route: "/done", modal: null } },
      ]),
      options: {
        stopWhen: {
          any: [{ id: "done-route", appStatePathEquals: { path: "route", equals: "/done" } }],
        },
      },
    }),
    stopWhenAfterAction: (probe) => ({
      provider: scriptedProvider(probe, [turn({ actions: [click(1, 1)] })]),
      executor: sequenceExecutor(probe, [
        { screenshot: FRAME, stateSignature: "a", url: "https://app.test/start", text: "x" },
        {
          screenshot: FRAME,
          stateSignature: "b",
          url: "https://app.test/done?x=1",
          text: "Thanks!",
        },
      ]),
      options: {
        stopWhen: { any: [{ id: "thanks", urlPathEquals: "/done", textIncludes: "Thanks" }] },
      },
    }),
    ...dwellScenarios,
  });
});

it("action and observation failures", async () => {
  await expectGoldenRuns("action-failures", {
    commandExitSkipped: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({ actions: [{ kind: "keypress", keys: ["Control", "-"] }, click(4, 4)] }),
        done("Zoom failed but I finished."),
      ]),
      executor: sequenceExecutor(probe, framed("s0", "s1", "s2"), (action) => {
        if (action.kind === "keypress") throw commandExit();
      }),
    }),
    everyActionFails: (probe) => {
      const zoom = turn({ actions: [{ kind: "keypress", keys: ["Control", "-"] }] });
      return {
        provider: scriptedProvider(probe, [zoom, zoom, zoom, zoom, zoom]),
        executor: sequenceExecutor(probe, framed("constant"), () => {
          throw commandExit();
        }),
        options: { noProgressSteps: 3 },
      };
    },
    actionRejected: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({ actions: [click(7, 7), { kind: "type", text: "secret words" }] }),
        done("Recovered."),
      ]),
      executor: sequenceExecutor(probe, framed("s0", "s0", "s1"), (action) => {
        if (action.kind === "click")
          throw new ComputerUseExecutorError("action_rejected", "not_dispatched");
      }),
    }),
    executorUncertain: (probe) => ({
      provider: scriptedProvider(probe, [turn({ actions: [{ kind: "type", text: "abc" }] })]),
      executor: sequenceExecutor(probe, framed("s0"), () => {
        throw new ComputerUseExecutorError("transport_failed", "outcome_uncertain");
      }),
    }),
    executeCrash: (probe) => ({
      provider: scriptedProvider(probe, [turn({ actions: [click(9, 9)] })]),
      executor: sequenceExecutor(probe, framed("s0"), () => {
        throw new TypeError("pointer driver exploded");
      }),
    }),
    providerCrash: (probe) => ({
      provider: scriptedProvider(probe, [
        () => {
          throw new Error("model narrated PROVISIONED-VALUE-123 then crashed");
        },
      ]),
      executor: sequenceExecutor(probe, framed("s0")),
      options: { scrubText: (text) => text.split("PROVISIONED-VALUE-123").join("[scrubbed]") },
    }),
    observeFailsAfterAction: (probe) => ({
      provider: scriptedProvider(probe, [turn({ actions: [click(1, 2)] })]),
      executor: sequenceExecutor(probe, [
        { screenshot: FRAME, stateSignature: "s0" },
        () => {
          throw new ComputerUseExecutorError("invalid_response", "outcome_uncertain");
        },
      ]),
    }),
    closingObserveFails: (probe) => ({
      provider: scriptedProvider(probe, [done("Reached the goal")]),
      executor: sequenceExecutor(probe, [
        { stateSignature: "s0", text: "start" },
        () => {
          throw new ComputerUseExecutorError("session_revoked", "outcome_uncertain");
        },
      ]),
      options: {
        tasks: [{ id: "t", goal: "Finish.", success: { any: [{ textIncludes: "end" }] } }],
      },
    }),
    closingObserveBestEffort: (probe) => ({
      provider: scriptedProvider(probe, [done("Reached the goal")]),
      executor: sequenceExecutor(probe, [
        { stateSignature: "s0", text: "start" },
        () => {
          throw new Error("ordinary closing observe failure");
        },
      ]),
      options: {
        tasks: [{ id: "t", goal: "Finish.", success: { any: [{ textIncludes: "end" }] } }],
      },
    }),
  });
});

it("stalled provider turns, observations and idle actions", async () => {
  const bounds = { turnTimeoutMs: 5, observationTimeoutMs: 5 };
  await expectGoldenRuns("stalls", {
    providerStallOnce: (probe) => ({
      provider: scriptedProvider(probe, [hang, done("Finished after a retry.")]),
      executor: sequenceExecutor(probe, framed("s0")),
      options: bounds,
    }),
    providerStallCancelsFirstRequest: (probe) => {
      let attempts = 0;
      const provider: CuaProvider = {
        id: "golden-cua",
        version: "golden-1",
        capabilities: CAPABILITIES,
        nextTurn(request, signal) {
          attempts += 1;
          const attempt = attempts;
          probe.push("provider.nextTurn", request);
          signal.addEventListener("abort", () => probe.push("provider.signal aborted", attempt), {
            once: true,
          });
          return attempt === 1 ? hang() : Promise.resolve(done("Finished after a retry."));
        },
      };
      return { provider, executor: sequenceExecutor(probe, framed("s0")), options: bounds };
    },
    providerStallTwice: (probe) => ({
      provider: scriptedProvider(probe, [hang, hang]),
      executor: sequenceExecutor(probe, framed("s0")),
      options: bounds,
    }),
    observeStallRetried: (probe) => ({
      provider: scriptedProvider(probe, [done("Finished.")]),
      executor: sequenceExecutor(probe, [hang, { screenshot: FRAME, stateSignature: "s0" }]),
      options: bounds,
    }),
    observeStallFailClosed: (probe) => ({
      provider: scriptedProvider(probe, [done("Finished.")]),
      executor: sequenceExecutor(probe, [hang], () => undefined, {
        stallRecovery: "fail_closed",
      }),
      options: bounds,
    }),
    idleWaitSkipped: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({ actions: [{ kind: "wait", ms: 1 }] }),
        done("Finished."),
      ]),
      executor: sequenceExecutor(probe, framed("s0", "s1"), (action) =>
        action.kind === "wait" ? hang() : undefined,
      ),
      options: bounds,
    }),
  });
});

it("provider interruptions", async () => {
  const interrupted =
    (interruption: NonNullable<CuaTurn["interruption"]>): LoopScenario =>
    (probe) => ({
      provider: scriptedProvider(probe, [
        turn({
          actions: [click(1, 1)],
          reasoning: "Half a thought",
          message: "Half a message",
          usage: { input: 50, output: 60 },
          interruption,
        }),
      ]),
      executor: sequenceExecutor(probe, framed("s0")),
      options: { overRunBudget: loggedBudget(probe, () => null) },
    });
  await expectGoldenRuns("interruptions", {
    outputLimit: interrupted("output_limit"),
    tokenLimit: interrupted("token_limit"),
    incomplete: interrupted("incomplete"),
    unexpectedStatus: interrupted("unexpected_status"),
    studyBudgetCrossedByInterruption: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({
          actions: [click(1, 1)],
          usage: { input: 900, output: 100 },
          interruption: "token_limit",
        }),
      ]),
      executor: sequenceExecutor(probe, framed("s0")),
      options: {
        overRunBudget: loggedBudget(probe, () => "study budget reached: $12.10 crossed $12"),
      },
    }),
  });
});

it("frame guard, abort, admission limit, account billing and spend guards", async () => {
  const paid = turn({ actions: [click(10, 20)], usage: { input: 100, output: 50 } });
  await expectGoldenRuns("harness-guards", {
    frameGuardInitial: (probe) => ({
      provider: scriptedProvider(probe, [], { requiresFrame: true }),
      executor: sequenceExecutor(probe, [{ stateSignature: "no-frame" }]),
    }),
    frameGuardAfterTurn: (probe) => ({
      provider: scriptedProvider(probe, [turn({ actions: [click(1, 1)] })], {
        requiresFrame: true,
      }),
      executor: sequenceExecutor(probe, [
        { screenshot: FRAME, stateSignature: "a" },
        { stateSignature: "b" },
      ]),
    }),
    abortedBeforeStart: (probe) => {
      const controller = new AbortController();
      controller.abort();
      return {
        provider: scriptedProvider(probe, [turn({ actions: [click(1, 1)] })]),
        executor: sequenceExecutor(probe, framed("s0")),
        options: { signal: controller.signal },
      };
    },
    abortedMidTurn: (probe) => {
      const controller = new AbortController();
      return {
        provider: scriptedProvider(probe, [
          () => {
            controller.abort();
            return turn({ actions: [click(1, 1)] });
          },
        ]),
        executor: sequenceExecutor(probe, framed("s0")),
        options: { signal: controller.signal },
      };
    },
    admissionLimit: (probe) => ({
      provider: scriptedProvider(probe, [
        () => {
          throw new ComputerUseAdmissionLimitError();
        },
      ]),
      executor: sequenceExecutor(probe, framed("s0")),
    }),
    accountBillingBeforeRun: (probe) => ({
      provider: scriptedProvider(probe, [], { executionProfile: PARTICIPANT_PROFILE }),
      executor: sequenceExecutor(probe, framed("s0")),
      options: { maxUsd: 1 },
    }),
    accountBillingLearnedMidRun: (probe) => {
      let authenticated = false;
      const provider: CuaProvider = {
        id: "operator-account",
        capabilities: CAPABILITIES,
        get executionProfile() {
          return authenticated ? PARTICIPANT_PROFILE : undefined;
        },
        async nextTurn(request) {
          probe.push("provider.nextTurn", request);
          authenticated = true;
          return turn({ actions: [click(1, 1)], usage: { input: 5, output: 1 } });
        },
      };
      return {
        provider,
        executor: sequenceExecutor(probe, framed("s0")),
        options: { maxUsd: 1, estimateTurnCostUsd: loggedEstimator(probe, () => 0) },
      };
    },
    accountBillingLearnedMidRunOutputCap: (probe) => {
      let authenticated = false;
      const provider: CuaProvider = {
        id: "operator-account",
        capabilities: CAPABILITIES,
        modelSettings: { reasoningEffort: "low", maxOutputTokens: 1000 },
        get executionProfile() {
          return authenticated ? PARTICIPANT_PROFILE : undefined;
        },
        async nextTurn(request) {
          probe.push("provider.nextTurn", request);
          if (authenticated) return done("Finished.");
          authenticated = true;
          return turn({ actions: [click(1, 1)] });
        },
      };
      return { provider, executor: sequenceExecutor(probe, framed("s0", "s1")) };
    },
    nonFiniteEstimate: (probe) => ({
      provider: scriptedProvider(probe, [paid]),
      executor: sequenceExecutor(probe, framed("s0", "s1")),
      options: { maxUsd: 0.35, estimateTurnCostUsd: loggedEstimator(probe, () => Number.NaN) },
    }),
    zeroActionSpendCap: (probe) => ({
      provider: scriptedProvider(probe, [paid]),
      executor: sequenceExecutor(probe, framed("s0", "s1")),
      options: { maxUsd: 0, estimateTurnCostUsd: loggedEstimator(probe, () => 0.15) },
    }),
    nullEstimate: (probe) => ({
      provider: scriptedProvider(probe, [paid, done("Finished.")]),
      executor: sequenceExecutor(probe, framed("s0", "s1")),
      options: { maxUsd: 0.01, estimateTurnCostUsd: loggedEstimator(probe, () => null) },
    }),
  });
});

it("continuing provider requests and account usage", async () => {
  const pending = (action: CuaTurn["actions"][number]): CuaTurn =>
    turn({ providerRequestPending: true, actions: [action] });
  const continuing = (
    probe: Probe,
    steps: Array<{ turn: CuaTurn; usage?: CuaTurn["usage"] }>,
  ): CuaProvider => {
    let call = 0;
    let active = false;
    let usage: CuaTurn["usage"];
    return {
      id: "continuing-synthetic",
      requestPolicy: "fail_closed",
      capabilities: CAPABILITIES,
      get interactionUsageIncomplete() {
        return active;
      },
      get pendingRequestUsage() {
        return usage;
      },
      async nextTurn(request) {
        probe.push("provider.nextTurn", request);
        const step = steps[Math.min(call, steps.length - 1)];
        call += 1;
        if (step === undefined) throw new Error("no steps");
        active = step.turn.providerRequestPending === true;
        usage = step.usage;
        return structuredClone(step.turn);
      },
    };
  };
  const estimate = (usage: { input?: number; output?: number }) =>
    ((usage.input ?? 0) + (usage.output ?? 0)) / 100;
  await expectGoldenRuns("continuing-requests", {
    twoCyclesThenTerminal: (probe) => ({
      provider: continuing(probe, [
        { turn: pending(click(12, 18)), usage: { input: 10, output: 2 } },
        { turn: pending({ kind: "keypress", keys: ["ENTER"] }), usage: { input: 18, output: 3 } },
        {
          turn: done("Finished.", {
            providerRequest: receipt,
            outcome: "reached",
            usage: { input: 20, output: 4 },
          }),
        },
      ]),
      executor: sequenceExecutor(probe, framed("0", "1", "2")),
      options: {
        maxUsd: 1,
        estimateTurnCostUsd: loggedEstimator(probe, estimate),
        requireReportedUsageForSpendCap: true,
      },
    }),
    pendingUsageCrossesCap: (probe) => ({
      provider: continuing(probe, [
        { turn: pending(click(1, 2)), usage: { input: 20, output: 1, cachedInput: 0 } },
      ]),
      executor: sequenceExecutor(probe, framed("ready")),
      options: {
        maxUsd: 0.1,
        estimateTurnCostUsd: loggedEstimator(probe, estimate),
        requireReportedUsageForSpendCap: true,
      },
    }),
    invalidPendingYield: (probe) => ({
      provider: continuing(probe, [{ turn: { ...pending(click(1, 2)), done: true } }]),
      executor: sequenceExecutor(probe, framed("ready")),
      options: { turnTimeoutMs: 50 },
    }),
    accountUsageRecorded: (probe) => ({
      provider: scriptedProvider(
        probe,
        [
          turn({
            actions: [click(1, 1)],
            providerRequest: receipt,
            usage: {
              input: 10,
              output: 2,
              turns: [
                { input: 4, output: 1 },
                { input: 6, output: 1 },
              ],
            },
          }),
          done("Finished.", { providerRequest: receipt, usage: { input: 7 } }),
        ],
        { requestPolicy: "fail_closed", executionProfile: PARTICIPANT_PROFILE },
      ),
      executor: sequenceExecutor(probe, framed("0", "1")),
    }),
  });
});

it("speech, app state, scroll, redacted frames and scrubbed narration", async () => {
  const png = realPng();
  await expectGoldenRuns("observation-inputs", {
    speechHeard: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({ actions: [{ kind: "wait", ms: 1 }] }),
        turn({ actions: [{ kind: "speak", text: "Hello PRIVATE" }] }),
        done("Done after replying."),
      ]),
      executor: sequenceExecutor(
        probe,
        [
          { screenshot: FRAME, stateSignature: "same" },
          {
            screenshot: FRAME,
            stateSignature: "same",
            heardSpeech: [
              { id: "u1", source: "speaker_audio", text: "My code is PRIVATE", durationMs: 700 },
            ],
          },
          { screenshot: FRAME, stateSignature: "same" },
        ],
        () => undefined,
        { speechEnabled: true },
      ),
      options: {
        scrubText: (text) => text.replaceAll("PRIVATE", "[scrubbed]"),
        idleSteps: 1,
        noProgressSteps: 2,
      },
    }),
    stateExecutor: (probe) => ({
      provider: scriptedProvider(
        probe,
        [
          turn({ actions: [click(1, 1)] }),
          turn({ actions: [click(1, 1)] }),
          turn({ actions: [click(1, 1)] }),
          turn({ actions: [click(1, 1)] }),
        ],
        { modelSettings: { reasoningEffort: "low", maxOutputTokens: 2048 } },
      ),
      executor: sequenceExecutor(probe, [
        { stateSignature: "c", appState: { b: 1, a: { route: "/one" } } },
        { stateSignature: "c", appState: { a: { route: "/two" }, b: 1 } },
        { stateSignature: "c", appState: { b: 1, a: { route: "/two" } } },
        { stateSignature: "c", appState: { b: 1, a: { route: "/two" } }, scrollY: 450 },
        { stateSignature: "c", appState: { b: 1, a: { route: "/two" } }, scrollY: 460 },
      ]),
      options: { noProgressSteps: 2 },
    }),
    closingAppState: (probe) => ({
      provider: scriptedProvider(probe, [done("Reached the goal")]),
      executor: sequenceExecutor(probe, [
        { stateSignature: "s0" },
        { stateSignature: "s1", appState: { route: "/done" } },
      ]),
      options: {
        tasks: [
          {
            id: "t",
            goal: "Finish.",
            success: { any: [{ appStatePathEquals: { path: "route", equals: "/done" } }] },
          },
        ],
      },
    }),
    redactedFrames: (probe) => ({
      provider: scriptedProvider(probe, [
        turn({
          actions: [
            { kind: "double_click", x: 3, y: 4 },
            { kind: "move", x: 5, y: 6 },
          ],
          reasoning: "The token is PROVISIONED-VALUE-123",
        }),
        done("Finished with PROVISIONED-VALUE-123."),
      ]),
      executor: sequenceExecutor(probe, [
        { screenshot: png, stateSignature: "a" },
        { screenshot: png, stateSignature: "b" },
      ]),
      options: {
        redactScreenshots: true,
        scrubText: (text) => text.split("PROVISIONED-VALUE-123").join("[scrubbed]"),
      },
    }),
  });
});
