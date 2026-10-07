import { describe, expect, it } from "vitest";

import type { CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import { CONTEXT_TOKEN_BUDGET } from "../../../src/actors/computer-use/openai-context.js";
import { OpenAiConversation } from "../../../src/actors/computer-use/openai-conversation.js";

// The conversation a participant has with the OpenAI computer-use model: what each request
// carries, and what the trace records about it. A participant that loses an earlier turn forgets
// what it already did, so these cases follow turn 1 through later requests.

/**
 * The first bytes of a PNG, enough for the conversation's input estimate to read its size. A
 * large size fills the carried budget in a few turns.
 */
function screen(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function turnRequest(screenshot = screen(1280, 800)): CuaTurnRequest {
  return {
    instructions: "Sign up with the address in your brief, then open the dashboard.",
    observation: { screenshot, stateSignature: "sig" },
  };
}

/** A reply for turn `n`: a message and one click, each naming the turn. */
function reply(n: number): Record<string, unknown> {
  return {
    id: `resp_${n}`,
    status: "completed",
    output: [
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
  };
}

interface Body {
  previous_response_id?: string;
  store?: boolean;
  reasoning?: unknown;
  input: unknown[];
}

function start(zeroDataRetention = false): OpenAiConversation {
  return new OpenAiConversation({
    model: "gpt-test",
    reasoningEffort: "medium",
    reasoningSummary: "auto",
    zeroDataRetention,
    now: () => Date.parse("2026-10-07T00:00:00Z"),
  });
}

/** Send turn `n`'s request and accept its reply; returns the body that was sent. */
function exchange(conversation: OpenAiConversation, n: number, req = turnRequest()): Body {
  const request = conversation.request(req);
  const body = request.body() as unknown as Body;
  request.accept(reply(n));
  return body;
}

describe("an OpenAI conversation carried on the client", () => {
  it("still carries turn 1's opening, message and action on turn 3", () => {
    const conversation = start(true);
    const bodies = [1, 2, 3].map((n) => exchange(conversation, n));
    const third = bodies[2]!;
    expect(third.previous_response_id).toBeUndefined();
    expect(third.store).toBe(false);
    const input = JSON.stringify(third.input);
    expect(input).toContain("Sign up with the address in your brief");
    expect(input).toContain("turn-1 said");
    expect(input).toContain('"call_id":"call_1"');
  });
});

describe("a rejection of server-side state", () => {
  it("switches a zero-data-retention rejection to explicit context and records why", () => {
    const conversation = start();
    exchange(conversation, 1);
    const second = conversation.request(turnRequest());
    expect((second.body() as unknown as Body).previous_response_id).toBe("resp_1");

    expect(conversation.switchToExplicitContext("zero_data_retention")).toBe(true);
    const retried = second.body() as unknown as Body;
    expect(retried.previous_response_id).toBeUndefined();
    expect(retried.store).toBe(false);
    expect(JSON.stringify(retried.input)).toContain("turn-1 said");
    second.accept(reply(2));

    expect(conversation.record()).toEqual({
      mode: "explicit_context",
      explicitReason: "zdr_rejection",
      rejection: "zero_data_retention",
      switchedAt: "2026-10-07T00:00:00.000Z",
      switchedAtRequest: 2,
      summarizedTurns: 0,
      requests: [
        { mode: "threaded" },
        {
          mode: "explicit_context",
          carriedExchanges: 1,
          carriedScreenshots: 1,
          estimatedInputTokens: expect.any(Number),
        },
      ],
    });
  });

  it("switches a stored-item rejection the same way, and has nothing to switch to after", () => {
    const conversation = start();
    exchange(conversation, 1);
    exchange(conversation, 2);
    const third = conversation.request(turnRequest());
    expect(conversation.switchToExplicitContext("stored_item")).toBe(true);
    const retried = third.body() as unknown as Body;
    expect(retried.previous_response_id).toBeUndefined();
    expect(JSON.stringify(retried.input)).toContain("turn-1 said");
    third.accept(reply(3));

    // Already carrying the conversation, a second rejection stands.
    expect(conversation.switchToExplicitContext("stored_item")).toBe(false);
    expect(conversation.record()).toMatchObject({
      mode: "explicit_context",
      explicitReason: "zdr_rejection",
      rejection: "stored_item",
      switchedAtRequest: 3,
      requests: [
        { mode: "threaded" },
        { mode: "threaded" },
        { mode: "explicit_context", carriedExchanges: 2 },
      ],
    });
  });
});

describe("the record of a request", () => {
  it("counts what the request carried when accepting its reply cuts the history", () => {
    const conversation = start(true);
    const large = turnRequest(screen(4000, 4000));
    const screenshots = (body: Body): number =>
      JSON.stringify(body.input).split("data:image/png").length - 1;

    const bodies = [1, 2, 3, 4].map((n) => exchange(conversation, n, large));
    // Request 4 carried the opening screen and three exchanges past the budget. Accepting its
    // reply cut the history, and the record still counts what request 4 sent.
    expect(screenshots(bodies[3]!)).toBe(4);
    const fourth = conversation.record();
    expect(fourth.summarizedTurns).toBe(0);
    expect(fourth.requests[3]).toMatchObject({ carriedExchanges: 3, carriedScreenshots: 3 });
    expect(fourth.requests[3]!.estimatedInputTokens).toBeGreaterThan(CONTEXT_TOKEN_BUDGET);

    // Request 5 carries the cut history: no opening screen, and turn 1 as a line of a note.
    const fifth = exchange(conversation, 5, large);
    expect(screenshots(fifth)).toBe(3);
    expect(conversation.record()).toMatchObject({ summarizedTurns: 1 });
    expect(conversation.record().requests[4]).toMatchObject({
      carriedExchanges: 3,
      carriedScreenshots: 2,
    });
  });
});

describe("reasoning summaries", () => {
  it("stop for the rest of the session once rejected", () => {
    const conversation = start();
    const first = conversation.request(turnRequest());
    expect((first.body() as unknown as Body).reasoning).toEqual({
      effort: "medium",
      summary: "auto",
    });
    expect(conversation.dropReasoningSummaries()).toBe(true);
    expect((first.body() as unknown as Body).reasoning).toEqual({ effort: "medium" });
    first.accept(reply(1));

    const second = conversation.request(turnRequest()).body() as unknown as Body;
    expect(second.reasoning).toEqual({ effort: "medium" });
    // Nothing is left to drop, so a second rejection stands.
    expect(conversation.dropReasoningSummaries()).toBe(false);
  });
});

describe("a closing report", () => {
  it("needs the server to hold the whole session", () => {
    const threaded = start();
    expect(threaded.serverHoldsSession).toBe(false);
    exchange(threaded, 1);
    expect(threaded.serverHoldsSession).toBe(true);
    threaded.switchToExplicitContext("stored_item");
    expect(threaded.serverHoldsSession).toBe(false);

    const carried = start(true);
    exchange(carried, 1);
    expect(carried.serverHoldsSession).toBe(false);
  });
});
