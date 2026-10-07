import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { runCuaActorSession } from "../../../src/actors/computer-use/actor.js";
import {
  runComputerUseLoop,
  type CuaTurn,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import {
  OPENAI_RESPONSES_CU_CAPABILITIES,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import { parseOpenAiResponse } from "../../../src/actors/computer-use/openai-wire.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { estimateActorCost } from "../../../src/run/pricing.js";

// A reply cut off by the output-token limit carries no participant decision. A provider that sets
// it aside (outputLimitRetry) gets the same request once more; a second cut-off ends the session.

const fixture = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../../fixtures/${path}`, import.meta.url), "utf8"));
// Captured: medium reasoning, every output token spent on reasoning, no message or action.
const cutOffReply = fixture("openai-incomplete/reasoning-only.json");
// Captured: one pending computer_call with complete usage.
const callReply = fixture("openai-closing-report/pending-computer-call.json");
const finalReply = {
  ...callReply,
  id: "resp_final_synthetic",
  output: [{ type: "message", content: [{ type: "output_text", text: "Finished." }] }],
};

const cutOff = (): CuaTurn => parseOpenAiResponse(cutOffReply).turn;
const acting = (): CuaTurn => parseOpenAiResponse(callReply).turn;
const finished = (): CuaTurn => parseOpenAiResponse(finalReply).turn;

async function run(
  replies: Array<() => CuaTurn>,
  options: { retries?: boolean; maxUsd?: number } = {},
) {
  const requests: CuaTurnRequest[] = [];
  let observations = 0;
  const result = await runComputerUseLoop({
    instructions: "Synthetic output-limit contract.",
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    redaction: defaultRedactionHooks,
    timeoutMs: 5000,
    now: Date.now,
    ...(options.maxUsd === undefined
      ? {}
      : {
          maxUsd: options.maxUsd,
          estimateTurnCostUsd: (usage) => estimateActorCost(usage, "gpt-5.6-sol").estimatedCostUsd,
        }),
    provider: {
      id: "output-limit-fixture",
      version: "gpt-5.6-sol",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      ...(options.retries === false ? {} : { outputLimitRetry: true }),
      nextTurn: async (request) => {
        requests.push(request);
        const reply = replies[requests.length - 1];
        if (reply === undefined) throw new Error("unexpected request");
        return reply();
      },
    },
    executor: {
      observe: async () => ({ stateSignature: `frame-${observations++}` }),
      execute: async () => undefined,
    },
  });
  return { ...result, requests };
}

const noticeTitles = (result: { trace: { items: Array<{ kind: string; title?: string }> } }) =>
  result.trace.items.filter((item) => item.kind === "notice").map((item) => item.title);

describe("a reply cut off by the output-token limit", () => {
  it("is asked again once with the same request, and the session goes on", async () => {
    const result = await run([cutOff, acting, finished]);
    expect(result.requests).toHaveLength(3);
    expect(result.requests[1]).toBe(result.requests[0]);
    expect(result.trace.completionReason).toBe("goal_satisfied");
    expect(result.trace.stopCause).toBeUndefined();
    expect(noticeTitles(result)).toContain(
      "provider reply cut off by the output limit; asking again",
    );
    // The cut-off reply's usage is reported and counted.
    expect(result.trace.tokenUsage?.turns?.[0]).toMatchObject({ input: 36, output: 16 });
    expect(result.trace.counts.turns).toBe(3);
  });

  it("ends the session when the resent request is cut off too", async () => {
    const result = await run([cutOff, cutOff]);
    expect(result.requests).toHaveLength(2);
    expect(result.trace).toMatchObject({
      completionReason: "budget_reached",
      stopCause: "provider_output_limit",
    });
  });

  it("is asked again once for each request, not once per session", async () => {
    const result = await run([cutOff, acting, cutOff, finished]);
    expect(result.requests).toHaveLength(4);
    expect(result.requests[3]).toBe(result.requests[2]);
    expect(result.trace.completionReason).toBe("goal_satisfied");
  });

  it("ends the session as before when the provider cannot set the reply aside", async () => {
    const result = await run([cutOff, finished], { retries: false });
    expect(result.requests).toHaveLength(1);
    expect(result.trace.stopCause).toBe("provider_output_limit");
  });

  it("is not asked again when the cut-off reply's usage crosses the spend cap", async () => {
    // 36 input and 16 output tokens price at about $0.0005 on gpt-5.6-sol.
    const result = await run([cutOff, finished], { maxUsd: 0.0001 });
    expect(result.requests).toHaveLength(1);
    expect(result.trace).toMatchObject({
      completionReason: "budget_reached",
      stopCause: "spend_limit",
    });
  });
});

describe("the OpenAI provider after a cut-off reply", () => {
  const frame = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=",
    "base64",
  );

  async function session(replies: Array<Record<string, unknown>>) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const reply = replies[bodies.length - 1];
      if (reply === undefined) throw new Error("unexpected dispatch");
      return {
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => structuredClone(reply),
      };
    };
    let screen = 0;
    const result = await runCuaActorSession({
      instructions: "Synthetic output-limit session.",
      persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
      timeoutMs: 5000,
      openai: { apiKey: "synthetic-key", model: "gpt-5.6-sol", fetchFn, maxOutputTokens: 8192 },
      executor: {
        // The same frame each time, so a resent request carries the same screenshot.
        observe: async () => ({ screenshot: frame, stateSignature: `frame-${screen++}` }),
        execute: async () => undefined,
      },
    });
    return { ...result, bodies };
  }

  it("sends the first request again after a cut-off first reply", async () => {
    const result = await session([cutOffReply, callReply, finalReply]);
    // The fourth request asks only for impressions after the participant's own ending.
    expect(result.bodies).toHaveLength(4);
    expect(result.bodies[1]).toEqual(result.bodies[0]);
    expect(result.bodies[0]).not.toHaveProperty("previous_response_id");
    expect(result.bodies[2]).toMatchObject({ previous_response_id: callReply.id });
    expect(result.bodies[3]).toMatchObject({
      previous_response_id: finalReply.id,
      tool_choice: "none",
    });
    expect(result.trace.completionReason).toBe("goal_satisfied");
  });

  it("continues from the last complete reply after a cut-off later reply", async () => {
    const result = await session([callReply, cutOffReply, finalReply]);
    // The fourth request asks only for impressions after the participant's own ending.
    expect(result.bodies).toHaveLength(4);
    expect(result.bodies[1]).toMatchObject({ previous_response_id: callReply.id });
    expect(result.bodies[2]).toEqual(result.bodies[1]);
    expect(result.bodies[3]).toMatchObject({ tool_choice: "none" });
    expect(result.trace.completionReason).toBe("goal_satisfied");
  });
});
