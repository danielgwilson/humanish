import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { runComputerUseLoop, type CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import { CONTEXT_TOKEN_BUDGET } from "../../../src/actors/computer-use/openai-context.js";
import { explicitContextWarning } from "../../../src/routes/computer-use/participant-model.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

// A provider whose server keeps no conversation (explicit_context) must carry it on every
// request: a participant that only sees its last reply forgets what it already did.

function png(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(200);
  return PNG.sync.write(image);
}

const SCREEN = png(1280, 800);

function request(): CuaTurnRequest {
  return {
    instructions: "Sign up with the address in your brief, then open the dashboard.",
    observation: { screenshot: SCREEN, stateSignature: "sig" },
  };
}

/** A reply for turn `n`: a reasoning summary, a message and one click, each naming the turn. */
function reply(n: number): Record<string, unknown> {
  return {
    id: `resp_${n}`,
    status: "completed",
    output: [
      {
        type: "reasoning",
        id: `rs_${n}`,
        summary: [{ type: "summary_text", text: `turn-${n} thought: the form is on screen` }],
        encrypted_content: `enc-${n}`,
      },
      {
        type: "message",
        id: `msg_${n}`,
        role: "assistant",
        content: [{ type: "output_text", text: `turn-${n} said: filling the form` }],
      },
      {
        type: "computer_call",
        id: `cu_${n}`,
        call_id: `call_${n}`,
        actions: [{ type: "click", x: n, y: n }],
      },
    ],
    usage: { input_tokens: 1000 * n, output_tokens: 50 },
  };
}

interface SentBody {
  previous_response_id?: string;
  store?: boolean;
  include?: string[];
  input: Array<Record<string, unknown>>;
}

async function runTurns(
  turns: number,
  options: { zeroDataRetention?: boolean } = {},
  replyFor: (n: number) => Record<string, unknown> = reply,
): Promise<{ bodies: SentBody[]; provider: ReturnType<typeof createOpenAiResponsesProvider> }> {
  const bodies: SentBody[] = [];
  let n = 0;
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as SentBody);
    n += 1;
    const value = replyFor(n);
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
    now: () => Date.parse("2026-10-03T00:00:00Z"),
    ...options,
  });
  for (let turn = 0; turn < turns; turn += 1)
    await provider.nextTurn(request(), new AbortController().signal);
  return { bodies, provider };
}

const text = (body: SentBody): string => JSON.stringify(body.input);

describe("an explicit-context conversation", () => {
  it("carries turn 1's opening, reasoning, message and action on turn 5", async () => {
    const { bodies } = await runTurns(5, { zeroDataRetention: true });
    const fifth = bodies[4]!;
    expect(fifth.previous_response_id).toBeUndefined();
    expect(fifth.store).toBe(false);
    expect(fifth.include).toEqual(["reasoning.encrypted_content"]);
    expect(text(fifth)).toContain("Sign up with the address in your brief");
    expect(text(fifth)).toContain("turn-1 thought");
    expect(text(fifth)).toContain("turn-1 said");
    expect(text(fifth)).toContain('"call_id":"call_1"');
    // The encrypted reasoning goes back so the model keeps its reasoning state.
    expect(text(fifth)).toContain("enc-1");
  });

  it("answers every carried computer_call with its output, in order", async () => {
    const { bodies } = await runTurns(6, { zeroDataRetention: true });
    const input = bodies[5]!.input;
    const calls = input.filter((item) => item.type === "computer_call");
    const outputs = input.filter((item) => item.type === "computer_call_output");
    expect(calls.map((call) => call.call_id)).toEqual(outputs.map((output) => output.call_id));
    for (const call of calls) {
      const at = input.indexOf(call);
      const answer = input.findIndex(
        (item) => item.type === "computer_call_output" && item.call_id === call.call_id,
      );
      expect(answer).toBeGreaterThan(at);
    }
  });

  it("grows until the budget, then stays bounded with the earliest screenshots dropped first", async () => {
    const { bodies, provider } = await runTurns(80, { zeroDataRetention: true });
    const record = provider.conversation!;
    const estimates = record.requests.map((request) => request.estimatedInputTokens ?? 0);
    expect(estimates[9]!).toBeGreaterThan(estimates[1]!);
    // One request's own new items can sit above the carried budget; nothing grows past that.
    for (const estimate of estimates) expect(estimate).toBeLessThan(CONTEXT_TOKEN_BUDGET + 3_000);
    expect(record.summarizedTurns).toBeGreaterThan(0);

    const last = bodies[79]!;
    const [opening, note] = last.input;
    // The opening keeps the instructions and loses its screenshot first.
    expect(JSON.stringify(opening)).toContain("Sign up with the address in your brief");
    expect(JSON.stringify(opening)).not.toContain("input_image");
    // The oldest turns are a text note that keeps what was thought, said and done. It is an
    // assistant message, so page text the model quoted gains no authority by being summarized.
    expect(note).toMatchObject({ role: "assistant", content: [{ type: "output_text" }] });
    expect(JSON.stringify(note)).toContain("Turn 1: thought: turn-1 thought");
    expect(JSON.stringify(note)).toContain("did: click (1, 1)");
    // The newest turns are carried whole, with their screens.
    expect(text(last)).toContain('"call_id":"call_79"');
    expect(text(last)).not.toContain('"call_id":"call_1"');
  });

  it("caps each note line, so a reply with many actions cannot overrun the note", async () => {
    const busy = (n: number): Record<string, unknown> => {
      const value = reply(n);
      const output = value.output as Array<Record<string, unknown>>;
      output[2] = {
        ...output[2],
        actions: Array.from({ length: 1_000 }, (_, i) => ({ type: "click", x: i, y: n })),
      };
      return value;
    };
    const { bodies, provider } = await runTurns(60, { zeroDataRetention: true }, busy);
    expect(provider.conversation!.summarizedTurns).toBeGreaterThan(20);
    const note = bodies[59]!.input[1] as { content: Array<{ text: string }> };
    const noteText = note.content[0]!.text;
    const lines = noteText.split("\n").slice(1);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(2_000);
    expect(noteText.length).toBeLessThan(33_000);
  });

  it("reports no summarized turns for a threaded conversation", async () => {
    const { bodies, provider } = await runTurns(80);
    expect(bodies[79]!.previous_response_id).toBe("resp_79");
    expect(provider.conversation).toMatchObject({ mode: "threaded", summarizedTurns: 0 });
  });

  it("leaves a threaded conversation's requests as they were", async () => {
    const { bodies, provider } = await runTurns(3);
    expect(bodies[2]!.previous_response_id).toBe("resp_2");
    expect(bodies[2]!.store).toBeUndefined();
    expect(bodies[2]!.include).toBeUndefined();
    expect(bodies[2]!.input.map((item) => item.type)).toEqual(["computer_call_output"]);
    expect(provider.conversation).toMatchObject({ mode: "threaded", summarizedTurns: 0 });
  });
});

describe("cutting past the budget", () => {
  it("cuts in one step past the budget, so each request between cuts starts with the previous one", async () => {
    const { bodies, provider } = await runTurns(200, { zeroDataRetention: true });
    const record = provider.conversation!;
    // A request that does not start with the whole previous request breaks the prompt cache.
    const misses: number[] = [];
    for (let i = 1; i < bodies.length; i += 1) {
      const previous = bodies[i - 1]!.input.map((item) => JSON.stringify(item));
      const head = bodies[i]!.input.slice(0, previous.length).map((item) => JSON.stringify(item));
      if (head.join("\n") !== previous.join("\n")) misses.push(i + 1);
    }
    expect(misses.length).toBeGreaterThan(0);
    // Each miss follows a cut: that request carries fewer exchanges than the one before it.
    for (const request of misses)
      expect(record.requests[request - 1]!.carriedExchanges!).toBeLessThan(
        record.requests[request - 2]!.carriedExchanges!,
      );
    // A cut frees half the budget, which at 1280x800 is more than 15 turns of screenshots.
    for (let i = 1; i < misses.length; i += 1)
      expect(misses[i]! - misses[i - 1]!).toBeGreaterThan(15);
    const estimates = record.requests.map((request) => request.estimatedInputTokens ?? 0);
    for (const estimate of estimates) expect(estimate).toBeLessThan(CONTEXT_TOKEN_BUDGET + 3_000);
  });

  it("keeps the note's first turns when the note reaches its cap", async () => {
    const chatty = (n: number): Record<string, unknown> => {
      const value = reply(n);
      const output = value.output as Array<Record<string, unknown>>;
      output[1] = {
        ...output[1],
        content: [
          {
            type: "output_text",
            text:
              n === 1
                ? "turn-1 said: my account code is 4417"
                : `turn-${n} said: ${"still working through the form. ".repeat(9)}`,
          },
        ],
      };
      return value;
    };
    const { bodies, provider } = await runTurns(200, { zeroDataRetention: true }, chatty);
    const summarized = provider.conversation!.summarizedTurns;
    const note = bodies[199]!.input[1] as { role: string; content: Array<{ text: string }> };
    expect(note.role).toBe("assistant");
    const lines = note.content[0]!.text.split("\n");
    const turnLines = lines.filter((line) => line.startsWith("Turn "));
    // The note dropped some summarized turns to stay under its cap, and kept turn 1.
    expect(turnLines.length).toBeLessThan(summarized);
    expect(turnLines[0]).toMatch(/^Turn 1: .*4417/);
    expect(note.content[0]!.text.length).toBeLessThan(33_000);
  });

  it("keeps a summarized turn's typed values and the text that came back with its screenshot", async () => {
    const four = await turnThreeNoteLine(4);
    expect(four).toMatch(
      /type "PIN4417", click \(3, 3\); was told: Your click on turn 3 was not run\.$/,
    );
    // Twenty long fields pass the line cap: the actions give up room, and the hint stays whole.
    const twenty = await turnThreeNoteLine(20);
    expect(twenty).toMatch(/\.\.\.; was told: Your click on turn 3 was not run\.$/);
    expect(twenty.length).toBeLessThanOrEqual(2_000);
  });
});

/**
 * Turn 3's note line after 80 turns, where turn 3 types `fields` long form fields, then a short
 * code, then clicks, and the request that answers it carries a hint that the click did not run.
 */
async function turnThreeNoteLine(fields: number): Promise<string> {
  const form = (n: number): Record<string, unknown> => {
    const value = reply(n);
    const output = value.output as Array<Record<string, unknown>>;
    output[2] = {
      ...output[2],
      actions: [
        ...Array.from({ length: fields }, (_, i) => ({
          type: "type",
          text: `field ${i}: ${"x".repeat(110)}`,
        })),
        { type: "type", text: "PIN4417" },
        { type: "click", x: n, y: n },
      ],
    };
    return value;
  };
  const bodies: SentBody[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body) as SentBody);
    const value = bodies.length === 3 ? form(3) : reply(bodies.length);
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
  for (let turn = 1; turn <= 80; turn += 1)
    await provider.nextTurn(
      turn === 4 ? { ...request(), contextHint: "Your click on turn 3 was not run." } : request(),
      new AbortController().signal,
    );
  const note = bodies[79]!.input[1] as { content: Array<{ text: string }> };
  return note.content[0]!.text.split("\n").find((line) => line.startsWith("Turn 3: ")) ?? "";
}

describe("the mode switch", () => {
  it("switches mid-session and records when, keeping what came before the switch", async () => {
    const bodies: SentBody[] = [];
    let n = 0;
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as SentBody);
      n += 1;
      if (n === 3)
        return {
          ok: false,
          status: 400,
          text: async () => "previous_response_id is not supported: Zero Data Retention",
          json: async () => ({}),
        };
      const value = reply(n);
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
      now: () => Date.parse("2026-10-03T00:00:00Z"),
    });
    for (let turn = 0; turn < 3; turn += 1)
      await provider.nextTurn(request(), new AbortController().signal);
    expect(bodies[1]!.previous_response_id).toBe("resp_1");
    expect(bodies[1]!.store).toBeUndefined();
    const retried = bodies[3]!;
    expect(retried.previous_response_id).toBeUndefined();
    expect(text(retried)).toContain("turn-1 thought");
    expect(text(retried)).toContain("turn-2 said");
    expect(provider.conversation).toMatchObject({
      mode: "explicit_context",
      explicitReason: "zdr_rejection",
      switchedAt: "2026-10-03T00:00:00.000Z",
      switchedAtRequest: 3,
      requests: [{ mode: "threaded" }, { mode: "threaded" }, { mode: "explicit_context" }],
    });
  });

  it("numbers the switch by request, counting a reply set aside at its output limit", async () => {
    let n = 0;
    const fetchFn: FetchLike = async () => {
      n += 1;
      const value =
        n === 1
          ? {
              id: "resp_cut",
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
              usage: { input_tokens: 900, output_tokens: 1024 },
            }
          : reply(n);
      if (n === 3)
        return {
          ok: false,
          status: 400,
          text: async () => "previous_response_id is not supported: Zero Data Retention",
          json: async () => ({}),
        };
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
      now: () => Date.parse("2026-10-03T00:00:00Z"),
    });
    for (let turn = 0; turn < 3; turn += 1)
      await provider.nextTurn(request(), new AbortController().signal);
    expect(provider.conversation).toMatchObject({
      switchedAtRequest: 3,
      requests: [{ mode: "threaded" }, { mode: "threaded" }, { mode: "explicit_context" }],
    });
  });
});

describe("the actor trace", () => {
  it("records how the conversation was carried", async () => {
    let n = 0;
    const fetchFn: FetchLike = async () => {
      n += 1;
      const value =
        n === 1
          ? reply(1)
          : {
              id: "resp_done",
              status: "completed",
              output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
              usage: { input_tokens: 2000, output_tokens: 5 },
            };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(value),
        json: async () => value,
      };
    };
    let time = 0;
    let actions = 0;
    const result = await runComputerUseLoop({
      instructions: "Sign up with the address in your brief, then open the dashboard.",
      provider: createOpenAiResponsesProvider({
        apiKey: "test-key",
        fetchFn,
        zeroDataRetention: true,
        now: () => time,
      }),
      executor: {
        observe: async () => ({ screenshot: SCREEN, stateSignature: String(actions) }),
        execute: async () => {
          actions += 1;
        },
      },
      persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      timeoutMs: 10_000,
      redaction: defaultRedactionHooks,
    });
    expect(result.trace.reason).not.toMatch(/error/i);
    expect(result.trace.conversation).toMatchObject({
      mode: "explicit_context",
      explicitReason: "configured",
      summarizedTurns: 0,
      requests: [
        { mode: "explicit_context", carriedExchanges: 0 },
        { mode: "explicit_context", carriedExchanges: 1, carriedScreenshots: 1 },
      ],
    });
  });
});

describe("the explicit-context run warning", () => {
  it("says why and how many turns were summarized", () => {
    expect(
      explicitContextWarning({
        mode: "explicit_context",
        explicitReason: "zdr_rejection",
        switchedAtRequest: 2,
        summarizedTurns: 12,
        requests: [],
      }),
    ).toMatch(/rejected server-side conversation state.*on request 2.*summarized the 12 oldest/);
    expect(
      explicitContextWarning({
        mode: "explicit_context",
        explicitReason: "configured",
        summarizedTurns: 0,
        requests: [],
      }),
    ).toMatch(/^zeroDataRetention is set/);
  });
});
