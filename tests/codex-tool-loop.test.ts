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

  it("stops on known pending usage that crosses the cap before dispatching desktop input", async () => {
    let active = false;
    const pendingUsage = { input: 20, output: 1, cachedInput: 0, cacheWriteInput: 0 };
    const provider: CuaProvider = {
      id: "capped-continuing-synthetic",
      requestPolicy: "fail_closed",
      capabilities,
      get interactionUsageIncomplete() { return active; },
      get pendingRequestUsage() { return active ? pendingUsage : undefined; },
      nextTurn: async () => {
        active = true;
        return pending({ kind: "click", x: 1, y: 2 });
      }
    };
    const execute = vi.fn(async () => undefined);
    const estimate = vi.fn((usage: { input?: number; output?: number }) =>
      ((usage.input ?? 0) + (usage.output ?? 0)) / 100);

    const result = await runComputerUseLoop({
      ...options(provider, { execute, observe: async () => ({ screenshot, stateSignature: "ready" }) }),
      maxUsd: 0.1,
      estimateTurnCostUsd: estimate,
      requireReportedUsageForSpendCap: true
    });

    expect(result.completionReason).toBe("budget_reached");
    expect(result.trace.stopCause).toBe("spend_limit");
    expect(execute).not.toHaveBeenCalled();
    expect(estimate).toHaveBeenCalledWith(expect.objectContaining({
      input: 20,
      output: 1,
      turns: [{ input: 20, output: 1, cachedInput: 0, cacheWriteInput: 0 }]
    }));
    expect(result.trace.providerRequests).toEqual([]);
    expect(result.trace.tokenUsage).toBeUndefined();
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });

  it("uses changing pending usage for caps and records only the final settled charge", async () => {
    let active = false;
    let pendingUsage: CuaTurn["usage"];
    let call = 0;
    const provider: CuaProvider = {
      id: "under-cap-continuing-synthetic",
      requestPolicy: "fail_closed",
      capabilities,
      get interactionUsageIncomplete() { return active; },
      get pendingRequestUsage() { return pendingUsage; },
      nextTurn: async () => {
        active = true;
        call += 1;
        if (call === 1) {
          pendingUsage = { input: 10, output: 2 };
          return pending({ kind: "click", x: 4, y: 5 });
        }
        if (call === 2) {
          pendingUsage = { input: 18, output: 3 };
          return pending({ kind: "keypress", keys: ["ENTER"] });
        }
        pendingUsage = undefined;
        active = false;
        return terminal({ usage: { input: 20, output: 4 } });
      }
    };
    let state = 0;
    const execute = vi.fn(async () => { state += 1; });
    const estimate = vi.fn((usage: { input?: number; output?: number }) =>
      ((usage.input ?? 0) + (usage.output ?? 0)) / 100);

    const result = await runComputerUseLoop({
      ...options(provider, { execute, observe: async () => ({ screenshot, stateSignature: String(state) }) }),
      maxUsd: 1,
      estimateTurnCostUsd: estimate,
      requireReportedUsageForSpendCap: true
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(execute).toHaveBeenCalledTimes(2);
    expect(estimate.mock.calls.map(([usage]) => (usage.input ?? 0) + (usage.output ?? 0))).toEqual([12, 21, 24]);
    expect(result.trace.providerRequests).toHaveLength(1);
    expect(result.trace.providerRequests?.[0]?.usage).toEqual({ input: 20, output: 4 });
    expect(result.trace.tokenUsage).toMatchObject({ input: 20, output: 4, total: 24, turns: [{ input: 20, output: 4 }] });
    expect(result.trace.interactionUsageIncomplete).toBeUndefined();
  });

  it("fails a strict capped pending request whose usage is still missing", async () => {
    let active = false;
    const provider: CuaProvider = {
      id: "unknown-pending-usage-synthetic",
      requestPolicy: "fail_closed",
      capabilities,
      get interactionUsageIncomplete() { return active; },
      nextTurn: async () => {
        active = true;
        return pending({ kind: "click", x: 1, y: 2 });
      }
    };
    const execute = vi.fn(async () => undefined);

    const result = await runComputerUseLoop({
      ...options(provider, { execute, observe: async () => ({ screenshot, stateSignature: "ready" }) }),
      maxUsd: 1,
      estimateTurnCostUsd: () => 0,
      requireReportedUsageForSpendCap: true
    });

    expect(result.trace).toMatchObject({
      completionReason: "harness_error",
      stopCause: "usage_unreported",
      interactionUsageIncomplete: true
    });
    expect(execute).not.toHaveBeenCalled();
    expect(result.trace.providerRequests).toEqual([]);
    expect(result.trace.tokenUsage).toBeUndefined();
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
    let pendingUsage: CuaTurn["usage"];
    const nextTurn = vi.fn<CuaProvider["nextTurn"]>(async () => {
      active = true;
      pendingUsage = { input: 20, output: 3 };
      return pending({ kind: "click", x: 7, y: 8 });
    });
    const debrief = vi.fn<NonNullable<CuaProvider["debrief"]>>(async req => {
      expect(req.previousExecution).toEqual({ actions: [{ index: 0, status: "completed" }] });
      expect(req.observation).toMatchObject({ text: "saved", screenshot });
      pendingUsage = undefined;
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
      get pendingRequestUsage() { return pendingUsage; },
      nextTurn,
      debrief
    };
    let state = 0;
    const execute = vi.fn(async () => { state += 1; });
    const observe = vi.fn(async () => ({ screenshot, stateSignature: String(state), text: state ? "saved" : "editing" }));

    const result = await runComputerUseLoop({
      ...options(provider, { observe, execute }),
      stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] },
      maxUsd: 1,
      estimateTurnCostUsd: () => 0.01,
      requireReportedUsageForSpendCap: true
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
