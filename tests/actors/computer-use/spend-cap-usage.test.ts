import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import { runComputerUseLoop, type CuaTurn } from "../../../src/actors/computer-use/loop.js";
import {
  OPENAI_RESPONSES_CU_CAPABILITIES,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import { parseOpenAiResponse } from "../../../src/actors/computer-use/openai-wire.js";
import type { ActorTokenUsage } from "../../../src/actors/contract.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { estimateActorCost, MODEL_RATES } from "../../../src/run/pricing.js";

// A declared dollar cap is enforced from the usage each provider reply reports. A request lost
// without a reply (a stall, or a transport failure inside the provider) is booked at its worst
// case and sent again only when that fits under the cap. These cases drive the real loop with the
// options a built-in capped participant passes: maxUsd and the rate-sheet estimator for the model.

const MODEL = "gpt-5.6-sol";
const estimate = (usage: ActorTokenUsage): number | null =>
  estimateActorCost(usage, MODEL).estimatedCostUsd;

// A captured Responses reply with one pending computer_call and complete usage
// (11,541 input tokens, 229 output tokens).
const callReply: Record<string, unknown> = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openai-closing-report/pending-computer-call.json", import.meta.url),
    "utf8",
  ),
);
const captured = parseOpenAiResponse(callReply).turn;
const REPORTED_INPUT = 11541;

function withoutUsage(): CuaTurn {
  const turn = structuredClone(captured);
  delete turn.usage;
  return turn;
}

function finished(turn: CuaTurn): CuaTurn {
  return { ...turn, actions: [], done: true, message: "Finished." };
}

interface LoopRun {
  maxUsd?: number;
  maxOutputTokens?: number;
  /** Requests (1-based) that never answer, so the turn bound reads them as stalled. */
  stall?: number[];
  priorUnknown?: boolean;
}

async function run(reply: (request: number) => CuaTurn, options: LoopRun = {}) {
  const calls = { requests: 0, actions: 0 };
  const priced: ActorTokenUsage[] = [];
  let observations = 0;
  const result = await runComputerUseLoop({
    instructions: "Synthetic spend-cap contract.",
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    timeoutMs: 2000,
    turnTimeoutMs: 20,
    now: Date.now,
    redaction: defaultRedactionHooks,
    ...(options.maxUsd === undefined
      ? {}
      : {
          maxUsd: options.maxUsd,
          estimateTurnCostUsd: (usage: ActorTokenUsage) => {
            priced.push(structuredClone(usage));
            return estimate(usage);
          },
        }),
    provider: {
      id: "spend-cap-fixture",
      version: MODEL,
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      ...(options.maxOutputTokens === undefined
        ? {}
        : {
            modelSettings: { reasoningEffort: "medium", maxOutputTokens: options.maxOutputTokens },
          }),
      ...(options.priorUnknown ? { interactionUsageIncomplete: true } : {}),
      nextTurn: async () => {
        calls.requests++;
        if (options.stall?.includes(calls.requests)) return new Promise<CuaTurn>(() => {});
        return reply(calls.requests);
      },
    },
    executor: {
      // A changing signature keeps the no-progress backstop from ending the session first.
      observe: async () => ({ stateSignature: `frame-${observations++}` }),
      execute: async () => {
        calls.actions++;
      },
    },
  });
  return { ...result, calls, priced };
}

const notices = (result: { trace: { items: Array<{ kind: string; title?: string }> } }) =>
  result.trace.items.filter((item) => item.kind === "notice").map((item) => item.title);

describe("a declared spend cap and provider-reported usage", () => {
  it("sends no further request after a reply without usage", async () => {
    const result = await run(withoutUsage, { maxUsd: 10 });
    // The reply's own actions run; the next paid request is what the cap withholds.
    expect(result.calls).toEqual({ requests: 1, actions: 2 });
    expect(result.trace).toMatchObject({
      completionReason: "harness_error",
      stopCause: "usage_unreported",
      interactionUsageIncomplete: true,
    });
  });

  it("sends no further request once the provider reports an earlier request's usage as unknown", async () => {
    const result = await run(() => structuredClone(captured), { maxUsd: 10, priorUnknown: true });
    expect(result.calls.requests).toBe(1);
    expect(result.trace.stopCause).toBe("usage_unreported");
  });

  it("finishes normally when only the final reply lacks usage", async () => {
    const result = await run(() => finished(withoutUsage()), { maxUsd: 10 });
    expect(result.calls.requests).toBe(1);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });

  it("still stops on the cap itself when every reply reports usage", async () => {
    // One captured reply prices at about $0.017, over this cap.
    const result = await run(() => structuredClone(captured), { maxUsd: 0.01 });
    expect(result.calls.requests).toBe(1);
    expect(result.trace).toMatchObject({ completionReason: "budget_reached" });
    expect(result.trace.stopCause).toBe("spend_limit");
    expect(result.trace.interactionUsageIncomplete).toBeUndefined();
  });

  it("runs an uncapped session on when replies carry no usage", async () => {
    const result = await run((n) => (n < 3 ? withoutUsage() : finished(withoutUsage())));
    expect(result.calls.requests).toBe(3);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
  });

  it("retries an uncapped stall as before", async () => {
    const result = await run((n) => (n < 3 ? structuredClone(captured) : finished(captured)), {
      stall: [1],
    });
    expect(result.calls.requests).toBe(3);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.interactionUsageIncomplete).toBe(true);
    expect(notices(result)).not.toContain("worst case booked for a lost request");
  });
});

describe("a stalled request under a declared spend cap", () => {
  it("is not retried when no maxOutputTokens bounds its cost", async () => {
    const result = await run(() => structuredClone(captured), { maxUsd: 10, stall: [1] });
    expect(result.calls).toEqual({ requests: 1, actions: 0 });
    expect(result.trace).toMatchObject({
      completionReason: "harness_error",
      stopCause: "usage_unreported",
      interactionUsageIncomplete: true,
    });
    expect(result.trace.reason).toContain("maxOutputTokens");
  });

  it("is booked at its worst case and retried when that fits", async () => {
    // Request 1 stalls; requests 2 and 3 reply.
    const result = await run((n) => (n < 3 ? structuredClone(captured) : finished(captured)), {
      maxUsd: 10,
      maxOutputTokens: 1000,
      stall: [1],
    });
    expect(result.calls.requests).toBe(3);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
    expect(result.trace.interactionUsageIncomplete).toBe(true);
    expect(notices(result)).toContain("worst case booked for a lost request");
    // The trace's usage is what the provider reported; the booked worst case is not in it.
    expect(result.trace.tokenUsage?.input).toBe(2 * REPORTED_INPUT);
  });

  it("is not retried when its worst case does not fit under the cap", async () => {
    // 100,000 output tokens at $20 per million is $2, over the $1 cap.
    const result = await run(() => structuredClone(captured), {
      maxUsd: 1,
      maxOutputTokens: 100_000,
      stall: [1],
    });
    expect(result.calls).toEqual({ requests: 1, actions: 0 });
    expect(result.trace).toMatchObject({
      completionReason: "budget_reached",
      stopCause: "spend_limit",
      interactionUsageIncomplete: true,
    });
    expect(result.trace.reason).toContain("lost request");
  });

  it("books the latest reported input first, then the retry's own input", async () => {
    const replies = [
      { ...structuredClone(captured), usage: { input: 5000, output: 10 } },
      undefined, // request 2 stalls
      { ...structuredClone(captured), usage: { input: 7000, output: 10 } },
    ];
    const result = await run((n) => replies[n - 1] ?? finished(captured), {
      maxUsd: 10,
      maxOutputTokens: 1000,
      stall: [2],
    });
    expect(result.trace.completionReason).toBe("goal_satisfied");
    const booked = (usage: ActorTokenUsage) =>
      (usage.turns ?? []).filter(
        (turn) => turn.cacheWriteInput === turn.input && turn.output === 1000,
      );
    const atStall = result.priced.find((usage) => booked(usage).length > 0);
    expect(booked(atStall!)).toEqual([
      { input: 5000, output: 1000, cachedInput: 0, cacheWriteInput: 5000 },
    ]);
    expect(booked(result.priced.at(-1)!)).toEqual([
      { input: 7000, output: 1000, cachedInput: 0, cacheWriteInput: 7000 },
    ]);
  });
});

describe("a worst case priced from the rate sheet", () => {
  it("books input at each model's highest input rate", () => {
    // Booked input is recorded as cache writes, which price at the write rate where one exists.
    for (const rate of Object.values(MODEL_RATES)) {
      const writeRate = rate.cacheWriteUsdPerToken ?? rate.inputUsdPerToken;
      expect(writeRate).toBeGreaterThanOrEqual(rate.inputUsdPerToken);
      expect(writeRate).toBeGreaterThanOrEqual(rate.cachedInputUsdPerToken ?? 0);
    }
  });
});

describe("a capped OpenAI session whose transport fails", () => {
  const frame = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
    "base64",
  );
  // The final reply keeps the captured usage and swaps the output for a message, so the
  // participant finishes.
  const finalReply = {
    ...callReply,
    output: [{ type: "message", content: [{ type: "output_text", text: "Finished." }] }],
  };
  type Step = "network" | 503 | Record<string, unknown>;

  async function session(steps: Step[], caps: { maxUsd?: number; maxOutputTokens?: number }) {
    let dispatches = 0;
    const fetchFn: FetchLike = async () => {
      const step = steps[dispatches++];
      if (step === undefined) throw new Error("unexpected dispatch");
      if (step === "network") throw new Error("socket hang up");
      if (step === 503)
        return { ok: false, status: 503, text: async () => "", json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => structuredClone(step),
      };
    };
    let screen = 0;
    const result = await runCuaActorSession({
      instructions: "Synthetic capped OpenAI session.",
      persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
      timeoutMs: 5000,
      ...(caps.maxUsd === undefined ? {} : { maxUsd: caps.maxUsd, estimateTurnCostUsd: estimate }),
      openai: {
        apiKey: "synthetic-key",
        model: MODEL,
        fetchFn,
        delayFn: async () => {},
        ...(caps.maxOutputTokens === undefined ? {} : { maxOutputTokens: caps.maxOutputTokens }),
      },
      executor: {
        observe: async () => ({ screenshot: frame, stateSignature: `frame-${screen++}` }),
        execute: async () => undefined,
      },
    });
    return { ...result, dispatches };
  }

  it("runs as before when every reply reports usage", async () => {
    const result = await session([callReply, finalReply], { maxUsd: 10 });
    expect(result.dispatches).toBe(2);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
    expect(result.trace.interactionUsageIncomplete).toBeUndefined();
  });

  it("still retries an HTTP 503, which returns no billed reply", async () => {
    const result = await session([503, callReply, finalReply], { maxUsd: 10 });
    expect(result.dispatches).toBe(3);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
  });

  it("resends a failed dispatch when its worst case fits", async () => {
    const result = await session(["network", callReply, finalReply], {
      maxUsd: 10,
      maxOutputTokens: 1000,
    });
    expect(result.dispatches).toBe(3);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });

  it("does not resend a failed dispatch when no maxOutputTokens bounds its cost", async () => {
    const result = await session(["network", callReply, finalReply], { maxUsd: 10 });
    expect(result.dispatches).toBe(1);
    expect(result.trace).toMatchObject({
      stopCause: "usage_unreported",
      interactionUsageIncomplete: true,
    });
  });

  it("does not resend a failed dispatch whose worst case does not fit", async () => {
    const result = await session(["network", callReply, finalReply], {
      maxUsd: 1,
      maxOutputTokens: 100_000,
    });
    expect(result.dispatches).toBe(1);
    expect(result.trace).toMatchObject({ stopCause: "spend_limit" });
  });

  it("resends an uncapped failed dispatch as before", async () => {
    const result = await session(["network", callReply, finalReply], {});
    expect(result.dispatches).toBe(3);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.interactionUsageIncomplete).toBe(true);
  });
});
