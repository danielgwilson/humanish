import { describe, expect, it } from "vitest";

import type { CuaObservation } from "../../../src/actors/computer-use/loop.js";
import { pngOfSize, sizeOf } from "../../helpers/zoom-frames.js";
import {
  parseAgentJson,
  promptFor,
  proposedActions,
  readResultsNote,
} from "../../../src/actors/local-agent/agent-reply.js";

const FRAME = Buffer.from("89504e470d0a1a0a", "hex");

function observation(): CuaObservation {
  return { screenshot: FRAME, stateSignature: "s1" };
}

describe("the action vocabulary a local agent answers in", () => {
  it("maps the kinds it is allowed to use", () => {
    expect(proposedActions([{ kind: "click", x: 10, y: 20 }])).toEqual({
      actions: [{ kind: "click", x: 10, y: 20 }],
    });
    expect(proposedActions([{ kind: "type", text: "hello" }]).actions).toEqual([
      { kind: "type", text: "hello" },
    ]);
    expect(proposedActions([{ kind: "keypress", keys: ["Control", "a"] }]).actions).toEqual([
      { kind: "keypress", keys: ["Control", "a"] },
    ]);
  });

  it("offers every desktop action, with the fields each one takes", () => {
    expect(
      proposedActions([
        { kind: "triple_click", x: 40, y: 60 },
        { kind: "mouse_down", button: "left", x: 5, y: 6 },
        { kind: "mouse_up" },
        { kind: "hold_keys", keys: ["shift"], ms: 800 },
        { kind: "read_pointer" },
        { kind: "zoom", region: { x: 0, y: 0, width: 200, height: 100 } },
        { kind: "scroll", x: 100, y: 200, dx: 0, dy: 300 },
        {
          kind: "drag",
          path: [
            { x: 1, y: 2 },
            { x: 30, y: 40 },
          ],
        },
      ]).actions,
    ).toEqual([
      { kind: "triple_click", x: 40, y: 60 },
      { kind: "mouse_down", button: "left", x: 5, y: 6 },
      { kind: "mouse_up" },
      { kind: "hold_keys", keys: ["shift"], ms: 800 },
      { kind: "read_pointer" },
      { kind: "zoom", region: { x: 0, y: 0, width: 200, height: 100 } },
      { kind: "scroll", x: 100, y: 200, dx: 0, dy: 300 },
      {
        kind: "drag",
        path: [
          { x: 1, y: 2 },
          { x: 30, y: 40 },
        ],
      },
    ]);
  });

  it("reads a null field as absent", () => {
    expect(
      proposedActions([{ kind: "click", x: 52, y: 12, text: null, keys: null, ms: null }]).actions,
    ).toEqual([{ kind: "click", x: 52, y: 12 }]);
  });

  it("rejects the first proposal it cannot honour, runs the ones before it and says why", () => {
    // A click with no coordinates is not a click at (0,0). Filling that in would record a
    // coordinate the participant never chose, in evidence someone is meant to trust.
    for (const bad of [
      { kind: "click" },
      { kind: "type", text: 7 },
      { kind: "keypress", keys: [] },
      { kind: "teleport", x: 1, y: 2 },
      { kind: "zoom", region: { x: 0, y: 0, width: "wide", height: 10 } },
    ]) {
      const read = proposedActions([{ kind: "read_pointer" }, bad, { kind: "type", text: "x" }]);
      expect(read.actions).toEqual([{ kind: "read_pointer" }]);
      expect(read.rejectedProposal?.reason).toMatch(/^Action 2 \(/);
    }
  });

  it("skips a done marker in the actions, which carries no action", () => {
    expect(proposedActions([{ kind: "done" }, { kind: "wait", ms: 500 }])).toEqual({
      actions: [{ kind: "wait", ms: 500 }],
    });
  });
});

describe("what the agent's last actions read", () => {
  it("states a pointer reading as text and saves a zoom frame for the agent to Read", async () => {
    const zoomPng = pngOfSize(8, 3);
    const saved: Array<{ index: number; png: Buffer }> = [];
    const note = await readResultsNote(
      {
        instructions: "i",
        observation: { screenshot: pngOfSize(40, 30), stateSignature: "s1" },
        previousExecution: {
          actions: [
            { index: 0, status: "completed", result: { kind: "pointer", x: 412, y: 300 } },
            { index: 1, status: "completed" },
            { index: 2, status: "completed", result: { kind: "frame", screenshot: zoomPng } },
          ],
        },
      },
      async (index, png) => {
        saved.push({ index, png });
        return `/work/zoom-${index}.png`;
      },
    );
    // The crop is saved enlarged to fit the 40x30 screenshot: 8x3 at 5x.
    expect(saved.map(({ index, png }) => [index, sizeOf(png)])).toEqual([[2, [40, 15]]]);
    expect(note).toContain("(412, 300)");
    expect(note).toContain("/work/zoom-2.png");
  });

  it("says nothing when the last actions read nothing", async () => {
    const note = await readResultsNote(
      {
        instructions: "i",
        observation: observation(),
        previousExecution: { actions: [{ index: 0, status: "completed" }] },
      },
      async () => "/unused.png",
    );
    expect(note).toBe("");
  });
});

describe("the turn prompt", () => {
  it("tells Claude Code how long a turn of only waits can last and says nothing about the screen", () => {
    const prompt = promptFor(
      { instructions: "Wait for the reply.", observation: observation() },
      "/tmp/turn.png",
    );
    expect(prompt).toContain(
      "A turn whose actions are only waits and that asks for some wait time asks to wait its waits' ms together; an ask shorter than a wait whose ms is null counts as one, and named ms count up to the study's longest wait",
    );
    expect(prompt).toContain("The note at the end says how long you waited and why it ended.");
    expect(prompt).not.toMatch(/harness/i);
    expect(prompt).toContain(
      "A wait among other actions lasts its ms, and the note says when the study's limit for one wait shortened it.",
    );
    expect(prompt).not.toMatch(/screen changes|reload|longer than/);
  });

  it("offers the agent every action kind of the shared participant schema", () => {
    const prompt = promptFor({ instructions: "i", observation: observation() }, "/tmp/turn.png");
    for (const kind of [
      "click",
      "double_click",
      "triple_click",
      "move",
      "scroll",
      "drag",
      "mouse_down",
      "mouse_up",
      "type",
      "keypress",
      "hold_keys",
      "wait",
      "read_pointer",
      "zoom",
    ])
      expect(prompt).toContain(`{"kind":"${kind}"`);
    expect(prompt).not.toContain('{"kind":"speak"');
  });
});

describe("reading the agent's answer", () => {
  it("accepts clean JSON and JSON wrapped in a fence", () => {
    // Codex returns the first; Claude Code returns the second. One parser, because a surface where
    // one adapter works and the other silently does not is worse than either.
    expect(parseAgentJson('{"done":true}')).toEqual({ done: true });
    expect(parseAgentJson('here you go\n```json\n{"done":false}\n```\n')).toEqual({ done: false });
  });

  it("treats an answer with no JSON as a turn error, never as an empty turn", () => {
    // An empty turn reads to the loop as "the participant chose to do nothing", which is a
    // finding. A CLI that returned prose is a broken turn, which is not.
    expect(() => parseAgentJson("I could not see the screenshot.")).toThrow(
      /did not return a JSON object/,
    );
  });
});
