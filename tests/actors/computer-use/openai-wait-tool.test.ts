import { describe, expect, it } from "vitest";

import {
  runComputerUseLoopWithTaps,
  type CuaAction,
  type CuaLoopResult,
} from "../../../src/actors/computer-use/loop.js";
import type { LoopRunOptions } from "../../../src/actors/computer-use/loop/types.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import { perceptualSignature } from "../../../src/evidence/frame-signature.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { MINUTE, QUIET, waitItems, watchesOf } from "../../helpers/watching-loop.js";

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

/** A reply with `output` as its items. */
const replyOf = (n: number, ...output: unknown[]) => ({
  id: `resp_${n}`,
  status: "completed",
  output,
});
/** A function call item, wait_for_change unless `name` says otherwise. */
const fnCall = (callId: string, args: string, name = "wait_for_change") => ({
  type: "function_call",
  id: `fc_${callId}`,
  call_id: callId,
  name,
  arguments: args,
  status: "completed",
});
/** A computer_call item with `actions`. */
const computerCall = (callId: string, actions: unknown[]) => ({
  type: "computer_call",
  id: `cu_${callId}`,
  call_id: callId,
  actions,
});
const IMAGE = `data:image/png;base64,${QUIET.toString("base64")}`;
/** How many times a request body carries the screenshot. */
const imagesIn = (body: Body): number => JSON.stringify(body.input).split(IMAGE).length - 1;

/** A reply to a closing request: its JSON, as text, with `fields`. */
const closingReply = (n: number, fields: Record<string, unknown>) => ({
  id: `resp_${n}`,
  status: "completed",
  output: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify(fields) }],
    },
  ],
});
const REPORT = {
  outcome: "not_reached",
  summary: "I watched the queue; nothing new came in.",
  frictionReports: [],
  impressions: [],
};
const IMPRESSIONS = { impressions: [] };

/** Run one participant through the OpenAI provider; `replies[n]` answers request n + 1. */
async function runOpenAi(
  replies: unknown[],
  loop: Partial<LoopRunOptions> = {},
): Promise<{ result: CuaLoopResult; bodies: Body[]; sentAt: number[]; executed: CuaAction[] }> {
  let t = 0;
  const bodies: Body[] = [];
  const executed: CuaAction[] = [];
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
      execute: async (action) => {
        executed.push(action);
      },
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
  return { result, bodies, sentAt, executed };
}

describe("the wait_for_change tool", () => {
  it("is offered next to the computer tool on every request, the closing one included", async () => {
    const { bodies } = await runOpenAi([
      computerWaitReply(1),
      doneReply(2),
      closingReply(3, IMPRESSIONS),
    ]);
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
      [waitForChangeReply(1, '{"minutes":3}'), closingReply(2, REPORT)],
      { clock: { end: { atMs: 2 * MINUTE, windDownMs: 2 * MINUTE, kind: "session_cap" } } },
    );
    expect(sentAt).toEqual([0, 120_000]);
    const closing = bodies[1]!;
    expect(closing.tool_choice).toBe("none");
    expect(closing.input).toHaveLength(3);
    expect(closing.input.slice(0, 2)).toEqual([
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

  it("answers each of several calls in one reply once, with the screen and the note in the first", async () => {
    const { result, bodies } = await runOpenAi([
      replyOf(1, fnCall("call_a", '{"minutes":2}'), fnCall("call_b", '{"minutes":1}')),
      doneReply(2),
      closingReply(3, IMPRESSIONS),
    ]);
    expect(watchesOf(result).map((watch) => [watch.limitMs, watch.wake])).toEqual([
      [180_000, "limit"],
    ]);
    expect(bodies[1]?.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_a",
        output: [
          { type: "input_text", text: expect.stringMatching(/^Your wait lasted 3 minutes;/) },
          { type: "input_image", image_url: IMAGE },
        ],
      },
      { type: "function_call_output", call_id: "call_b", output: "The wait ended." },
    ]);
    expect(imagesIn(bodies[1]!)).toBe(1);
  });

  it("goes to the desktop among other actions, at most maxWaitMs, and its output says so", async () => {
    const { result, bodies, executed } = await runOpenAi([
      replyOf(
        1,
        computerCall("call_c", [{ type: "click", x: 10, y: 10 }]),
        fnCall("call_w", '{"minutes":3}'),
      ),
      doneReply(2),
      closingReply(3, IMPRESSIONS),
    ]);
    expect(watchesOf(result)).toEqual([]);
    const waited = executed.flatMap((action) => (action.kind === "wait" ? [action.ms] : []));
    expect(waited.reduce((sum, ms) => sum! + ms!, 0)).toBe(120_000);
    expect(bodies[1]?.input).toEqual([
      {
        type: "computer_call_output",
        call_id: "call_c",
        output: { type: "computer_screenshot", image_url: IMAGE },
      },
      {
        type: "function_call_output",
        call_id: "call_w",
        output:
          "This wait was sent with other actions, so it did not end early when the screen changed. Your wait of 180000ms was shortened to 120000ms, the longest one wait action lasts. To keep waiting, send another wait.",
      },
    ]);
  });

  it("answers a call to a tool it does not have, on the impressions request too", async () => {
    const { bodies } = await runOpenAi([
      replyOf(
        1,
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Nothing new came in." }],
        },
        fnCall("call_x", "{}", "read_page"),
      ),
      closingReply(2, IMPRESSIONS),
    ]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.input[0]).toEqual({
      type: "function_call_output",
      call_id: "call_x",
      output: [
        { type: "input_text", text: 'There is no tool named "read_page".' },
        { type: "input_image", image_url: IMAGE },
      ],
    });
    expect(imagesIn(bodies[1]!)).toBe(1);
  });

  it("answers every call on the closing request, with the screen once and the ask as a message", async () => {
    const { bodies } = await runOpenAi(
      [
        replyOf(1, fnCall("call_a", '{"minutes":3}'), fnCall("call_b", '{"minutes":3}')),
        closingReply(2, REPORT),
      ],
      { clock: { end: { atMs: 2 * MINUTE, windDownMs: 2 * MINUTE, kind: "session_cap" } } },
    );
    expect(bodies).toHaveLength(2);
    expect(bodies[1]?.input.slice(0, 3)).toEqual([
      {
        type: "function_call_output",
        call_id: "call_a",
        output: [{ type: "input_image", image_url: IMAGE }],
      },
      { type: "function_call_output", call_id: "call_b", output: "The wait ended." },
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
    expect(imagesIn(bodies[1]!)).toBe(1);
  });
});

describe("the trace of a wait", () => {
  it("records the length a wait named, and nothing for the computer tool's wait", async () => {
    const { result } = await runOpenAi([
      computerWaitReply(1),
      waitForChangeReply(2, '{"minutes":3}'),
      replyOf(
        3,
        computerCall("call_c", [{ type: "click", x: 10, y: 10 }]),
        fnCall("call_w", '{"minutes":0.5}'),
      ),
      doneReply(4),
      closingReply(5, IMPRESSIONS),
    ]);
    expect(waitItems(result).map((item) => [item.title, item.namedMs])).toEqual([
      ["wait 5000ms", undefined],
      ["wait 180000ms", 180_000],
      ["wait 30000ms", 30_000],
    ]);
    // The affordance record classes a wait_for_change call as a wait: observation.
    expect(result.trace.affordanceUse?.counts).toEqual({ observation: 3, pointer: 1 });
  });
});

describe("the minutes a wait_for_change call names", () => {
  it.each([
    { args: '{"minutes":0.5}', becomes: "a 30-second wait", askedMs: 30_000, limitMs: 30_000 },
    { args: "{minutes: 3}", becomes: "a wait with no length", askedMs: 5_000, limitMs: 5_000 },
    { args: '{"minutes":"3"}', becomes: "a wait with no length", askedMs: 5_000, limitMs: 5_000 },
    { args: '{"minutes":0}', becomes: "a wait with no length", askedMs: 5_000, limitMs: 5_000 },
    { args: '{"minutes":-2}', becomes: "a wait with no length", askedMs: 5_000, limitMs: 5_000 },
    { args: '{"minutes":1e-9}', becomes: "a 1 ms wait", askedMs: 1, limitMs: 1 },
    { args: '{"minutes":1e9}', becomes: "a 60-minute wait", askedMs: 3_600_000, limitMs: 600_000 },
    {
      args: '{"minutes":1e400}',
      becomes: "a 60-minute wait",
      askedMs: 3_600_000,
      limitMs: 600_000,
    },
  ])("$args becomes $becomes, watched up to the cap", async ({ args, askedMs, limitMs }) => {
    const { result, sentAt } = await runOpenAi([
      waitForChangeReply(1, args),
      doneReply(2),
      closingReply(3, IMPRESSIONS),
    ]);
    expect(watchesOf(result).map((watch) => [watch.askedMs, watch.limitMs])).toEqual([
      [askedMs, limitMs],
    ]);
    // The next request waits for the watch: a wait with no length lasts idleWaitMs (5 s).
    expect(sentAt[1]).toBe(limitMs);
  });
});
