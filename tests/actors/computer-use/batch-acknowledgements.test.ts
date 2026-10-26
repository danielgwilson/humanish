import { describe, expect, it, vi } from "vitest";

import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaLoopOptions,
  type CuaProvider,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

// What a provider learns about each action of its last batch: every request after a batch carries
// one acknowledgement per batch position, whatever the provider's request policy.

const click: CuaAction = { kind: "click", x: 10, y: 20 };
const typing: CuaAction = { kind: "type", text: "synthetic-entry" };
const submit: CuaAction = { kind: "keypress", keys: ["Enter"] };

const turn = (patch: Partial<CuaTurn>): CuaTurn => ({
  actions: [],
  pendingSafetyChecks: [],
  done: false,
  ...patch,
});

/** A provider that replays `turns`, then ends, and keeps every request it was sent. */
function scripted(turns: CuaTurn[], extra: Partial<CuaProvider> = {}) {
  const requests: CuaTurnRequest[] = [];
  const provider: CuaProvider = {
    id: "fixture",
    version: "1",
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: false,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    },
    nextTurn: async (request) => {
      requests.push(structuredClone(request));
      return turns.shift() ?? turn({ done: true, message: "Reached the goal." });
    },
    ...extra,
  };
  return { provider, requests };
}

/** An executor whose screen changes after every action, so no backstop trips. */
function desktop(execute: CuaExecutor["execute"] = async () => {}) {
  let frame = 0;
  return {
    observe: async () => ({ stateSignature: `frame-${frame}` }),
    execute: vi.fn(async (action: CuaAction, signal?: AbortSignal) => {
      frame += 1;
      await execute(action, signal);
    }),
  };
}

function run(provider: CuaProvider, executor: CuaExecutor, options: Partial<CuaLoopOptions> = {}) {
  return runComputerUseLoop({
    instructions: "Add one entry.",
    provider,
    executor,
    persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
    redaction: defaultRedactionHooks,
    now: Date.now,
    timeoutMs: 60_000,
    ...options,
  });
}

describe("acknowledgements of a batch", () => {
  it("reach a provider with no request policy on its next request", async () => {
    const { provider, requests } = scripted([turn({ actions: [click, typing] })]);
    await run(provider, desktop());
    expect(requests[0]?.previousExecution).toBeUndefined();
    expect(requests[1]?.previousExecution).toEqual({
      actions: [
        { index: 0, status: "completed" },
        { index: 1, status: "completed" },
      ],
    });
  });

  it("reach the closing request after a stop condition matched", async () => {
    const { provider } = scripted([turn({ actions: [click] })]);
    const debrief = vi.fn<NonNullable<CuaProvider["debrief"]>>(async () =>
      turn({ done: true, message: "Reached the goal." }),
    );
    let saved = false;
    await run(
      { ...provider, debrief },
      {
        observe: async () => ({ stateSignature: String(saved), text: saved ? "saved" : "" }),
        execute: async () => {
          saved = true;
        },
      },
      { stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] } },
    );
    expect(debrief.mock.calls[0]?.[0].previousExecution).toEqual({
      actions: [{ index: 0, status: "completed" }],
    });
  });
});

/** The shape of a failed desktop command: a non-zero exit, as the desktop SDK throws it. */
const commandFailure = (): Error =>
  Object.assign(new Error("command failed"), { name: "CommandExitError", exitCode: 1 });

describe("a failed desktop command in a batch", () => {
  const failTyping = async (action: CuaAction): Promise<void> => {
    if (action === typing) throw commandFailure();
  };

  it("is skipped and the rest of the batch runs by default", async () => {
    const { provider, requests } = scripted([turn({ actions: [click, typing, submit] })]);
    const executor = desktop(failTyping);
    await run(provider, executor);
    expect(executor.execute.mock.calls.map(([action]) => action)).toEqual([click, typing, submit]);
    expect(requests[1]?.previousExecution?.actions).toEqual([
      { index: 0, status: "completed" },
      { index: 1, status: "skipped" },
      { index: 2, status: "completed" },
    ]);
  });

  it("halts the batch for a provider whose model assumes a batch stops at its first failure", async () => {
    const { provider, requests } = scripted([turn({ actions: [click, typing, submit, click] })], {
      batchFailure: "halt",
    });
    const executor = desktop(failTyping);
    const result = await run(provider, executor);
    expect(executor.execute.mock.calls.map(([action]) => action)).toEqual([click, typing]);
    expect(requests[1]?.previousExecution?.actions).toEqual([
      { index: 0, status: "completed" },
      { index: 1, status: "skipped" },
      { index: 2, status: "not_dispatched" },
      { index: 3, status: "not_dispatched" },
    ]);
    expect(result).toMatchObject({ status: "passed", completionReason: "goal_satisfied" });
    expect(
      result.trace.items.find((item) => item.title === "batch halted after a skipped action"),
    ).toMatchObject({ text: expect.stringContaining("remaining batch actions not dispatched: 2") });
  });
});

describe("a proposal the provider could not map to an action", () => {
  const rejectedProposal = {
    reason: "The click named no coordinates, and the pointer position is not known.",
  };

  it("stops its batch at its position and the session goes on", async () => {
    const { provider, requests } = scripted([turn({ actions: [click], rejectedProposal })]);
    const executor = desktop();
    const result = await run(provider, executor);
    expect(executor.execute.mock.calls.map(([action]) => action)).toEqual([click]);
    expect(requests[1]?.previousExecution?.actions).toEqual([
      { index: 0, status: "completed" },
      { index: 1, status: "not_dispatched" },
    ]);
    expect(requests[1]?.contextHint).toContain(rejectedProposal.reason);
    expect(result).toMatchObject({ status: "passed", completionReason: "goal_satisfied" });
    expect(
      result.trace.items.find((item) => item.title === "action rejected before dispatch"),
    ).toMatchObject({ status: "warn", text: expect.stringContaining(rejectedProposal.reason) });
  });

  it("alone in its reply does not end the session", async () => {
    const { provider, requests } = scripted([
      turn({ rejectedProposal }),
      turn({ actions: [click] }),
    ]);
    const executor = desktop();
    const result = await run(provider, executor);
    expect(requests[1]?.previousExecution?.actions).toEqual([
      { index: 0, status: "not_dispatched" },
    ]);
    expect(executor.execute.mock.calls.map(([action]) => action)).toEqual([click]);
    expect(result).toMatchObject({ status: "passed", completionReason: "goal_satisfied" });
  });

  it("ends a participant that proposes nothing else through the backstop", async () => {
    const { provider } = scripted([], {
      nextTurn: async () => turn({ rejectedProposal }),
    });
    const executor = desktop();
    const result = await run(provider, executor, { idleSteps: 3, noProgressSteps: 3 });
    expect(executor.execute).not.toHaveBeenCalled();
    expect(result.completionReason).toBe("gave_up");
    expect(result.trace.counts.materialActions).toBe(0);
  });
});
