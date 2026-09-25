import { describe, expect, it, vi } from "vitest";

import type { ActorCapabilities } from "../src/actor-contract.js";
import {
  runComputerUseLoop,
  type CuaExecutor,
  type CuaProvider,
  type CuaTurn
} from "../src/computer-use.js";
import { defaultRedactionHooks } from "../src/redaction.js";

const capabilities: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: false,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open"
};
const receipt = { dispatched: true, usageComplete: true, cleanup: "confirmed" } as const;
const screenshot = Buffer.from("synthetic-png-frame");

function pending(action: CuaTurn["actions"][number], patch: Partial<CuaTurn> = {}): CuaTurn {
  return {
    providerRequestPending: true,
    actions: [action],
    pendingSafetyChecks: [],
    done: false,
    ...patch
  };
}

function terminal(patch: Partial<CuaTurn> = {}): CuaTurn {
  return {
    providerRequest: receipt,
    actions: [],
    pendingSafetyChecks: [],
    done: true,
    outcome: "reached",
    message: "Finished.",
    usage: { input: 30, output: 5 },
    ...patch
  };
}

function options(provider: CuaProvider, executor: CuaExecutor, writeScreenshot = vi.fn(async (name: string) => `screenshots/${name}`)) {
  return {
    instructions: "Complete the synthetic task.",
    provider,
    executor,
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
    redaction: defaultRedactionHooks,
    timeoutMs: 20_000,
    turnTimeoutMs: 500,
    now: () => Date.now(),
    writeScreenshot
  };
}

describe("continuing provider requests in the CUA loop", () => {
  it("records two yielded action cycles but settles and charges the model request once", async () => {
    const turns = [
      pending({ kind: "click", x: 12, y: 18 }),
      pending({ kind: "keypress", keys: ["ENTER"] }),
      terminal()
    ];
    const seenExecutions: Array<unknown> = [];
    const nextTurn = vi.fn<CuaProvider["nextTurn"]>(async req => {
      seenExecutions.push(req.previousExecution);
      return turns.shift()!;
    });
    const provider: CuaProvider = {
      id: "continuing-synthetic",
      requestPolicy: "fail_closed",
      capabilities,
      nextTurn
    };
    let state = 0;
    const execute = vi.fn(async () => { state += 1; });
    const observe = vi.fn(async () => ({ screenshot, stateSignature: String(state) }));
    const writeScreenshot = vi.fn(async (name: string) => `screenshots/${name}`);

    const result = await runComputerUseLoop(options(provider, { observe, execute }, writeScreenshot));

    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.providerRequests).toEqual([{
      ...receipt,
      ordinal: 1,
      kind: "interaction",
      profileVerified: false,
      usage: { input: 30, output: 5 }
    }]);
    expect(result.trace.tokenUsage).toMatchObject({ input: 30, output: 5, total: 35, turns: [{ input: 30, output: 5 }] });
    expect(result.trace.interactionUsageIncomplete).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(writeScreenshot).toHaveBeenCalledTimes(3);
    expect(result.trace.items.filter(item => item.kind === "ui_action")).toHaveLength(2);
    expect(result.trace.items.filter(item => item.kind === "screenshot")).toHaveLength(3);
    expect(seenExecutions).toEqual([
      undefined,
      { actions: [{ index: 0, status: "completed" }] },
      { actions: [{ index: 0, status: "completed" }] }
    ]);
  });

  it.each([
    { providerRequest: receipt },
    { usage: { input: 0, output: 0 } }
  ])("rejects a pending yield that claims settled request data", async (lie) => {
    const execute = vi.fn(async () => undefined);
    const provider: CuaProvider = {
      id: "lying-pending-synthetic",
      requestPolicy: "fail_closed",
      capabilities,
      nextTurn: async () => pending({ kind: "click", x: 1, y: 1 }, lie)
    };

    const result = await runComputerUseLoop(options(provider, {
      execute,
      observe: async () => ({ screenshot, stateSignature: "ready" })
    }));

    expect(result.completionReason).toBe("harness_error");
    expect(result.trace.providerRequests).toHaveLength(1);
    expect(result.trace.providerRequests?.[0]).toMatchObject({
      kind: "interaction",
      dispatched: "unknown",
      usageComplete: false,
      cleanup: "unconfirmed",
      errorCode: "invalid_response"
    });
    expect(result.trace.tokenUsage).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps an aborted pending native request incomplete without inventing a settlement or zero charge", async () => {
    const abort = new AbortController();
    let active = false;
    let executionStarted!: () => void;
    const started = new Promise<void>(resolve => { executionStarted = resolve; });
    const provider: CuaProvider = {
      id: "cancelled-continuing-synthetic",
      requestPolicy: "fail_closed",
      capabilities,
      get interactionUsageIncomplete() { return active; },
      nextTurn: async () => {
        active = true;
        return pending({ kind: "click", x: 3, y: 4 });
      }
    };
    const executor: CuaExecutor = {
      observe: async () => ({ screenshot, stateSignature: "ready" }),
      execute: async () => {
        executionStarted();
        await new Promise<void>(() => undefined);
      }
    };

    const running = runComputerUseLoop({ ...options(provider, executor), signal: abort.signal });
    await started;
    abort.abort();
    const result = await running;

    expect(result.trace.stopCause).toBe("harness_aborted");
    expect(result.trace.interactionUsageIncomplete).toBe(true);
    expect(result.trace.providerRequests).toEqual([]);
    expect(result.trace.tokenUsage).toBeUndefined();
  });

  it("lets a structured stop settle the pending interaction through the existing closing-report path", async () => {
    let active = false;
    const nextTurn = vi.fn<CuaProvider["nextTurn"]>(async () => {
      active = true;
      return pending({ kind: "click", x: 7, y: 8 });
    });
    const debrief = vi.fn<NonNullable<CuaProvider["debrief"]>>(async req => {
      expect(req.previousExecution).toEqual({ actions: [{ index: 0, status: "completed" }] });
      expect(req.observation).toMatchObject({ text: "saved", screenshot });
      active = false;
      return terminal({
        closingReport: { summary: "I saved the item.", frictionReports: [] }
      });
    });
    const provider: CuaProvider = {
      id: "closing-continuing-synthetic",
      requestPolicy: "fail_closed",
      capabilities,
      get interactionUsageIncomplete() { return active; },
      nextTurn,
      debrief
    };
    let state = 0;
    const execute = vi.fn(async () => { state += 1; });
    const observe = vi.fn(async () => ({ screenshot, stateSignature: String(state), text: state ? "saved" : "editing" }));

    const result = await runComputerUseLoop({
      ...options(provider, { observe, execute }),
      stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] }
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(result.trace.debrief).toMatchObject({ status: "completed", usageReported: true });
    expect(result.trace.providerRequests).toHaveLength(1);
    expect(result.trace.providerRequests?.[0]).toMatchObject({ kind: "interaction", usage: { input: 30, output: 5 } });
    expect(result.trace.tokenUsage?.turns).toEqual([{ input: 30, output: 5 }]);
    expect(result.trace.interactionUsageIncomplete).toBeUndefined();
    expect(nextTurn).toHaveBeenCalledTimes(1);
    expect(debrief).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledTimes(2);
  });
});
