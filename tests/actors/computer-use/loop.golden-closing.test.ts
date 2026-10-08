import { it } from "vitest";

import { ComputerUseAdmissionLimitError } from "../../../src/actors/computer-use/admission-limit.js";
import { ComputerUseProviderError } from "../../../src/actors/computer-use/provider-error.js";
import type {
  CuaLoopOptions,
  CuaProvider,
  CuaTurn,
  CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import {
  Probe,
  baseOptions,
  done,
  expectGolden,
  loggedBudget,
  loggedEstimator,
  outcome,
  scriptedProvider,
  sequenceExecutor,
  turn,
} from "../../helpers/loop-golden.js";

// Closing-request goldens: every way the read-only report after a structured stop can end.

const receipt = { dispatched: true, usageComplete: true, cleanup: "confirmed" } as const;
const report = "The Save button did nothing.";
const closing = (patch: Partial<CuaTurn> = {}): CuaTurn =>
  done(report, {
    usage: { input: 20, output: 10 },
    closingReport: { summary: "I renamed the item.", frictionReports: [report] },
    ...patch,
  });

interface Variant {
  debrief?: (request: CuaTurnRequest, signal: AbortSignal) => Promise<CuaTurn>;
  provider?: Partial<Omit<CuaProvider, "nextTurn" | "debrief">>;
  interaction?: Partial<CuaTurn>;
  /** The interaction turn reports no usage at all. */
  withoutUsage?: true;
  options?: Partial<CuaLoopOptions>;
}

async function closingRun(probe: Probe, variant: Variant): Promise<unknown> {
  let saved = false;
  const provider = scriptedProvider(
    probe,
    [
      turn({
        actions: [{ kind: "keypress", keys: ["ENTER"] }],
        responseId: "previous",
        ...(variant.withoutUsage ? {} : { usage: { input: 10, output: 5 } }),
        ...variant.interaction,
      }),
    ],
    {
      ...variant.provider,
      ...(variant.debrief === undefined
        ? {}
        : {
            debrief: async (request: CuaTurnRequest, signal: AbortSignal) => {
              probe.push("provider.debrief", request);
              return variant.debrief!(request, signal);
            },
          }),
    },
  );
  const executor = sequenceExecutor(
    probe,
    [() => ({ stateSignature: saved ? "1" : "0", text: saved ? "saved" : "editing" })],
    () => {
      saved = true;
    },
  );
  let t = 0;
  return outcome(
    probe,
    baseOptions(probe, provider, executor, {
      now: () => (t += 1),
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 10_000,
      ...(variant.options?.dwell === undefined
        ? { stopWhen: { any: [{ id: "hidden-rule", textIncludes: "saved" }] } }
        : {}),
      ...variant.options,
    }),
  );
}

it("closing request variants", async () => {
  const variants: Record<string, Variant> = {
    dwellTrigger: {
      debrief: async () => closing(),
      options: {
        dwell: { when: { any: [{ textIncludes: "saved" }] }, ms: 100, everyMs: 50, then: "stop" },
      },
    },
    noDebriefSupport: {},
    requestsActions: {
      debrief: async () => closing({ actions: [{ kind: "click", x: 0, y: 0 }] }),
    },
    invalidReport: {
      debrief: async () => closing({ closingReport: { summary: "", frictionReports: [] } }),
    },
    partialUsage: { debrief: async () => closing({ usage: { input: 20 } }) },
    admissionRefused: {
      debrief: async () => {
        throw new ComputerUseAdmissionLimitError();
      },
    },
    thrownError: {
      debrief: async () => {
        throw new Error("provider unavailable");
      },
    },
    hungUntilDeadline: {
      debrief: (_request, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      options: { turnTimeoutMs: 5 },
    },
    estimateAtCap: {
      debrief: async () => closing(),
      options: { maxUsd: 0.5, estimateTurnCostUsd: () => 0.5 },
    },
    nullEstimate: {
      debrief: async () => closing(),
      options: { maxUsd: 0.5, estimateTurnCostUsd: () => null },
    },
    priorUsageUnknown: {
      debrief: async () => closing(),
      withoutUsage: true,
      options: { maxUsd: 0.5, estimateTurnCostUsd: () => 0.01 },
    },
    studyBudgetCrossedByReport: {
      debrief: async () => closing(),
      options: {},
    },
    failClosedError: {
      debrief: async () => {
        throw new ComputerUseProviderError("invalid_response", receipt, { input: 4, output: 2 });
      },
      provider: { requestPolicy: "fail_closed" },
      interaction: { providerRequest: receipt },
    },
    failClosedCleanupUnconfirmed: {
      debrief: async () => {
        throw new ComputerUseProviderError(
          "cleanup_unconfirmed",
          { ...receipt, cleanup: "unconfirmed", usageComplete: false },
          { input: 4 },
        );
      },
      provider: { requestPolicy: "fail_closed" },
      interaction: { providerRequest: receipt },
    },
    failClosedCompleted: {
      debrief: async () => closing({ providerRequest: receipt }),
      provider: { requestPolicy: "fail_closed" },
      interaction: { providerRequest: receipt },
    },
  };
  const runs: Record<string, unknown> = {};
  for (const [name, variant] of Object.entries(variants)) {
    const probe = new Probe();
    if (name === "studyBudgetCrossedByReport") {
      variant.options = {
        overRunBudget: loggedBudget(probe, (call) => (call >= 3 ? "spent" : null)),
        maxUsd: 1,
        estimateTurnCostUsd: loggedEstimator(probe, (usage) => (usage.input ?? 0) / 20),
      };
    }
    runs[name] = await closingRun(probe, variant);
  }
  await expectGolden("closing-variants", runs);
});

// The impressions request: the participant ended the session itself without impressions, so the
// loop asks for impressions alone.

async function impressionsRun(
  probe: Probe,
  requestImpressions: (request: CuaTurnRequest, signal: AbortSignal) => Promise<CuaTurn>,
  options: Partial<CuaLoopOptions> = {},
): Promise<unknown> {
  const provider = scriptedProvider(probe, [done(report, { usage: { input: 10, output: 5 } })], {
    requestImpressions: async (request: CuaTurnRequest, signal: AbortSignal) => {
      probe.push("provider.requestImpressions", request);
      return requestImpressions(request, signal);
    },
  });
  const executor = sequenceExecutor(probe, [() => ({ stateSignature: "0", text: "editing" })]);
  let t = 0;
  return outcome(
    probe,
    baseOptions(probe, provider, executor, {
      now: () => (t += 1),
      sleep: async (ms) => {
        t += ms;
      },
      timeoutMs: 10_000,
      ...options,
    }),
  );
}

it("impressions request variants", async () => {
  const reply = (patch: Partial<CuaTurn> = {}): CuaTurn =>
    turn({ done: true, usage: { input: 20, output: 10 }, ...patch });
  const variants: Record<
    string,
    [(request: CuaTurnRequest, signal: AbortSignal) => Promise<CuaTurn>, Partial<CuaLoopOptions>?]
  > = {
    completed: [
      async () => reply({ impressions: [{ kind: "liked", text: "Enter saved the name." }] }),
    ],
    cutOff: [async () => reply({ interruption: "output_limit" })],
    invalidImpressions: [
      async () => reply({ impressions: [{ kind: "liked", text: "x".repeat(501) }] }),
    ],
    requestsActions: [async () => reply({ actions: [{ kind: "click", x: 0, y: 0 }] })],
    thrownError: [
      async () => {
        throw new Error("provider unavailable");
      },
    ],
    hungUntilDeadline: [
      (_request, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      { turnTimeoutMs: 5 },
    ],
    estimateAtCap: [async () => reply(), { maxUsd: 0.5, estimateTurnCostUsd: () => 0.5 }],
  };
  const runs: Record<string, unknown> = {};
  for (const [name, [requestImpressions, options]] of Object.entries(variants))
    runs[name] = await impressionsRun(new Probe(), requestImpressions, options);
  await expectGolden("closing-impressions", runs);
});
