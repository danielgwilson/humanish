import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CuaExecutorError, isCuaExecutorError, isCuaExecutorErrorCode,
  type CuaExecutorErrorCode, type CuaExecutorDisposition
} from "../src/cua-executor-error.js";
import {
  runComputerUseLoop, type CuaAction, type CuaExecutor, type CuaLoopOptions, type CuaProvider
} from "../src/computer-use.js";
import { defaultRedactionHooks } from "../src/redaction.js";

function provider(actions: CuaAction[] = []): CuaProvider {
  return {
    id: "fixture", version: "1",
    capabilities: {
      headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: false,
      byoModel: true, preGrantableApprovals: false, inProcessTools: false, license: "open"
    },
    nextTurn: vi.fn(async () => ({ actions, done: actions.length === 0, pendingSafetyChecks: [], message: "Finished." }))
  };
}

function run(executor: CuaExecutor, options: Partial<CuaLoopOptions> = {}) {
  return runComputerUseLoop({
    instructions: "Use the fixture.", provider: provider(), executor,
    persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
    redaction: defaultRedactionHooks, now: Date.now, timeoutMs: 60_000, ...options
  });
}

afterEach(() => vi.useRealTimers());

describe("bounded executor error declarations", () => {
  it("accepts only finite codes and dispositions, with no arbitrary error payload", () => {
    const error = new CuaExecutorError("transport_failed", "outcome_uncertain");
    expect(isCuaExecutorError(error)).toBe(true);
    expect(error).toMatchObject({ code: "transport_failed", disposition: "outcome_uncertain" });
    expect(error.cause).toBeUndefined();
    expect(isCuaExecutorErrorCode("transport_failed")).toBe(true);
    expect(isCuaExecutorErrorCode("__proto__")).toBe(false);
    expect(isCuaExecutorErrorCode("toString")).toBe(false);
    expect(isCuaExecutorErrorCode({})).toBe(false);
    expect(() => new CuaExecutorError("raw backend text" as CuaExecutorErrorCode, "not_dispatched"))
      .toThrow("Invalid desktop executor error declaration.");
    expect(() => new CuaExecutorError("transport_failed", "completed" as CuaExecutorDisposition))
      .toThrow("Invalid desktop executor error declaration.");
    expect(() => Object.assign(error, { code: "raw backend text" })).toThrow();
    expect(() => Object.assign(error, { disposition: "completed" })).toThrow();
    expect(() => Object.defineProperty(error, "code", { get: () => "raw backend text" })).toThrow();
  });

  it("rejects lookalikes and a forged prototype", () => {
    expect(isCuaExecutorError({ name: "CuaExecutorError", code: "transport_failed", disposition: "not_dispatched" })).toBe(false);
    expect(isCuaExecutorError(Object.create(CuaExecutorError.prototype))).toBe(false);
    expect(isCuaExecutorError(new Error("Desktop executor transport failed."))).toBe(false);
  });
});

describe("executor failure attribution", () => {
  it("stops on initial observation failure without retrying or asking the participant", async () => {
    const actor = provider();
    const executor = {
      observe: vi.fn(async () => { throw new CuaExecutorError("executor_closed", "not_dispatched"); }),
      execute: vi.fn(async () => {})
    };
    const result = await run(executor, { provider: actor });
    expect(result).toMatchObject({ completionReason: "harness_error", status: "failed" });
    expect(executor.observe).toHaveBeenCalledTimes(1);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(actor.nextTurn).not.toHaveBeenCalled();
    expect(result.trace.items.at(-1)).toMatchObject({
      title: "desktop executor error", status: "error",
      text: "phase: observing initial UI state; code: executor_closed; disposition: not_dispatched"
    });
  });

  it.each([
    { kind: "click", x: 1, y: 2 }, { kind: "move", x: 1, y: 2 },
    { kind: "wait", ms: 1 }, { kind: "screenshot" }, { kind: "type", text: "synthetic-private-value" }
  ] satisfies CuaAction[])("does not recover or mark a failed $kind as completed", async (action) => {
    const actor = provider([action]);
    const error = new CuaExecutorError("transport_failed", "outcome_uncertain");
    // Even a backend that mutates ordinary Error metadata cannot turn this into a recoverable
    // CommandExitError, or inject that metadata into the durable diagnostic.
    Object.assign(error, { name: "CommandExitError", exitCode: 1, message: "synthetic-private-value", stderr: "synthetic-private-value" });
    const executor = {
      observe: vi.fn(async () => ({ stateSignature: "fixture" })),
      execute: vi.fn(async () => { throw error; })
    };
    const result = await run(executor, { provider: actor });
    expect(result).toMatchObject({ completionReason: "harness_error", status: "failed" });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.observe).toHaveBeenCalledTimes(1);
    expect(actor.nextTurn).toHaveBeenCalledTimes(1);
    expect(result.trace.items.filter(item => item.kind === "ui_action")).toEqual([]);
    expect(result.trace.items.some(item => /skipped|retrying/.test(item.title))).toBe(false);
    expect(result.trace.items.at(-1)?.text).toContain("disposition: outcome_uncertain");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-value");
  });

  it("retains an explicit refusal before dispatch without claiming uncertainty", async () => {
    const result = await run({
      observe: async () => ({ stateSignature: "fixture" }),
      execute: async () => { throw new CuaExecutorError("action_rejected", "not_dispatched"); }
    }, { provider: provider([{ kind: "click", x: 1, y: 2 }]) });
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).toBe("desktop executor error: action_rejected; disposition: not_dispatched");
    expect(result.trace.items.filter(item => item.kind === "ui_action")).toEqual([]);
    expect(result.trace.counts.actions).toBe(1); // The participant chose it.
    expect(result.trace.counts.materialActions).toBe(0); // The executor refused before dispatch.
  });

  it("keeps acknowledged actions when the following observation fails, without retrying", async () => {
    const observe = vi.fn().mockResolvedValueOnce({ stateSignature: "fixture" })
      .mockRejectedValue(new CuaExecutorError("invalid_response", "outcome_uncertain"));
    const result = await run({ observe, execute: async () => {} }, {
      provider: provider([{ kind: "click", x: 1, y: 2 }])
    });
    expect(result.completionReason).toBe("harness_error");
    expect(observe).toHaveBeenCalledTimes(2);
    expect(result.trace.items.filter(item => item.kind === "ui_action")).toHaveLength(1);
    expect(result.trace.items.at(-1)?.text).toContain("phase: observing UI state after turn 1");
  });

  it("does not suppress a closing task observation failure behind participant completion", async () => {
    const observe = vi.fn().mockResolvedValueOnce({ stateSignature: "fixture" })
      .mockRejectedValue(new CuaExecutorError("session_revoked", "not_dispatched"));
    const result = await run({ observe, execute: async () => {} }, {
      tasks: [{ id: "save", goal: "Save the item.", success: { any: [{ textIncludes: "Saved" }] } }]
    });
    expect(result.completionReason).toBe("harness_error");
    expect(observe).toHaveBeenCalledTimes(2);
    expect(result.trace.items.at(-1)?.text).toContain("code: session_revoked");
    expect(result.trace.items.at(-1)?.text).toContain("phase: observing closing task state");
  });

  it("keeps ordinary closing task observation failures best-effort", async () => {
    const observe = vi.fn().mockResolvedValueOnce({ stateSignature: "fixture" })
      .mockRejectedValue(new Error("ordinary observation failure"));
    const result = await run({ observe, execute: async () => {} }, {
      tasks: [{ id: "save", goal: "Save the item.", success: { any: [{ textIncludes: "Saved" }] } }]
    });
    expect(result.completionReason).toBe("goal_satisfied");
  });

  it("fails a dwell observation without completing the dwell or requesting a model turn", async () => {
    let time = 0;
    const actor = provider();
    const observe = vi.fn().mockResolvedValueOnce({ stateSignature: "fixture" })
      .mockRejectedValue(new CuaExecutorError("transport_failed", "outcome_uncertain"));
    const result = await run({ observe, execute: async () => {} }, {
      provider: actor, now: () => time, sleep: async ms => { time += ms; },
      dwell: { ms: 2_000, everyMs: 1_000, then: "stop" }
    });
    expect(result.completionReason).toBe("harness_error");
    expect(observe).toHaveBeenCalledTimes(2);
    expect(actor.nextTurn).not.toHaveBeenCalled();
    expect(result.trace.items.some(item => item.title === "dwell window complete")).toBe(false);
    expect(result.trace.items.at(-1)?.text).toContain("phase: dwell frame 1");
  });

  it("does not reclassify ordinary executor errors or name-only lookalikes", async () => {
    const error = Object.assign(new Error("ordinary actuator failure"), { name: "CuaExecutorError", code: "transport_failed" });
    const result = await run({
      observe: async () => { throw error; }, execute: async () => {}
    });
    expect(result.completionReason).toBe("actor_error");
    expect(result.trace.items.at(-1)?.title).toBe("computer-use loop error");
  });

  it("retains uncertainty when the loop deadline wins before the executor's rejection", async () => {
    vi.useFakeTimers();
    const execute = vi.fn((_action: CuaAction, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => queueMicrotask(() => reject(new CuaExecutorError("cancelled", "outcome_uncertain"))), { once: true });
    }));
    const pending = run({ observe: async () => ({ stateSignature: "fixture" }), execute }, {
      timeoutMs: 20, provider: provider([{ kind: "click", x: 1, y: 2 }])
    });
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.completionReason).toBe("budget_reached");
    expect(result.trace.stopCause).toBe("time_limit");
    expect(result.reason).toContain("latest action outcome is uncertain");
    expect(result.reason).not.toContain("productive activity");
    expect(result.trace.items.some(item => item.title === "action outcome uncertain" && item.text?.includes("outcome_uncertain"))).toBe(true);
    expect(result.trace.items.filter(item => item.kind === "ui_action")).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it("does not retry a marked observation when the loop bound wins before the client", async () => {
    vi.useFakeTimers();
    const actor = provider();
    const observe = vi.fn(() => new Promise<{ stateSignature: string }>(() => {}));
    const pending = run({ stallRecovery: "fail_closed", observe, execute: async () => {} }, {
      provider: actor, observationTimeoutMs: 20
    });
    await vi.advanceTimersByTimeAsync(20);
    const result = await pending;
    expect(result.completionReason).toBe("harness_error");
    expect(result.reason).toBe("desktop executor error: deadline_exceeded; disposition: outcome_uncertain");
    expect(observe).toHaveBeenCalledTimes(1);
    expect(actor.nextTurn).not.toHaveBeenCalled();
    expect(result.trace.items.some(item => /retrying|skipped/.test(item.title))).toBe(false);
  });

  it.each([{ kind: "wait", ms: 5 }, { kind: "screenshot" }] satisfies CuaAction[])(
    "does not skip a marked $kind when the loop bound wins before the client", async action => {
      vi.useFakeTimers();
      const actor = provider([action]);
      const observe = vi.fn(async () => ({ stateSignature: "fixture" }));
      const execute = vi.fn((_action: CuaAction, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => queueMicrotask(() => reject(new CuaExecutorError("cancelled", "outcome_uncertain"))), { once: true });
      }));
      const pending = run({ stallRecovery: "fail_closed", observe, execute }, {
        provider: actor, observationTimeoutMs: 20
      });
      await vi.advanceTimersByTimeAsync(25);
      const result = await pending;
      expect(result.completionReason).toBe("harness_error");
      expect(result.reason).toContain("deadline_exceeded; disposition: outcome_uncertain");
      expect(observe).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]?.aborted).toBe(true);
      expect(actor.nextTurn).toHaveBeenCalledTimes(1);
      expect(result.trace.items.some(item => /retrying|skipped/.test(item.title))).toBe(false);
      expect(result.trace.items.filter(item => item.kind === "ui_action")).toEqual([]);
    }
  );

  it("retains uncertainty and the original harness cancellation when abort wins", async () => {
    const controller = new AbortController();
    const result = await run({
      observe: async () => ({ stateSignature: "fixture" }),
      execute: async () => { controller.abort(); return new Promise<void>(() => {}); }
    }, { signal: controller.signal, provider: provider([{ kind: "click", x: 1, y: 2 }]) });
    expect(result.completionReason).toBe("harness_error");
    expect(result.trace.stopCause).toBe("harness_aborted");
    expect(result.reason).toBe("run aborted by the harness");
    expect(result.trace.items.some(item => item.title === "action outcome uncertain")).toBe(true);
    expect(result.trace.items.filter(item => item.kind === "ui_action")).toEqual([]);
  });
});
