import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runComputerUseLoop } from "../src/computer-use.js";
import { runCuaActorSession } from "../src/computer-use-actor.js";
import { defaultRedactionHooks } from "../src/redaction.js";
import type { CuaTurn } from "../src/computer-use.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES, parseOpenAiResponse, type FetchLike } from "../src/openai-responses-cu.js";

const captured = parseOpenAiResponse(JSON.parse(readFileSync(new URL("./fixtures/openai-closing-report/pending-computer-call.json", import.meta.url), "utf8"))).turn;

async function exercise(turn: CuaTurn, options: { stall?: boolean; reject?: boolean; capped?: boolean; priorUnknown?: boolean } = {}) {
  const calls = { requests: 0, actions: 0, debriefs: 0 };
  const result = await runComputerUseLoop({
    instructions: "Synthetic usage contract.", persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    timeoutMs: 1000, turnTimeoutMs: 5, now: Date.now, redaction: defaultRedactionHooks, requireReportedUsageForSpendCap: true,
    ...(options.capped === false ? {} : { maxUsd: 1, estimateTurnCostUsd: () => 0 }),
    provider: {
      id: "captured-usage-fixture", version: "gpt-5.6-sol", capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      ...(options.priorUnknown ? { interactionUsageIncomplete: true } : {}),
      nextTurn: async () => {
        calls.requests++;
        if (options.reject) throw new Error("Synthetic transport failure without usage");
        return options.stall ? new Promise<CuaTurn>(() => {}) : structuredClone(turn);
      },
      debrief: async () => { calls.debriefs++; return structuredClone(turn); }
    },
    executor: { observe: async () => ({ stateSignature: "synthetic" }), execute: async () => { calls.actions++; } }
  });
  return { ...result, calls };
}

describe("sequential cap policy requires reported usage", () => {
  it.each([undefined, { input: 1 }, { output: 1 }])("stops on absent or partial usage %j without inventing a crossed threshold", async usage => {
    // Deliberately remove fields from the captured neutral turn; no invented API wire shapes.
    const turn = { ...captured };
    if (usage === undefined) delete turn.usage; else turn.usage = usage;
    const result = await exercise(turn);
    expect(result.calls).toEqual({ requests: 1, actions: 0, debriefs: 0 });
    expect(result.trace).toMatchObject({ status: "failed", completionReason: "harness_error", stopCause: "usage_unreported", interactionUsageIncomplete: true });
    expect(result.reason).toContain("usage is unavailable");
    expect(result.reason).not.toContain("crossed");
    if (usage === undefined) expect(result.trace.tokenUsage).toBeUndefined();
  });

  it("does not retry a stalled request whose spend is unknown", async () => {
    const result = await exercise(captured, { stall: true });
    // The provider turn limit expires before the session deadline; strict accounting forbids retry.
    expect(result.calls).toEqual({ requests: 1, actions: 0, debriefs: 0 });
    expect(result.trace.stopCause).toBe("usage_unreported");
    expect(result.trace.tokenUsage).toBeUndefined();
  });

  it("preserves an earlier provider-declared usage gap even after reported usage", async () => {
    const result = await exercise(captured, { priorUnknown: true });
    expect(result.calls).toEqual({ requests: 1, actions: 0, debriefs: 0 });
    expect(result.trace.stopCause).toBe("usage_unreported");
    expect(result.trace.tokenUsage?.input).toBe(captured.usage?.input);
  });

  it("keeps a rejected request's unreported spend unknown and makes no further request", async () => {
    const result = await exercise(captured, { reject: true });
    expect(result.calls).toEqual({ requests: 1, actions: 0, debriefs: 0 });
    expect(result.trace).toMatchObject({ completionReason: "harness_error", stopCause: "usage_unreported", interactionUsageIncomplete: true });
    expect(result.trace.tokenUsage).toBeUndefined();
  });

  it("does not apply the strict policy to an uncapped session", async () => {
    const turn = { ...captured, actions: [], done: true, message: "Finished." }; delete turn.usage;
    const result = await exercise(turn, { capped: false });
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
    expect(result.calls.requests).toBe(1);
  });
});

describe("strict capped sessions own actual OpenAI dispatch and cancellation", () => {
  const frame = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=", "base64");
  async function session(fetchFn: FetchLike, options: { capped?: boolean; timeoutMs?: number; signal?: AbortSignal } = {}) {
    let actions = 0;
    const result = await runCuaActorSession({
      instructions: "Synthetic budget transport proof.", persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
      timeoutMs: options.timeoutMs ?? 1000, requireReportedUsageForSpendCap: true,
      ...(options.capped === false ? {} : { maxUsd: 1, estimateTurnCostUsd: () => 0 }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      openai: { apiKey: "synthetic-key", model: "gpt-5.6-sol", fetchFn, delayFn: async () => {} },
      executor: { observe: async () => ({ screenshot: frame, stateSignature: "synthetic" }), execute: async () => { actions++; } }
    });
    return { ...result, actions };
  }

  it.each([
    [0, "network"], [503, "unavailable"], [429, "rate limited"],
    [400, "Error: Zero Data Retention is enabled for this org."],
    [400, "Your organization must be verified to generate reasoning summaries."]
  ])("makes only one real adapter dispatch for failure %s %s", async (status, body) => {
    let dispatches = 0;
    const result = await session(async () => {
      dispatches++;
      if (status === 0) throw new Error(body);
      return { ok: false, status, text: async () => body, json: async () => ({}) };
    });
    expect(dispatches).toBe(1);
    expect(result.actions).toBe(0);
    expect(result.trace).toMatchObject({ completionReason: "harness_error", stopCause: "usage_unreported", interactionUsageIncomplete: true });
    expect(result.trace.counts.debriefCalls ?? 0).toBe(0);
  });

  it("aborts the in-flight request when the session deadline wins and cannot retry afterward", async () => {
    let dispatches = 0;
    let observedSignal: AbortSignal | undefined;
    let rejectLate: (reason: Error) => void = () => {};
    const result = await session(async (_url, init) => {
      dispatches++; observedSignal = init.signal;
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    }, { timeoutMs: 20 });
    expect(result.trace.stopCause).toBe("usage_unreported");
    expect(observedSignal?.aborted).toBe(true);
    rejectLate(new Error("Delayed ambiguous network failure after the loop ended"));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(dispatches).toBe(1);
    expect(result.actions).toBe(0);
    expect(result.trace.counts.debriefCalls ?? 0).toBe(0);
  });

  it("propagates caller cancellation to the strict request", async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const result = await session(async (_url, init) => {
      observedSignal = init.signal;
      caller.abort();
      return new Promise((_resolve, reject) => {
        if (init.signal?.aborted) reject(new Error("Cancelled transport"));
        else init.signal?.addEventListener("abort", () => reject(new Error("Cancelled transport")), { once: true });
      });
    }, { signal: caller.signal });
    expect(observedSignal?.aborted).toBe(true);
    expect(result.actions).toBe(0);
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });

  it("makes no request when the caller has already cancelled", async () => {
    const caller = new AbortController(); caller.abort();
    let dispatches = 0;
    const result = await session(async () => { dispatches++; throw new Error("Unexpected dispatch"); }, { signal: caller.signal });
    expect(dispatches).toBe(0);
    expect(result.actions).toBe(0);
    expect(result.trace.stopCause).toBe("harness_aborted");
  });

  it("preserves uncapped provider retries", async () => {
    let dispatches = 0;
    const raw = JSON.parse(readFileSync(new URL("./fixtures/openai-closing-report/pending-computer-call.json", import.meta.url), "utf8"));
    raw.output = [{ type: "message", content: [{ type: "output_text", text: "Finished synthetic work." }] }];
    const result = await session(async () => {
      if (++dispatches === 1) throw new Error("Temporary uncapped network failure");
      return { ok: true, status: 200, text: async () => JSON.stringify(raw), json: async () => raw };
    }, { capped: false });
    expect(dispatches).toBe(2);
    expect(result.trace.completionReason).toBe("goal_satisfied");
  });
});
