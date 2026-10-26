import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import type { CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import { createOpenAiResponsesProvider } from "../../../src/actors/computer-use/openai-provider.js";
import { type FetchLike } from "../../../src/actors/computer-use/provider-http.js";

// A participant that waits with wait_minutes, carried by the client (explicit_context): every
// function call travels with its output, the outputs' screenshots count toward the budget, and
// once old turns become the progress note, the note says how the participant waited and how each
// wait ended.

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(200);
  return PNG.sync.write(image);
}

const SCREEN = png(1280, 800);
const HINT =
  "Your wait lasted 3 minutes; no change on the screen held still long enough to end it.";

function request(contextHint?: string): CuaTurnRequest {
  return {
    instructions: "Keep the support queue open and handle each new ticket.",
    observation: { screenshot: SCREEN, stateSignature: "sig" },
    ...(contextHint === undefined ? {} : { contextHint }),
  };
}

const thought = (n: number) => ({
  type: "reasoning",
  id: `rs_${n}`,
  summary: [{ type: "summary_text", text: `turn-${n} thought: the queue is empty` }],
  encrypted_content: `enc-${n}`,
});

/** Turn `n`'s reply: a reasoning summary and one wait_minutes call of 3 minutes. */
function waitReply(n: number): Record<string, unknown> {
  return {
    id: `resp_${n}`,
    status: "completed",
    output: [
      thought(n),
      {
        type: "function_call",
        id: `fc_${n}`,
        call_id: `call_${n}`,
        name: "wait_minutes",
        arguments: '{"minutes":3}',
        status: "completed",
      },
    ],
    usage: { input_tokens: 1000 * n, output_tokens: 50 },
  };
}

/** Turn `n`'s reply: a reasoning summary and a computer_call that only waits. */
function computerWaitReply(n: number): Record<string, unknown> {
  return {
    id: `resp_${n}`,
    status: "completed",
    output: [
      thought(n),
      { type: "computer_call", id: `cu_${n}`, call_id: `call_${n}`, actions: [{ type: "wait" }] },
    ],
    usage: { input_tokens: 1000 * n, output_tokens: 50 },
  };
}

interface SentBody {
  previous_response_id?: string;
  input: Array<Record<string, unknown>>;
}

/** `turns` participant requests in explicit_context, each after the first carrying the hint. */
async function runTurns(
  turns: number,
  replyFor: (n: number) => Record<string, unknown>,
): Promise<{ bodies: SentBody[]; provider: ReturnType<typeof createOpenAiResponsesProvider> }> {
  const bodies: SentBody[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as SentBody);
    const value = replyFor(bodies.length);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  const provider = createOpenAiResponsesProvider({
    apiKey: "test-key",
    fetchFn,
    delayFn: async () => undefined,
    zeroDataRetention: true,
  });
  for (let turn = 1; turn <= turns; turn += 1)
    await provider.nextTurn(request(turn === 1 ? undefined : HINT), new AbortController().signal);
  return { bodies, provider };
}

describe("wait_minutes in an explicit-context conversation", () => {
  it("carries each call with its output, in order, and no previous_response_id", async () => {
    const { bodies } = await runTurns(5, waitReply);
    const fifth = bodies[4]!;
    expect(fifth.previous_response_id).toBeUndefined();
    const calls = fifth.input.filter((item) => item.type === "function_call");
    const outputs = fifth.input.filter((item) => item.type === "function_call_output");
    expect(calls.map((call) => call.call_id)).toEqual(["call_1", "call_2", "call_3", "call_4"]);
    expect(outputs.map((output) => output.call_id)).toEqual(calls.map((call) => call.call_id));
    for (const call of calls)
      expect(fifth.input.indexOf(outputs.find((o) => o.call_id === call.call_id)!)).toBeGreaterThan(
        fifth.input.indexOf(call),
      );
  });

  it("counts a function output's screenshot as it counts a computer_call output's", async () => {
    const waits = (await runTurns(5, waitReply)).provider.conversation!.requests;
    const computer = (await runTurns(5, computerWaitReply)).provider.conversation!.requests;
    expect(waits.map((entry) => entry.carriedScreenshots)).toEqual([0, 1, 2, 3, 4]);
    expect(waits.map((entry) => entry.carriedScreenshots)).toEqual(
      computer.map((entry) => entry.carriedScreenshots),
    );
    // The hint text adds a few tokens; the screenshots are the rest.
    for (const [index, entry] of waits.entries())
      expect(entry.estimatedInputTokens!).toBeGreaterThanOrEqual(
        computer[index]!.estimatedInputTokens!,
      );
  });

  it("notes how a summarized turn waited and how its wait ended", async () => {
    const { bodies, provider } = await runTurns(80, waitReply);
    expect(provider.conversation!.summarizedTurns).toBeGreaterThan(0);
    const note = bodies[79]!.input[1] as { role: string; content: Array<{ text: string }> };
    expect(note.role).toBe("assistant");
    const line = note.content[0]!.text.split("\n").find((text) => text.startsWith("Turn 3: "));
    expect(line).toBe(
      `Turn 3: thought: turn-3 thought: the queue is empty; did: wait_minutes {"minutes":3}; was told: ${HINT}`,
    );
  });
});
