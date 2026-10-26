import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  parseMessage,
  screenImage,
  type Point,
} from "../../../src/actors/computer-use/anthropic-wire.js";

// The Messages reply as the loop sees it: member calls as desktop actions, narration, stop reasons
// and usage, from captured replies (tests/fixtures/anthropic-messages/README.md).

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../fixtures/anthropic-messages/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

/** The captured batch reply with its member calls replaced by `calls`, as name and input. */
function replyCalling(calls: Array<[string, Record<string, unknown>]>): Record<string, unknown> {
  return {
    ...fixture("batch"),
    content: calls.map(([name, input], index) => ({
      type: "tool_use",
      id: `toolu_01Members${index}`,
      name,
      input,
      toolset_name: "computer",
      caller: { type: "direct" },
    })),
  };
}

function png(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

describe("a captured batch reply", () => {
  it("runs its member calls in order as desktop actions", () => {
    const { turn, calls } = parseMessage(fixture("batch"), undefined);
    expect(turn.actions).toEqual([
      { kind: "click", x: 651, y: 192, button: "left" },
      { kind: "type", text: "Buy milk" },
      { kind: "click", x: 922, y: 192, button: "left" },
      { kind: "wait", ms: 1000 },
      { kind: "screenshot" },
    ]);
    expect(calls.map((call) => call.positions)).toEqual([[0], [1], [2], [3], [4]]);
    expect(turn.message).toBe('I\'ll click the task input, type "Buy milk", and click Add.');
    expect(turn.done).toBe(false);
  });

  it("counts cache reads and writes as part of its input", () => {
    // 1,992 uncached + 0 read + 3,456 written.
    expect(parseMessage(fixture("batch"), undefined).turn.usage).toEqual({
      input: 5448,
      output: 162,
      cachedInput: 0,
      cacheWriteInput: 3456,
      turns: [{ input: 5448, output: 162, cachedInput: 0, cacheWriteInput: 3456 }],
    });
  });

  it("carries a thinking summary as reasoning, with thinking inside its output", () => {
    const { turn } = parseMessage(fixture("thinking-batch"), undefined);
    expect(turn.reasoning).toMatch(/^I'll add the tasks one at a time/);
    expect(turn.usage).toMatchObject({ input: 5998, output: 309, cacheWriteInput: 5994 });
  });
});

describe("how a reply ends", () => {
  it("ends the session with a message when it calls no member", () => {
    const { turn } = parseMessage(fixture("end-turn"), undefined);
    expect(turn).toMatchObject({ done: true, actions: [] });
    expect(turn.message).toMatch(/^I added "Buy milk"/);
  });

  it("is cut off at the output limit without acting", () => {
    expect(parseMessage(fixture("max-tokens"), undefined).turn).toMatchObject({
      interruption: "output_limit",
      done: false,
    });
  });

  it("is a refusal with its category and billed usage (documented shape)", () => {
    expect(parseMessage(fixture("documented-refusal"), undefined).turn).toMatchObject({
      interruption: "refused",
      refusalCategory: "cyber",
      done: false,
      usage: { input: 6376, output: 3 },
    });
  });
});

describe("usage per inference", () => {
  it("prices a compaction as an inference of its own, with the cache it wrote", () => {
    // Captured: the compaction read the 56,422-token conversation without the toolset, writing
    // 56,182 of it to the cache, and the reply then read the 5,852-token summary and toolset.
    expect(parseMessage(fixture("compaction"), undefined).turn.usage).toEqual({
      input: 62_274,
      output: 2067,
      cachedInput: 0,
      cacheWriteInput: 62_032,
      turns: [
        { input: 56_422, output: 1762, cachedInput: 0, cacheWriteInput: 56_182 },
        { input: 5852, output: 305, cachedInput: 0, cacheWriteInput: 5850 },
      ],
    });
  });

  it("says when a reply starts from a compaction summary", () => {
    expect(parseMessage(fixture("compaction"), undefined).compacted).toBe(true);
    expect(parseMessage(fixture("batch"), undefined).compacted).toBe(false);
    // A summarization that called a tool returns the block with no summary, which the API then
    // skips, so nothing before it was replaced.
    const failed = fixture("compaction");
    const [, ...rest] = failed.content as unknown[];
    const empty = { ...failed, content: [{ type: "compaction", content: null }, ...rest] };
    expect(parseMessage(empty, undefined).compacted).toBe(false);
  });

  it("leaves out notes cut off at the output limit, and the reasoning built on them", () => {
    // Captured: the summarization wrote 16,000 tokens, the request's max_tokens, and its notes
    // stop mid-sentence. Applying them would replace the session with a fragment.
    const parsed = parseMessage(fixture("compaction-cut-off"), undefined, 16_000);
    expect(parsed.compacted).toBe(false);
    expect(parsed.content.map((block) => (block as { type: string }).type)).toEqual(["tool_use"]);
    expect(parsed.turn).toMatchObject({ actions: [{ kind: "screenshot" }], done: false });
    expect(parsed.turn.interruption).toBeUndefined();
    expect(parsed.turn.notices?.map((notice) => notice.title)).toEqual([
      "participant notes cut off",
    ]);
    // Notes that came back whole are applied.
    expect(parseMessage(fixture("compaction"), undefined, 16_000).compacted).toBe(true);
  });

  it("says why a reply billed outside the global standard rates cannot be priced", () => {
    const batch = fixture("batch");
    const usage = batch.usage as Record<string, unknown>;
    const served = (patch: Record<string, unknown>) =>
      parseMessage({ ...batch, usage: { ...usage, ...patch } }, undefined).unpricedUsage;
    expect(served({})).toBeUndefined();
    expect(served({ inference_geo: "us" })).toMatch(/inference region "us"/);
    expect(served({ service_tier: "priority" })).toMatch(/service tier "priority"/);
    expect(
      served({ cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 40 } }),
    ).toMatch(/40 tokens to the 1-hour prompt cache/);
  });
});

describe("member calls", () => {
  const pointer: Point = { x: 300, y: 400 };

  it("click at the pointer when they name no coordinate", () => {
    const { turn } = parseMessage(replyCalling([["right_click", {}]]), pointer);
    expect(turn.actions).toEqual([{ kind: "click", x: 300, y: 400, button: "right" }]);
  });

  it("click where an earlier call of the same batch moved the pointer", () => {
    const { turn } = parseMessage(
      replyCalling([
        ["mouse_move", { coordinate: [40, 50] }],
        ["left_click", {}],
      ]),
      undefined,
    );
    expect(turn.actions[1]).toEqual({ kind: "click", x: 40, y: 50, button: "left" });
  });

  it("stop at a click with no coordinate while the pointer position is unknown", () => {
    const { turn, calls } = parseMessage(
      replyCalling([
        ["type", { text: "milk" }],
        ["left_click", {}],
        ["key", { text: "Return" }],
      ]),
      undefined,
    );
    expect(turn.actions).toEqual([{ kind: "type", text: "milk" }]);
    expect(turn.rejectedProposal?.reason).toMatch(/^left_click named no coordinate/);
    expect(calls.map((call) => call.positions)).toEqual([[0], [1], []]);
  });

  it("run Claude's precise pointer and keyboard members as their desktop actions", () => {
    const { turn } = parseMessage(
      replyCalling([
        ["triple_click", { text: "shift" }],
        ["left_mouse_down", {}],
        ["mouse_move", { coordinate: [600, 410] }],
        ["left_mouse_up", { coordinate: [610, 410] }],
        ["hold_key", { text: "ctrl+shift", duration: 1.5 }],
      ]),
      pointer,
    );
    expect(turn.actions).toEqual([
      { kind: "triple_click", x: 300, y: 400, heldKeys: ["shift"] },
      { kind: "mouse_down", button: "left" },
      { kind: "move", x: 600, y: 410 },
      { kind: "mouse_up", button: "left", x: 610, y: 410 },
      { kind: "hold_keys", keys: ["ctrl", "shift"], ms: 1500 },
    ]);
  });

  it("read the pointer and zoom into a region given by its corners", () => {
    const { turn } = parseMessage(
      replyCalling([
        ["cursor_position", {}],
        ["zoom", { region: [100, 200, 400, 350] }],
      ]),
      undefined,
    );
    expect(turn.actions).toEqual([
      { kind: "read_pointer" },
      { kind: "zoom", region: { x: 100, y: 200, width: 300, height: 150 } },
    ]);
  });

  it.each([
    ["zoom", { region: [400, 200, 100, 350] }, /^zoom needs region/],
    ["hold_key", { text: "shift", duration: 45 }, /at most 30 seconds/],
    ["hold_key", { text: "shift" }, /^hold_key needs duration/],
  ] as const)("refuse %s %j, saying what it needs", (name, input, reason) => {
    const { turn } = parseMessage(replyCalling([[name, input]]), pointer);
    expect(turn.rejectedProposal?.reason).toMatch(reason);
  });

  it("refuse a member the toolset does not have", () => {
    expect(parseMessage(replyCalling([["teleport", {}]]), pointer).turn.rejectedProposal).toEqual({
      reason: 'There is no computer action named "teleport".',
    });
  });

  it("press a key combination as many times as it repeats", () => {
    const { turn, calls } = parseMessage(
      replyCalling([
        ["key", { text: "ctrl+shift+t", repeat: 3 }],
        ["key", { text: "+" }],
      ]),
      undefined,
    );
    expect(turn.actions).toEqual([
      { kind: "keypress", keys: ["ctrl", "shift", "t"] },
      { kind: "keypress", keys: ["ctrl", "shift", "t"] },
      { kind: "keypress", keys: ["ctrl", "shift", "t"] },
      { kind: "keypress", keys: ["+"] },
    ]);
    expect(calls.map((call) => call.positions)).toEqual([[0, 1, 2], [3]]);
  });

  it("hold their modifiers through a click and scroll by wheel clicks", () => {
    const { turn } = parseMessage(
      replyCalling([
        ["left_click", { coordinate: [5, 6], text: "ctrl+shift" }],
        ["scroll", { coordinate: [10, 20], scroll_direction: "down", scroll_amount: 3 }],
        ["scroll", { scroll_direction: "left", scroll_amount: 1 }],
        ["left_click_drag", { start_coordinate: [1, 2], coordinate: [3, 4] }],
      ]),
      undefined,
    );
    expect(turn.actions).toEqual([
      { kind: "click", x: 5, y: 6, button: "left", heldKeys: ["ctrl", "shift"] },
      { kind: "scroll", x: 10, y: 20, dx: 0, dy: 300 },
      { kind: "scroll", x: 10, y: 20, dx: -100, dy: 0 },
      {
        kind: "drag",
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ],
      },
    ]);
  });
});

describe("the screenshot sent", () => {
  it("is a PNG image block at the default desktop size", () => {
    expect(screenImage(png(1440, 950))).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
  });

  it.each([
    [2001, 900],
    [1960, 1960],
  ])("is refused before any request at %ix%i", (width, height) => {
    expect(() => screenImage(png(width, height))).toThrow(/execution\.desktop\.resolution/);
  });
});
