import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runComputerUseLoop } from "../src/computer-use.js";
import { defaultRedactionHooks } from "../src/redaction.js";
import type { CuaTurn } from "../src/computer-use.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES, parseOpenAiResponse } from "../src/openai-responses-cu.js";

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
