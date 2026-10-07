import { describe, expect, it } from "vitest";

import type { CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
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
