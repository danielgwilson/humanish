import { describe, expect, it } from "vitest";

import {
  runComputerUseLoopWithTaps,
  type CuaLoopResult,
} from "../../../src/actors/computer-use/loop.js";
import type { LoopRunOptions } from "../../../src/actors/computer-use/loop/types.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import { perceptualSignature } from "../../../src/evidence/frame-signature.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { MINUTE, QUIET, watchesOf } from "../../helpers/watching-loop.js";

// An OpenAI participant offered a wait_for_change function next to the computer tool, so it can
// name how long it waits, as Codex and Claude Code participants do. The desktop's screen never
// changes and the clock moves only when the loop sleeps, so request times are exact.

type Body = Record<string, unknown> & { input: unknown[] };

/** A reply whose only output is one computer_call that waits, the computer tool's own wait. */
const computerWaitReply = (n: number) => ({
  id: `resp_${n}`,
  status: "completed",
  output: [
    {
      type: "computer_call",
      id: `cu_${n}`,
      call_id: `call_${n}`,
      actions: [{ type: "wait" }],
    },
  ],
});

/** A reply whose only output is one wait_for_change call with `args` as its arguments. */
const waitForChangeReply = (n: number, args: string) => ({
  id: `resp_${n}`,
  status: "completed",
  output: [
    {
      type: "function_call",
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: "wait_for_change",
      arguments: args,
    },
  ],
});

/** A reply with only a message, which ends the participant's session. */
const doneReply = (n: number) => ({
  id: `resp_${n}`,
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Nothing new came in." }],
    },
  ],
});

/** Run one participant through the OpenAI provider; `replies[n]` answers request n + 1. */
async function runOpenAi(
  replies: unknown[],
  loop: Partial<LoopRunOptions> = {},
): Promise<{ result: CuaLoopResult; bodies: Body[]; sentAt: number[] }> {
  let t = 0;
  const bodies: Body[] = [];
  const sentAt: number[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as Body);
    sentAt.push(t);
    const value = replies[Math.min(bodies.length, replies.length) - 1];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  const result = await runComputerUseLoopWithTaps({
    instructions: "Wait for the queue to change, then say what changed.",
    provider: createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn,
      delayFn: async () => undefined,
      env: {},
      now: () => t,
    }),
    executor: {
      observe: async () => ({ screenshot: QUIET, stateSignature: perceptualSignature(QUIET) }),
      execute: async () => undefined,
    },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
    redaction: defaultRedactionHooks,
    timeoutMs: 2 * 60 * MINUTE,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    ...loop,
  });
  return { result, bodies, sentAt };
}

describe("the wait_for_change tool", () => {
  it("is offered next to the computer tool on every request, the closing one included", async () => {
    const { bodies } = await runOpenAi([computerWaitReply(1), doneReply(2), doneReply(3)]);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]?.tools).toMatchObject([
      { type: "computer" },
      {
        type: "function",
        name: "wait_for_change",
        parameters: { properties: { minutes: { type: "number" } }, required: ["minutes"] },
      },
    ]);
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools);
    expect(bodies[2]?.tools).toEqual(bodies[0]?.tools);
  });

  it("is watched for the minutes it names and answered with the watch's note and the screen", async () => {
    const { result, bodies, sentAt } = await runOpenAi([
      waitForChangeReply(1, '{"minutes":3}'),
      doneReply(2),
      doneReply(3),
    ]);
    expect(watchesOf(result).map((watch) => [watch.askedMs, watch.limitMs, watch.wake])).toEqual([
      [180_000, 180_000, "limit"],
    ]);
    expect(sentAt.slice(0, 2)).toEqual([0, 180_000]);
    expect(bodies[1]?.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: expect.stringMatching(
              /^Your wait lasted 3 minutes; no change on the screen held still long enough to end it\./,
            ),
          },
          { type: "input_image", image_url: `data:image/png;base64,${QUIET.toString("base64")}` },
        ],
      },
    ]);
  });

  it("lasts the minutes it names on each quiet turn in a row, with no word of a longer wait", async () => {
    const { result, bodies, sentAt } = await runOpenAi([
      waitForChangeReply(1, '{"minutes":3}'),
      waitForChangeReply(2, '{"minutes":3}'),
      doneReply(3),
      doneReply(4),
    ]);
    expect(watchesOf(result).map((watch) => watch.limitMs)).toEqual([180_000, 180_000]);
    expect(sentAt.slice(0, 3)).toEqual([0, 180_000, 360_000]);
    expect(bodies[2]?.input).toMatchObject([
      {
        call_id: "call_2",
        output: [
          {
            text: "Your wait lasted 3 minutes; no change on the screen held still long enough to end it.",
          },
          { type: "input_image" },
        ],
      },
    ]);
  });

  it("is answered with the screen when the session ends during it, and the closing ask stays a message", async () => {
    const { bodies, sentAt } = await runOpenAi(
      [waitForChangeReply(1, '{"minutes":3}'), doneReply(2)],
      { clock: { end: { atMs: 2 * MINUTE, windDownMs: 2 * MINUTE, kind: "session_cap" } } },
    );
    expect(sentAt).toEqual([0, 120_000]);
    const closing = bodies[1]!;
    expect(closing.tool_choice).toBe("none");
    expect(closing.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_image", image_url: `data:image/png;base64,${QUIET.toString("base64")}` },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: expect.stringMatching(/^The interactive session has ended\./),
          },
        ],
      },
    ]);
  });
});
