import { it } from "vitest";

import { ComputerUseProviderError } from "../../../src/actors/computer-use/provider-error.js";
import type { ActorTokenUsage } from "../../../src/actors/contract.js";
import {
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
} from "../../helpers/loop-golden.js";

// Characterization of runComputerUseLoop: one golden per representative session. Each golden holds
// the full CuaLoopResult and the ordered port calls. A diff here means the loop's behavior changed.

const perToken = (usage: ActorTokenUsage): number =>
  ((usage.input ?? 0) + (usage.output ?? 0)) * 0.001;
const receipt = { dispatched: true, usageComplete: true, cleanup: "confirmed" } as const;

it("goal satisfied: acts, narrates, and ends on a natural endpoint", async () => {
  const probe = new Probe();
  const provider = scriptedProvider(probe, [
    turn({
      actions: [click(10, 20)],
      reasoning: "Looking for the booking form.",
      responseId: "r1",
      usage: { input: 100, output: 20, cachedInput: 10 },
    }),
    turn({
      actions: [
        { kind: "type", text: "hello@example.test" },
        { kind: "wait", ms: 50 },
      ],
      message: "Typing the email.",
      responseId: "r2",
      usage: { input: 120, output: 30 },
    }),
    done("Booked the appointment.", { responseId: "r3", usage: { input: 130, output: 10 } }),
  ]);
  const executor = sequenceExecutor(probe, framed("s0", "s1", "s2", "s3"));
  await expectGolden(
    "goal-satisfied",
    await outcome(probe, baseOptions(probe, provider, executor)),
  );
});

it("gave up: the participant declares it did not reach the goal", async () => {
  const probe = new Probe();
  const provider = scriptedProvider(probe, [
    turn({ actions: [click(5, 5)], responseId: "r1" }),
    done("Did not reach the goal.\nThe form never loaded.", { responseId: "r2" }),
  ]);
  const executor = sequenceExecutor(probe, [
    { screenshot: Buffer.from("f0"), stateSignature: "s0", text: "loading" },
    { screenshot: Buffer.from("f1"), stateSignature: "s1", text: "still loading" },
    { screenshot: Buffer.from("f2"), stateSignature: "s2", text: "form loaded" },
  ]);
  const options = baseOptions(probe, provider, executor, {
    tasks: [
      {
        id: "open-form",
        goal: "Open the form.",
        success: { any: [{ textIncludes: "form loaded" }] },
      },
    ],
  });
  await expectGolden("gave-up-declared", await outcome(probe, options));
});

it("idle backstop: only screenshots and waits until the streak trips", async () => {
  const probe = new Probe();
  const idle = turn({ actions: [{ kind: "screenshot" }] });
  const provider = scriptedProvider(probe, [idle, idle, idle, idle, idle, idle]);
  const executor = sequenceExecutor(probe, framed("same"));
  const options = baseOptions(probe, provider, executor, { idleSteps: 3 });
  await expectGolden("idle-backstop", await outcome(probe, options));
});

it("no-progress backstop: the same click against a stale frame, nudged first", async () => {
  const probe = new Probe();
  const stuck = turn({ actions: [click(301, 486)] });
  const provider = scriptedProvider(probe, [stuck, stuck, stuck, stuck, stuck, stuck]);
  const executor = sequenceExecutor(probe, framed("same"));
  const options = baseOptions(probe, provider, executor, { noProgressSteps: 3 });
  await expectGolden("no-progress-backstop", await outcome(probe, options));
});

it("budget reached: the running estimate crosses maxUsd before the next turn", async () => {
  const probe = new Probe();
  const paid = turn({ actions: [click(10, 20)], usage: { input: 100, output: 50 } });
  const provider = scriptedProvider(probe, [paid, paid, paid, paid, paid]);
  const executor = sequenceExecutor(probe, framed("s0", "s1", "s2", "s3", "s4", "s5"));
  const options = baseOptions(probe, provider, executor, {
    maxUsd: 0.35,
    estimateTurnCostUsd: loggedEstimator(probe, perToken),
  });
  await expectGolden("budget-reached-max-usd", await outcome(probe, options));
});

it("study budget: overRunBudget stops the participant as budget_reached", async () => {
  const probe = new Probe();
  const paid = turn({ actions: [click(10, 20)], usage: { input: 1000, output: 50 } });
  const provider = scriptedProvider(probe, [paid, paid, paid, paid, paid]);
  const executor = sequenceExecutor(probe, framed("s0", "s1", "s2", "s3", "s4", "s5"));
  const options = baseOptions(probe, provider, executor, {
    overRunBudget: loggedBudget(probe, (call) =>
      call >= 3 ? "study budget reached: $12.10 crossed execution.caps.maxTotalUsd=$12" : null,
    ),
  });
  await expectGolden("study-budget", await outcome(probe, options));
});

it("provider error: a single-dispatch provider fails after one settled turn", async () => {
  const probe = new Probe();
  const provider = scriptedProvider(
    probe,
    [
      turn({ actions: [click(1, 2)], usage: { input: 10, output: 2 }, providerRequest: receipt }),
      () => {
        throw new ComputerUseProviderError(
          "timeout",
          { dispatched: false, usageComplete: false, cleanup: "confirmed" },
          { input: 3 },
          "turn/start",
        );
      },
    ],
    { requestPolicy: "fail_closed", historyTurnsOmitted: 2 },
  );
  const executor = sequenceExecutor(probe, framed("s0", "s1"));
  await expectGolden(
    "provider-error",
    await outcome(probe, baseOptions(probe, provider, executor)),
  );
});

it("usage unreported: a capped strict route stops on a turn without usage", async () => {
  const probe = new Probe();
  const provider = scriptedProvider(probe, [turn({ actions: [click(1, 1)] })], {
    debrief: async (request) => {
      probe.push("provider.debrief", request);
      return done("unexpected");
    },
  });
  const executor = sequenceExecutor(probe, framed("s0", "s1"));
  const options = baseOptions(probe, provider, executor, {
    maxUsd: 1,
    estimateTurnCostUsd: loggedEstimator(probe, () => 0),
    requireReportedUsageForSpendCap: true,
  });
  await expectGolden("usage-unreported", await outcome(probe, options));
});

it("closing request: stopWhen ends the session and one read-only report is collected", async () => {
  const probe = new Probe();
  let saved = false;
  const provider = scriptedProvider(
    probe,
    [
      turn({
        actions: [{ kind: "keypress", keys: ["ENTER"] }],
        responseId: "previous",
        usage: { input: 10, output: 5 },
      }),
    ],
    {
      debrief: async (request) => {
        probe.push("provider.debrief", request);
        return done("The Save button did nothing.", {
          usage: { input: 20, output: 10 },
          responseId: "closing",
          closingReport: {
            summary: " I renamed the item. ",
            frictionReports: ["The Save button did nothing.", "The Save button did nothing."],
          },
        });
      },
    },
  );
  const executor = sequenceExecutor(
    probe,
    [() => ({ stateSignature: saved ? "1" : "0", text: saved ? "saved" : "editing" })],
    () => {
      saved = true;
    },
  );
  const options = baseOptions(probe, provider, executor, {
    stopWhen: { any: [{ id: "hidden-rule", textIncludes: "saved" }] },
    tasks: [
      { id: "rename", goal: "Rename the item.", success: { any: [{ textIncludes: "saved" }] } },
    ],
    maxUsd: 1,
    estimateTurnCostUsd: loggedEstimator(probe, perToken),
  });
  await expectGolden("closing-request", await outcome(probe, options));
});

it("timeouts: after progress, with no progress, on a hung provider, and mid-action", async () => {
  const runs: Record<string, unknown> = {};
  for (const [name, action] of [
    ["afterProgress", click(1, 1)],
    ["noProgress", { kind: "wait", ms: 10 }],
  ] as const) {
    const probe = new Probe();
    let t = 0;
    const provider = scriptedProvider(probe, [
      () => {
        t = 1000;
        return turn({ actions: [action] });
      },
    ]);
    const executor = sequenceExecutor(probe, framed("s0", "s1"));
    runs[name] = await outcome(
      probe,
      baseOptions(probe, provider, executor, { timeoutMs: 100, now: () => t }),
    );
  }
  {
    const probe = new Probe();
    const provider = scriptedProvider(probe, [() => new Promise(() => {})]);
    const executor = sequenceExecutor(probe, framed("s0"));
    runs.hungProvider = await outcome(
      probe,
      baseOptions(probe, provider, executor, { timeoutMs: 30, now: () => 0 }),
    );
  }
  {
    const probe = new Probe();
    const provider = scriptedProvider(probe, [turn({ actions: [click(3, 4)] })]);
    const executor = sequenceExecutor(probe, framed("s0"), () => new Promise(() => {}));
    runs.hungAction = await outcome(
      probe,
      baseOptions(probe, provider, executor, { timeoutMs: 30, now: () => 0 }),
    );
  }
  await expectGolden("timeouts", runs);
});
