import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import {
  AnthropicConversation,
  type ConversationRequest,
} from "../../../src/actors/computer-use/anthropic-conversation.js";
import { HALT_TEXT } from "../../../src/actors/computer-use/anthropic-wire.js";
import type {
  CuaActionAcknowledgement,
  CuaTurnRequest,
} from "../../../src/actors/computer-use/loop/types.js";

// The conversation through its request bodies: what each request carries, that no request edits
// what an earlier one sent, and how each member call is answered. Replies are the captured ones
// in tests/fixtures/anthropic-messages/, each given fresh tool_use ids.

type Body = {
  system: unknown;
  tools: unknown;
  max_tokens: number;
  tool_choice?: unknown;
  output_config: Record<string, unknown>;
  messages: Array<{ role: string; content: unknown }>;
};
type Block = Record<string, unknown>;

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(
      new URL(`../../fixtures/anthropic-messages/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
}

let minted = 0;
/** A captured reply with fresh tool_use ids, as a new reply would carry. */
function reply(name: string, content?: unknown[]): Record<string, unknown> {
  const raw = fixture(name);
  const blocks = (content ?? (raw.content as Block[])).map((block) =>
    (block as Block).type === "tool_use"
      ? { ...(block as Block), id: `toolu_01Minted${++minted}` }
      : block,
  );
  return { ...raw, content: blocks };
}

const call = (name: string, input: Block = {}): Block => ({
  type: "tool_use",
  id: "replaced",
  name,
  input,
  toolset_name: "computer",
  caller: { type: "direct" },
});

const SCREEN = PNG.sync.write(new PNG({ width: 1440, height: 950 }));

function req(patch: Partial<CuaTurnRequest> = {}): CuaTurnRequest {
  return {
    instructions: "You are a busy parent. Add a task called Buy milk.",
    observation: { screenshot: SCREEN, stateSignature: "s" },
    ...patch,
  };
}

const acks = (...statuses: CuaActionAcknowledgement["status"][]) => ({
  actions: statuses.map((status, index) => ({ index, status })),
});

const conversation = (maxOutputTokens = 16_000) =>
  new AnthropicConversation({ model: "claude-haiku-5-5", effort: "medium", maxOutputTokens });

/** The last user message of a body, the one this request added. */
function added(body: Body): Block[] {
  const users = body.messages.filter((entry) => entry.role === "user");
  return users.at(-1)!.content as Block[];
}

describe("an Anthropic participant's conversation", () => {
  it("only appends to what earlier requests sent, over a twelve-turn session", () => {
    const c = conversation();
    const bodies: string[][] = [];
    for (let turn = 0; turn < 12; turn += 1) {
      const request = c.request(
        req({
          ...(turn === 0
            ? {}
            : {
                previousExecution: acks(
                  "completed",
                  "completed",
                  "completed",
                  "completed",
                  "completed",
                ),
              }),
          ...(turn % 3 === 1 ? { contextHint: `The local time is 09:${10 + turn}.` } : {}),
        }),
      );
      const body = request.body as Body;
      bodies.push([
        JSON.stringify(body.system),
        JSON.stringify(body.tools),
        ...body.messages.map((entry) => JSON.stringify(entry)),
      ]);
      request.accept(reply("batch"));
    }
    for (let n = 1; n < bodies.length; n += 1) {
      const before = bodies[n - 1]!;
      expect(bodies[n]!.slice(0, before.length)).toEqual(before);
      expect(bodies[n]!.length).toBeGreaterThan(before.length);
    }
  });

  it("answers every member call of the latest reply once, echoing its toolset", () => {
    const c = conversation();
    const first = reply("batch");
    c.request(req()).accept(first);
    const body = c.request(
      req({
        previousExecution: acks("completed", "completed", "completed", "completed", "completed"),
      }),
    ).body as Body;
    const results = added(body);
    const ids = (first.content as Block[])
      .filter((block) => block.type === "tool_use")
      .map((block) => block.id);
    expect(results.map((result) => result.tool_use_id)).toEqual(ids);
    expect(results.every((result) => result.toolset_name === "computer")).toBe(true);
    // The screen after the batch rides the last result, which completed.
    expect(results.at(-1)!.content).toEqual([
      { type: "text", text: "OK" },
      expect.objectContaining({ type: "image" }),
    ]);
  });

  it("answers a batch that stopped at a failed action with the documented halt text", () => {
    const c = conversation();
    c.request(req()).accept(reply("batch"));
    const results = added(
      c.request(
        req({
          previousExecution: acks(
            "completed",
            "skipped",
            "not_dispatched",
            "not_dispatched",
            "not_dispatched",
          ),
        }),
      ).body as Body,
    );
    const toolResults = results.filter((block) => block.type === "tool_result");
    expect(
      toolResults.map((result) => [result.is_error ?? false, (result.content as Block[])[0]?.text]),
    ).toEqual([
      [false, "OK"],
      [true, "The desktop command failed."],
      [true, HALT_TEXT],
      [true, HALT_TEXT],
      [true, HALT_TEXT],
    ]);
    // An error result may carry text only, so the screen follows the results.
    expect(results.slice(-2)).toEqual([
      { type: "text", text: "This is the screen now." },
      expect.objectContaining({ type: "image" }),
    ]);
  });

  it("answers a call it could not map with its reason, and the calls after it with the halt text", () => {
    const c = conversation();
    c.request(req()).accept(
      reply("batch", [call("type", { text: "milk" }), call("teleport"), call("screenshot")]),
    );
    const results = added(
      c.request(req({ previousExecution: acks("completed", "not_dispatched") })).body as Body,
    );
    const texts = results.map(
      (block) => (block.content as Block[] | undefined)?.[0]?.text ?? block.text,
    );
    expect(texts).toEqual([
      "OK",
      'There is no computer action named "teleport".',
      HALT_TEXT,
      "This is the screen now.",
      undefined,
    ]);
  });

  it("gives harness guidance as a system message after the results", () => {
    const c = conversation();
    c.request(req()).accept(reply("batch"));
    const body = c.request(
      req({
        previousExecution: acks("completed", "completed", "completed", "completed", "completed"),
        contextHint: "The local time is 09:14.",
      }),
    ).body as Body;
    expect(body.messages.slice(-2).map((entry) => entry.role)).toEqual(["user", "system"]);
    expect(body.messages.at(-1)!.content).toBe("The local time is 09:14.");
  });

  it("sends the same request again after a reply cut off at its output limit", () => {
    const c = conversation();
    const first = c.request(req());
    first.accept(reply("max-tokens"));
    expect(c.request(req()).body).toEqual(first.body);
  });

  it("keeps the system prompt the first request set", () => {
    const c = conversation();
    c.request(req()).accept(reply("end-turn"));
    expect(() => c.request(req({ instructions: "Something else." }))).toThrow(/one system prompt/);
  });
});

describe("a read's answer", () => {
  const ZOOMED = PNG.sync.write(new PNG({ width: 300, height: 150 }));
  const readThenType = (
    first: Block,
    ack: CuaActionAcknowledgement,
  ): { results: Block[]; next: ConversationRequest } => {
    const c = conversation();
    c.request(req()).accept(reply("batch", [first, call("type", { text: "milk" })]));
    const previousExecution = { actions: [ack, { index: 1, status: "completed" as const }] };
    const next = c.request(req({ previousExecution }));
    return { results: added(next.body as Body), next };
  };

  it("gives cursor_position the pointer's coordinates", () => {
    const { results } = readThenType(call("cursor_position"), {
      index: 0,
      status: "completed",
      result: { kind: "pointer", x: 512, y: 384 },
    });
    expect(results[0]).toMatchObject({ content: [{ type: "text", text: "X=512, Y=384" }] });
    expect(results[0]!.is_error).toBeUndefined();
  });

  it("gives zoom its image", () => {
    const { results } = readThenType(call("zoom", { region: [0, 0, 300, 150] }), {
      index: 0,
      status: "completed",
      result: { kind: "frame", screenshot: ZOOMED },
    });
    expect(results[0]!.content).toEqual([
      { type: "text", text: "OK" },
      expect.objectContaining({ type: "image" }),
    ]);
  });

  it("enlarges the zoom image to fit the screenshot size, as the toolset documents", () => {
    const strip = PNG.sync.write(new PNG({ width: 220, height: 20 }));
    const { results } = readThenType(call("zoom", { region: [0, 0, 220, 20] }), {
      index: 0,
      status: "completed",
      result: { kind: "frame", screenshot: strip },
    });
    const image = (results[0]!.content as Block[])[1] as { source: { data: string } };
    const shown = PNG.sync.read(Buffer.from(image.source.data, "base64"));
    // The request's screenshot is 1440x950: the strip fills its width, keeping the aspect ratio.
    expect([shown.width, shown.height]).toEqual([1440, 131]);
  });

  it("is an error that halts nothing when the desktop returned nothing", () => {
    const { results } = readThenType(call("cursor_position"), { index: 0, status: "completed" });
    expect(
      results.map((result) => [result.is_error ?? false, (result.content as Block[])[0]?.text]),
    ).toEqual([
      [true, "The desktop returned no pointer position."],
      [false, "OK"],
    ]);
  });

  it("moves the pointer a later coordinate-free click uses", () => {
    const { next } = readThenType(call("cursor_position"), {
      index: 0,
      status: "completed",
      result: { kind: "pointer", x: 70, y: 80 },
    });
    const turn = next.accept(reply("batch", [call("left_click")]));
    expect(turn.actions).toEqual([{ kind: "click", x: 70, y: 80, button: "left" }]);
  });

  it("keeps the batch's last zoom image apart from the screen after the batch", () => {
    const c = conversation();
    c.request(req()).accept(reply("batch", [call("zoom", { region: [0, 0, 300, 150] })]));
    const results = added(
      c.request(
        req({
          previousExecution: {
            actions: [
              { index: 0, status: "completed", result: { kind: "frame", screenshot: ZOOMED } },
            ],
          },
        }),
      ).body as Body,
    );
    expect(results.map((block) => block.type)).toEqual(["tool_result", "text", "image"]);
  });
});

describe("the pointer position a coordinate-free click uses", () => {
  const moveThenClick = (status: CuaActionAcknowledgement["status"]) => {
    const c = conversation();
    c.request(req()).accept(reply("batch", [call("mouse_move", { coordinate: [40, 50] })]));
    return c
      .request(req({ previousExecution: acks(status) }))
      .accept(reply("batch", [call("left_click")]));
  };

  it("is where an acknowledged completed move left it", () => {
    expect(moveThenClick("completed").actions).toEqual([
      { kind: "click", x: 40, y: 50, button: "left" },
    ]);
  });

  it.each(["not_dispatched", "skipped", "outcome_uncertain"] as const)(
    "is unknown after a move acknowledged %s",
    (status) => {
      const turn = moveThenClick(status);
      expect(turn.actions).toEqual([]);
      expect(turn.rejectedProposal?.reason).toMatch(/pointer position is not known/);
    },
  );
});

describe("the closing request", () => {
  it("answers the open calls, asks in text, turns tools off and keeps its own output limit", async () => {
    const c = conversation(2048);
    c.request(req()).accept(reply("batch"));
    const bodies: Body[] = [];
    const turn = await c.close(
      req({ contextHint: "The session is over. Give your closing account." }),
      "impressions",
      async (body) => {
        bodies.push(body as Body);
        return reply("closing-json");
      },
    );
    const [body] = bodies;
    expect(body!.tool_choice).toEqual({ type: "none" });
    expect(body!.max_tokens).toBe(2048);
    expect(body!.output_config).toEqual({ effort: "medium" });
    const content = added(body!);
    expect(content.filter((block) => block.type === "tool_result")).toHaveLength(5);
    expect(content.slice(-2).map((block) => block.type)).toEqual(["text", "text"]);
    // The captured closing reply gives a summary, not impressions, so it is asked once more.
    expect(turn.closingRetry).toBe(true);
  });

  it("asks once more with the schema as the output format and the same messages", async () => {
    const c = conversation();
    c.request(req()).accept(reply("end-turn"));
    const bodies: Body[] = [];
    const send = async (body: Record<string, unknown>) => {
      bodies.push(body as Body);
      return reply("closing-json");
    };
    await c.close(req(), "impressions", send);
    await c.close(req(), "impressions", send);
    expect(bodies[0]!.max_tokens).toBe(4096);
    expect(bodies[1]!.messages).toEqual(bodies[0]!.messages);
    expect(bodies[1]!.output_config).toMatchObject({ format: { type: "json_schema" } });
  });
});
