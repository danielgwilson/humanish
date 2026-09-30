import { expect, it } from "vitest";

import {
  runComputerUseLoop,
  type CuaExecutor,
  type CuaLoopOptions,
  type CuaProvider,
  type CuaTurn,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { CAPABILITIES, FRAME, click, done, turn } from "../../helpers/loop-golden.js";

// Behavior the goldens do not reach: how the loop calls injected functions, when it reads its
// options, and what survives a failure while it records a terminal item.

const receipt = { dispatched: true, usageComplete: true, cleanup: "confirmed" } as const;

// A provider written as a class: its methods read their state through `this`.
class MethodProvider implements CuaProvider {
  readonly id = "method-provider";
  readonly capabilities = CAPABILITIES;
  readonly requestPolicy?: "fail_closed";
  private readonly summary = "Summarized through the provider's own state.";
  private readonly settled: Partial<CuaTurn>;
  constructor(requestPolicy?: "fail_closed") {
    if (requestPolicy !== undefined) this.requestPolicy = requestPolicy;
    this.settled =
      requestPolicy === undefined
        ? {}
        : { providerRequest: receipt, usage: { input: 1, output: 1 } };
  }
  async nextTurn(): Promise<CuaTurn> {
    return turn({ actions: [click(1, 1)], ...this.settled });
  }
  async debrief(): Promise<CuaTurn> {
    return done("Closing.", {
      closingReport: { summary: this.summary, frictionReports: [] },
      ...this.settled,
    });
  }
}

function provider(turns: CuaTurn[], extra: Partial<CuaProvider> = {}): CuaProvider {
  let index = 0;
  return {
    id: "fidelity",
    capabilities: CAPABILITIES,
    ...extra,
    async nextTurn() {
      const next = turns[index] ?? done("done (exhausted)");
      index += 1;
      return structuredClone(next);
    },
  };
}

function executor(observations: Array<{ stateSignature: string; text?: string }>): CuaExecutor & {
  executed: number;
} {
  let index = 0;
  return {
    executed: 0,
    async observe() {
      const next = observations[Math.min(index, observations.length - 1)];
      index += 1;
      return {
        screenshot: FRAME,
        stateSignature: next?.stateSignature ?? "s",
        ...(next?.text === undefined ? {} : { text: next.text }),
      };
    },
    async execute() {
      this.executed += 1;
    },
  };
}

/** A clock that advances 1 ms per read and throws once when armed. */
function armedClock() {
  let t = 0;
  let armed = false;
  return {
    arm: () => {
      armed = true;
    },
    advance: (ms: number) => {
      t += ms;
    },
    now: () => {
      if (armed) {
        armed = false;
        throw new Error("clock unavailable once");
      }
      return (t += 1);
    },
  };
}

const base = (overrides: Partial<CuaLoopOptions>): CuaLoopOptions => ({
  instructions: "Finish the synthetic task.",
  provider: provider([]),
  executor: executor([{ stateSignature: "s" }]),
  persona: { id: "fidelity", traitsApplied: [], promptDigest: "fidelity" },
  redaction: defaultRedactionHooks,
  timeoutMs: 10_000_000,
  now: armedClock().now,
  ...overrides,
});

it("calls every injected function without a receiver", async () => {
  const receivers = new Map<string, unknown>();
  const note = (name: string, self: unknown) => {
    if (!receivers.has(name) || self !== undefined) receivers.set(name, self);
  };
  let t = 0;
  const result = await runComputerUseLoop(
    base({
      provider: provider([
        turn({
          actions: [click(1, 1)],
          message: "Looking",
          pendingSafetyChecks: [{ id: "c", code: "check", message: "m" }],
          // Reported so the capped session reaches its second turn.
          usage: { input: 1, output: 1 },
        }),
        done("Finished."),
      ]),
      executor: executor([{ stateSignature: "a" }, { stateSignature: "b", text: "video" }]),
      maxUsd: 10,
      dwell: {
        when: { any: [{ textIncludes: "video" }] },
        ms: 20,
        everyMs: 10,
        then: "continue",
      },
      now: function (this: unknown) {
        note("now", this);
        return (t += 1);
      },
      scrubText: function (this: unknown, text: string) {
        note("scrubText", this);
        return text;
      },
      writeScreenshot: async function (this: unknown, name: string) {
        note("writeScreenshot", this);
        return `screenshots/${name}`;
      },
      sleep: async function (this: unknown, ms: number) {
        note("sleep", this);
        t += ms;
      },
      acknowledgeSafetyChecks: function (this: unknown, checks) {
        note("acknowledgeSafetyChecks", this);
        return checks;
      },
      estimateTurnCostUsd: function (this: unknown) {
        note("estimateTurnCostUsd", this);
        return 0;
      },
      overRunBudget: function (this: unknown) {
        note("overRunBudget", this);
        return null;
      },
      onTrace: function (this: unknown) {
        note("onTrace", this);
      },
      onMessage: function (this: unknown) {
        note("onMessage", this);
      },
      onObservedUrl: function (this: unknown) {
        note("onObservedUrl", this);
      },
      onScreenshot: function (this: unknown) {
        note("onScreenshot", this);
      },
    }),
  );
  expect(result.completionReason).toBe("goal_satisfied");
  expect([...receivers.keys()].sort()).toEqual(
    [
      "acknowledgeSafetyChecks",
      "estimateTurnCostUsd",
      "now",
      "onMessage",
      "onObservedUrl",
      "onScreenshot",
      "onTrace",
      "overRunBudget",
      "scrubText",
      "sleep",
      "writeScreenshot",
    ].sort(),
  );
  expect([...receivers.values()].every((self) => self === undefined)).toBe(true);
});

it.each([
  ["default", undefined],
  ["fail_closed", "fail_closed"],
] as const)(
  "calls provider methods with the provider as receiver (%s requests)",
  async (_name, requestPolicy) => {
    const result = await runComputerUseLoop(
      base({
        provider: new MethodProvider(requestPolicy),
        executor: executor([{ stateSignature: "a" }, { stateSignature: "b", text: "saved" }]),
        stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] },
      }),
    );
    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.debrief).toMatchObject({
      status: "completed",
      report: { summary: "Summarized through the provider's own state." },
    });
  },
);

it("reads its options once, at entry", async () => {
  const seen: string[] = [];
  const exec = executor([{ stateSignature: "a" }, { stateSignature: "b" }]);
  const options: CuaLoopOptions = base({
    provider: {
      ...provider([turn({ actions: [click(1, 1)], usage: { input: 1, output: 1 } })]),
      async nextTurn(request) {
        seen.push(request.instructions);
        return turn({ actions: [click(1, 1)], usage: { input: 1, output: 1 } });
      },
    },
    executor: {
      ...exec,
      observe: async () => {
        delete options.maxUsd;
        options.instructions = "Mutated mid-run.";
        return { screenshot: FRAME, stateSignature: "a" };
      },
    },
    maxUsd: 1,
    estimateTurnCostUsd: () => 2,
  });
  const result = await runComputerUseLoop(options);
  expect(result.completionReason).toBe("budget_reached");
  expect(result.trace.stopCause).toBe("spend_limit");
  expect(result.trace.counts.actions).toBe(0);
  expect(seen).toEqual(["Finish the synthetic task."]);
});

it("returns actor_error when stamping a blocked safety check fails", async () => {
  const clock = armedClock();
  const result = await runComputerUseLoop(
    base({
      provider: provider([
        turn({
          actions: [click(1, 1)],
          pendingSafetyChecks: [{ id: "c", code: "check", message: "m" }],
        }),
      ]),
      now: clock.now,
      acknowledgeSafetyChecks: () => {
        clock.arm();
        return null;
      },
    }),
  );
  expect(result.completionReason).toBe("actor_error");
  expect(result.trace.items.map((item) => item.id)).toEqual(["screenshot-001", "notice-003"]);
  expect(result.trace.items.at(-1)?.text).toContain("clock unavailable once");
});

it("keeps the closing request when stamping the stopWhen notice fails", async () => {
  const clock = armedClock();
  let debriefs = 0;
  const result = await runComputerUseLoop(
    base({
      provider: provider([turn({ actions: [click(1, 1)] })], {
        debrief: async () => {
          debriefs += 1;
          return done("Closing.", {
            closingReport: { summary: "I saved it.", frictionReports: [] },
          });
        },
      }),
      executor: executor([{ stateSignature: "a" }, { stateSignature: "b", text: "saved" }]),
      now: clock.now,
      stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] },
      scrubText: (text) => {
        if (text.startsWith("Harness stop condition")) clock.arm();
        return text;
      },
    }),
  );
  expect(result.completionReason).toBe("actor_error");
  expect(debriefs).toBe(1);
  expect(result.trace.debrief).toMatchObject({ trigger: "stop_when", status: "completed" });
});

it("keeps a stop cause committed before its notice failed to record", async () => {
  const clock = armedClock();
  const result = await runComputerUseLoop(
    base({
      provider: provider([turn({ actions: [click(1, 1)], interruption: "token_limit" })]),
      now: clock.now,
      overRunBudget: () => {
        clock.arm();
        return null;
      },
    }),
  );
  expect(result.completionReason).toBe("actor_error");
  expect(result.trace.stopCause).toBe("provider_token_limit");
});

it("keeps the declared outcome when redacting the closing summary fails", async () => {
  let fail = true;
  const result = await runComputerUseLoop(
    base({
      // The message is recorded untrimmed first; only the trimmed summary fails.
      provider: provider([done("  Did not reach the goal  ")]),
      scrubText: (text) => {
        if (fail && text === "Did not reach the goal") {
          fail = false;
          throw new Error("scrub failed once");
        }
        return text;
      },
    }),
  );
  expect(result.completionReason).toBe("actor_error");
  expect(result.trace.declaredOutcome).toBe("not_reached");
});

it("records the usage-unavailable notice before releasing the strict request", async () => {
  const clock = armedClock();
  const result = await runComputerUseLoop(
    base({
      provider: {
        ...provider([]),
        async nextTurn(_request, signal) {
          signal.addEventListener("abort", () => clock.advance(1_000_000));
          throw new Error("transport failed without usage");
        },
      },
      now: clock.now,
      maxUsd: 1,
      estimateTurnCostUsd: () => 0,
      requireReportedUsageForSpendCap: true,
    }),
  );
  expect(result.trace.stopCause).toBe("usage_unreported");
  const notice = result.trace.items.find((item) => item.title === "provider usage unavailable");
  expect(Date.parse(notice?.at ?? "")).toBeLessThan(1_000_000);
});

it("allocates a trace id before redacting the item's text", async () => {
  let fail = true;
  const result = await runComputerUseLoop(
    base({
      provider: provider([turn({ actions: [click(1, 1)], message: "Looking around" })]),
      scrubText: (text) => {
        if (fail && text === "Looking around") {
          fail = false;
          throw new Error("scrub failed once");
        }
        return text;
      },
    }),
  );
  expect(result.completionReason).toBe("actor_error");
  expect(result.trace.items.map((item) => item.id)).toEqual(["screenshot-001", "notice-003"]);
});
