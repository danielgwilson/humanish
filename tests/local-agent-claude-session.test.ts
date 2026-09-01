import { describe, expect, it } from "vitest";

import type { CuaObservation } from "../src/computer-use.js";
import {
  startClaudeSession,
  turnFromResult,
  userMessage,
  type ClaudeStreamTransport
} from "../src/local-agent-claude-session.js";

const FRAME = Buffer.from("89504e470d0a1a0a", "hex");
const observation = (): CuaObservation => ({ screenshot: FRAME, stateSignature: "s1" });

/** A fake Claude Code session. Nothing spawns, nothing is spent, every message is recorded. */
function fakeSession(replies: unknown[]) {
  const sent: Array<Record<string, unknown>> = [];
  let index = 0;
  let closed = 0;
  const transport: ClaudeStreamTransport = {
    send: (message) => { sent.push(message); },
    awaitResult: async () => {
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return { type: "result", subtype: "success", session_id: "sess_1", result: JSON.stringify(reply), usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 900 } };
    },
    close: () => { closed += 1; }
  };
  return { transport, sent, closedCount: () => closed };
}

const textOf = (message: Record<string, unknown>): string => {
  const inner = message.message as { content: Array<{ text: string }> };
  return inner.content[0]!.text;
};

describe("one Claude Code session as the computer-use brain (#520)", () => {
  it("keeps ONE session for the whole run and states the persona once", async () => {
    // `claude -p` per turn started every turn cold: 188 actions over 90 turns and never finished,
    // against 21 actions over 8 turns for a participant that remembers.
    const { transport, sent } = fakeSession([{ reasoning: "r", done: false, message: null, actions: [{ kind: "click", x: 1, y: 2 }] }]);
    const session = await startClaudeSession({ transport });
    await session.provider.nextTurn({ instructions: "You are Ada. Add two tables.", observation: observation() }, new AbortController().signal);
    await session.provider.nextTurn({ instructions: "You are Ada. Add two tables.", observation: observation() }, new AbortController().signal);
    await session.close();

    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.type === "user")).toBe(true);
    // Turn one carries the persona and the reply shape; turn two carries only the new screen.
    expect(textOf(sent[0]!)).toContain("You are Ada.");
    expect(textOf(sent[0]!)).toContain('"actions"');
    expect(textOf(sent[1]!)).not.toContain("You are Ada.");
    expect(textOf(sent[1]!)).toContain("CURRENT SCREEN");
    expect(textOf(sent[1]!)).toMatch(/screen-002\.png/);
  });

  it("hands the model a file path it is allowed to Read, one per turn, and a harness hint when given", async () => {
    const { transport, sent } = fakeSession([{ reasoning: "r", done: false, message: null, actions: [] }]);
    const session = await startClaudeSession({ transport });
    await session.provider.nextTurn({ instructions: "i", observation: observation() }, new AbortController().signal);
    await session.provider.nextTurn({ instructions: "i", observation: observation(), contextHint: "the page did not change" }, new AbortController().signal);
    await session.close();
    expect(textOf(sent[0]!)).toMatch(/Read the image file .*screen-001\.png/);
    expect(textOf(sent[1]!)).toContain("Note from the harness: the page did not change");
  });

  it("reads actions, done, message and the per-turn token counts off the result", () => {
    const turn = turnFromResult({
      type: "result", subtype: "success",
      result: JSON.stringify({ reasoning: "the Add button", done: false, message: null, actions: [{ kind: "click", x: 10, y: 20 }, { kind: "type", text: "users" }] }),
      usage: { input_tokens: 1500, output_tokens: 60, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }
    });
    expect(turn.actions).toHaveLength(2);
    expect(turn.done).toBe(false);
    expect(turn.reasoning).toBe("the Add button");
    // Counted, never priced: a subscription is not a rate card (#531).
    expect(turn.usage).toEqual({ input: 1500, output: 60, cachedInput: 1000, cacheWriteInput: 200 });
  });

  it("treats a closing message with no actions as done", () => {
    const turn = turnFromResult({ type: "result", subtype: "success", result: JSON.stringify({ reasoning: "", done: false, message: "Both tables exist; the second one landed on top of the first.", actions: [] }) });
    expect(turn.done).toBe(true);
    expect(turn.message).toContain("landed on top");
  });

  it("a turn without structured output is a BROKEN turn, never an empty one", () => {
    // An empty turn reads to the loop as "the participant chose to do nothing", which ends a
    // study quietly. A thrown error ends it loudly, with the text that came back.
    expect(() => turnFromResult({ type: "result", subtype: "success", result: "I can't see the image." })).toThrow(/no structured turn output/);
    expect(() => turnFromResult({ type: "result", subtype: "error_max_turns", is_error: true, result: "" })).toThrow(/error_max_turns/);
  });

  it("closes the session once and only when the run says so", async () => {
    const { transport, closedCount } = fakeSession([{ reasoning: "r", done: true, message: "done", actions: [] }]);
    const session = await startClaudeSession({ transport });
    await session.provider.nextTurn({ instructions: "i", observation: observation() }, new AbortController().signal);
    expect(closedCount()).toBe(0);
    await session.close();
    expect(closedCount()).toBe(1);
  });

  it("refuses an observation with no frame, because it reasons over pixels", async () => {
    const { transport } = fakeSession([]);
    const session = await startClaudeSession({ transport });
    await expect(session.provider.nextTurn({ instructions: "i", observation: { stateSignature: "s" } as CuaObservation }, new AbortController().signal))
      .rejects.toThrow(/needs a screenshot/);
    await session.close();
  });

  it("writes the message in the shape stream-json reads on stdin", () => {
    expect(userMessage("hi")).toEqual({ type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
  });
});

describe("the participant's declared outcome (#570)", () => {
  it("rides the turn when the reply carries one of the three words, and only then", () => {
    const reached = turnFromResult({ type: "result", subtype: "success", result: JSON.stringify({ reasoning: "", done: true, message: "Both tables exist.", outcome: "reached", actions: [] }) });
    expect(reached.outcome).toBe("reached");
    const blocked = turnFromResult({ type: "result", subtype: "success", result: JSON.stringify({ reasoning: "", done: true, message: "The modal has no keyboard path.", outcome: "blocked", actions: [] }) });
    expect(blocked.outcome).toBe("blocked");
    const junk = turnFromResult({ type: "result", subtype: "success", result: JSON.stringify({ reasoning: "", done: true, message: "done", outcome: "success!!", actions: [] }) });
    expect(junk.outcome).toBeUndefined();
    const midRun = turnFromResult({ type: "result", subtype: "success", result: JSON.stringify({ reasoning: "", done: false, message: null, outcome: null, actions: [{ kind: "click", x: 1, y: 1 }] }) });
    expect(midRun.outcome).toBeUndefined();
  });
});
