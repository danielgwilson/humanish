import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runComputerUseLoop, type CuaTurn } from "../src/computer-use.js";
import { OPENAI_RESPONSES_CU_CAPABILITIES, parseOpenAiResponse } from "../src/openai-responses-cu.js";
import { defaultRedactionHooks } from "../src/redaction.js";

function captured(name: "reasoning-only" | "partial-message"): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/openai-incomplete/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
}

async function runTurn(turn: CuaTurn) {
  const calls = { provider: 0, actions: 0, debrief: 0, narration: 0, sharedBudget: 0 };
  const result = await runComputerUseLoop({
    instructions: "Synthetic provider-interruption contract check.",
    persona: { id: "synthetic-participant", traitsApplied: [], promptDigest: "fixture" },
    redaction: defaultRedactionHooks,
    timeoutMs: 1000,
    now: Date.now,
    // Provider-neutral loop fixture: no screenshot, network, desktop, or model allocation.
    provider: {
      id: "captured-response-fixture",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => { calls.provider += 1; return turn; },
      debrief: async () => { calls.debrief += 1; return { actions: [], pendingSafetyChecks: [], done: true }; }
    },
    executor: {
      observe: async () => ({ stateSignature: "synthetic-state" }),
      execute: async () => { calls.actions += 1; }
    },
    onMessage: () => { calls.narration += 1; },
    overRunBudget: () => { calls.sharedBudget += 1; return null; }
  });
  return { ...result, calls };
}

describe("captured OpenAI incomplete responses", () => {
  it.each(["reasoning-only", "partial-message"] as const)("preserves the real %s limit and usage without claiming a natural endpoint", async (name) => {
    const parsed = parseOpenAiResponse(captured(name));
    expect(parsed.turn.interruption).toBe("token_limit");
    expect(parsed.turn.done).toBe(false);
    expect(parsed.turn.actions).toEqual([]);
    expect(parsed.turn.usage).toEqual({ input: 36, output: name === "reasoning-only" ? 16 : 32, cachedInput: 0, cacheWriteInput: 0 });

    const result = await runTurn(parsed.turn);
    expect(result.trace.status).toBe("incomplete");
    expect(result.trace.completionReason).toBe("budget_reached");
    expect(result.trace.reason).toContain("provider's output/context token limit");
    expect(result.trace.ids.turnId).toBe(parsed.turn.responseId);
    expect(result.trace.tokenUsage?.input).toBe(36);
    expect(result.trace.tokenUsage?.output).toBe(name === "reasoning-only" ? 16 : 32);
    expect(result.calls).toEqual({ provider: 1, actions: 0, debrief: 0, narration: 0, sharedBudget: 1 });
    expect(result.trace.items.some(item => item.title === "provider token limit reached")).toBe(true);
    if (name === "partial-message") {
      expect(result.trace.items.some(item => item.title === "incomplete message turn 1" && item.text === parsed.turn.message)).toBe(true);
    }
  });

  it("never dispatches actions or safety acknowledgements on an interrupted neutral-provider turn", async () => {
    const parsed = parseOpenAiResponse(captured("partial-message"));
    // A neutral-port contract case, not a claim that the captured wire contained these actions.
    const result = await runTurn({ ...parsed.turn, done: true,
      actions: [{ kind: "click", x: 10, y: 10, button: "left" }],
      pendingSafetyChecks: [{ id: "synthetic-check", code: "synthetic-check", message: "synthetic check" }] });
    expect(result.trace.status).toBe("incomplete");
    expect(result.trace.completionReason).toBe("budget_reached");
    expect(result.calls.actions).toBe(0);
    expect(result.calls.debrief).toBe(0);
  });

  it("keeps an unrecognized incomplete reason distinct from participant completion or token exhaustion", async () => {
    // Deliberate defensive mutation of the captured status envelope; not a new wire fixture.
    const parsed = parseOpenAiResponse({ ...captured("reasoning-only"), incomplete_details: { reason: "synthetic_unrecognized_reason" } });
    expect(parsed.turn.interruption).toBe("incomplete");
    const result = await runTurn(parsed.turn);
    expect(result.trace.status).toBe("failed");
    expect(result.trace.completionReason).toBe("harness_error");
    expect(result.trace.reason).toContain("explicitly incomplete response");
    expect(result.trace.tokenUsage?.output).toBe(16);
    expect(result.calls.provider).toBe(1);
  });

  it.each(["completed", undefined])("preserves the existing natural-endpoint contract for status %s", async (status) => {
    // Existing completed/legacy response behavior, varied from the captured partial-message shape.
    const raw = { ...captured("partial-message"), status, incomplete_details: null };
    const parsed = parseOpenAiResponse(raw);
    expect(parsed.turn.interruption).toBeUndefined();
    expect(parsed.turn.done).toBe(true);
    const result = await runTurn(parsed.turn);
    expect(result.trace.status).toBe("passed");
    expect(result.trace.completionReason).toBe("goal_satisfied");
  });

  it.each(["failed", "in_progress", "queued", "cancelled", "synthetic_unknown_status", "", null, 17, {}])("fails closed on explicit unexpected status %j", async (status) => {
    // Negative contract cases vary only status on the captured body. These statuses were not
    // live-captured; this asserts that noncompleted states cannot masquerade as completion.
    const parsed = parseOpenAiResponse({ ...captured("partial-message"), status });
    expect(parsed.turn.interruption).toBe("unexpected_status");
    expect(parsed.turn.done).toBe(false);
    const result = await runTurn(parsed.turn);
    expect(result.trace.status).toBe("failed");
    expect(result.trace.completionReason).toBe("harness_error");
    expect(result.trace.reason).toContain("unexpected noncompleted response status");
    expect(result.trace.tokenUsage?.output).toBe(32);
    expect(result.calls).toEqual({ provider: 1, actions: 0, debrief: 0, narration: 0, sharedBudget: 1 });
  });
});
