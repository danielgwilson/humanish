import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { CuaObservation } from "../../../src/actors/computer-use/loop.js";
import { pngOfSize, sizeOf } from "../../helpers/zoom-frames.js";
import {
  startClaudeSession,
  turnFromResult,
  userMessage,
  type ClaudeStreamTransport,
} from "../../../src/actors/local-agent/claude-session.js";

const FRAME = Buffer.from("89504e470d0a1a0a", "hex");
const observation = (): CuaObservation => ({ screenshot: FRAME, stateSignature: "s1" });

/** A real Claude Code result message; see tests/fixtures/claude-code-stream-json/README.md. */
const capturedResult = (): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL("../../fixtures/claude-code-stream-json/result-turn.json", import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;

/** A fake Claude Code session. Nothing spawns, nothing is spent, every message is recorded. */
function fakeSession(replies: unknown[]) {
  const sent: Array<Record<string, unknown>> = [];
  let index = 0;
  let closed = 0;
  const transport: ClaudeStreamTransport = {
    turn: async (message) => {
      sent.push(message);
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return {
        type: "result",
        subtype: "success",
        session_id: "sess_1",
        result: JSON.stringify(reply),
        usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 900 },
      };
    },
    close: () => {
      closed += 1;
    },
  };
  return { transport, sent, closedCount: () => closed };
}

const textOf = (message: Record<string, unknown>): string => {
  const inner = message.message as { content: Array<{ text: string }> };
  return inner.content[0]!.text;
};

describe("one Claude Code session as the computer-use brain", () => {
  it("keeps one session for the whole run and states the persona once", async () => {
    // `claude -p` per turn started every turn cold: 188 actions over 90 turns and never finished,
    // against 21 actions over 8 turns for a participant that remembers.
    const { transport, sent } = fakeSession([
      { reasoning: "r", done: false, message: null, actions: [{ kind: "click", x: 1, y: 2 }] },
    ]);
    const session = await startClaudeSession({ transport });
    await session.provider.nextTurn(
      { instructions: "You are Ada. Add two tables.", observation: observation() },
      new AbortController().signal,
    );
    await session.provider.nextTurn(
      { instructions: "You are Ada. Add two tables.", observation: observation() },
      new AbortController().signal,
    );
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
    const { transport, sent } = fakeSession([
      { reasoning: "r", done: false, message: null, actions: [] },
    ]);
    const session = await startClaudeSession({ transport });
    await session.provider.nextTurn(
      { instructions: "i", observation: observation() },
      new AbortController().signal,
    );
    await session.provider.nextTurn(
      { instructions: "i", observation: observation(), contextHint: "the page did not change" },
      new AbortController().signal,
    );
    await session.close();
    expect(textOf(sent[0]!)).toMatch(/Read the image file .*screen-001\.png/);
    expect(textOf(sent[1]!)).toContain("Note from the harness: the page did not change");
  });

  it("reads actions, done and message off the result", () => {
    const turn = turnFromResult({
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        reasoning: "the Add button",
        done: false,
        message: null,
        actions: [
          { kind: "click", x: 10, y: 20 },
          { kind: "type", text: "users" },
        ],
      }),
    });
    expect(turn.actions).toHaveLength(2);
    expect(turn.done).toBe(false);
    expect(turn.reasoning).toBe("the Add button");
    expect(turn.usage).toBeUndefined();
  });

  it("counts cache reads and writes inside input, from a captured result", () => {
    const turn = turnFromResult(capturedResult());
    expect(turn.done).toBe(true);
    expect(turn.message).toBe("Finished.");
    // input_tokens (2) excludes the cache; the prompt was 2 + 30490 read + 2256 written.
    expect(turn.usage).toEqual({
      input: 32748,
      output: 192,
      cachedInput: 30490,
      cacheWriteInput: 2256,
    });
  });

  it("leaves the cache fields absent when Claude Code does not report them", () => {
    const turn = turnFromResult({
      ...capturedResult(),
      usage: { input_tokens: 12, output_tokens: 3 },
    });
    expect(turn.usage).toEqual({ input: 12, output: 3 });
  });

  it("treats a closing message with no actions as done", () => {
    const turn = turnFromResult({
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        reasoning: "",
        done: false,
        message: "Both tables exist; the second one landed on top of the first.",
        actions: [],
      }),
    });
    expect(turn.done).toBe(true);
    expect(turn.message).toContain("landed on top");
  });

  it("a turn without structured output is a broken turn, never an empty one", () => {
    // An empty turn reads to the loop as "the participant chose to do nothing", which ends a
    // study quietly. A thrown error ends it loudly, with the text that came back.
    expect(() =>
      turnFromResult({ type: "result", subtype: "success", result: "I can't see the image." }),
    ).toThrow(/no structured turn output/);
    expect(() =>
      turnFromResult({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }),
    ).toThrow(/error_max_turns/);
  });

  it("closes the session once and only when the run says so", async () => {
    const { transport, closedCount } = fakeSession([
      { reasoning: "r", done: true, message: "done", actions: [] },
    ]);
    const session = await startClaudeSession({ transport });
    await session.provider.nextTurn(
      { instructions: "i", observation: observation() },
      new AbortController().signal,
    );
    expect(closedCount()).toBe(0);
    await session.close();
    expect(closedCount()).toBe(1);
  });

  it("refuses an observation with no frame, because it reasons over pixels", async () => {
    const { transport } = fakeSession([]);
    const session = await startClaudeSession({ transport });
    await expect(
      session.provider.nextTurn(
        { instructions: "i", observation: { stateSignature: "s" } as CuaObservation },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/needs a screenshot/);
    await session.close();
  });

  it("writes the message in the shape stream-json reads on stdin", () => {
    expect(userMessage("hi")).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
  });
});

describe("the participant's declared outcome", () => {
  it("rides the turn when the reply carries one of the three words, and only then", () => {
    const reached = turnFromResult({
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        reasoning: "",
        done: true,
        message: "Both tables exist.",
        outcome: "reached",
        actions: [],
      }),
    });
    expect(reached.outcome).toBe("reached");
    const blocked = turnFromResult({
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        reasoning: "",
        done: true,
        message: "The modal has no keyboard path.",
        outcome: "blocked",
        actions: [],
      }),
    });
    expect(blocked.outcome).toBe("blocked");
    const junk = turnFromResult({
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        reasoning: "",
        done: true,
        message: "done",
        outcome: "success!!",
        actions: [],
      }),
    });
    expect(junk.outcome).toBeUndefined();
    const midRun = turnFromResult({
      type: "result",
      subtype: "success",
      result: JSON.stringify({
        reasoning: "",
        done: false,
        message: null,
        outcome: null,
        actions: [{ kind: "click", x: 1, y: 1 }],
      }),
    });
    expect(midRun.outcome).toBeUndefined();
  });
});

describe("what a Claude Code session is told its last actions read", () => {
  it("hands back a pointer reading as text and a zoom frame as a file in the session folder", async () => {
    const zoomPng = pngOfSize(9, 9);
    const screen = { screenshot: pngOfSize(36, 18), stateSignature: "s1" };
    const seen: Array<{ text: string; zoom?: Buffer }> = [];
    const replies = [
      {
        done: false,
        actions: [
          { kind: "read_pointer" },
          { kind: "zoom", region: { x: 0, y: 0, width: 9, height: 9 } },
        ],
      },
      { done: false, actions: [{ kind: "wait", ms: 100 }] },
      { done: true, message: "done", actions: [] },
    ];
    const transport: ClaudeStreamTransport = {
      turn: async (message) => {
        const text = textOf(message);
        const file = /Read the image file (\S+zoom-\S+\.png)/.exec(text)?.[1];
        seen.push({ text, ...(file === undefined ? {} : { zoom: readFileSync(file) }) });
        return {
          type: "result",
          subtype: "success",
          result: JSON.stringify(replies[seen.length - 1]),
        };
      },
      close: () => undefined,
    };
    const session = await startClaudeSession({ transport });
    const first = await session.provider.nextTurn(
      { instructions: "i", observation: observation() },
      new AbortController().signal,
    );
    expect(first.actions.map((action) => action.kind)).toEqual(["read_pointer", "zoom"]);
    await session.provider.nextTurn(
      {
        instructions: "i",
        observation: screen,
        previousExecution: {
          actions: [
            { index: 0, status: "completed", result: { kind: "pointer", x: 31, y: 47 } },
            { index: 1, status: "completed", result: { kind: "frame", screenshot: zoomPng } },
          ],
        },
      },
      new AbortController().signal,
    );
    const zoomFile = /Read the image file (\S+zoom-\S+\.png)/.exec(seen[1]!.text)![1]!;
    await session.provider.nextTurn(
      {
        instructions: "i",
        observation: observation(),
        previousExecution: { actions: [{ index: 0, status: "completed" }] },
      },
      new AbortController().signal,
    );
    expect(seen[1]!.text).toContain("(31, 47)");
    // The 9x9 crop is handed over enlarged to fit the 36x18 screenshot.
    expect(sizeOf(seen[1]!.zoom!)).toEqual([18, 18]);
    // Once the agent has looked, the crop leaves the disk with the screenshot it came with.
    expect(existsSync(zoomFile)).toBe(false);
    expect(seen[2]!.text).not.toContain("zoom");
    await session.close();
  });
});
