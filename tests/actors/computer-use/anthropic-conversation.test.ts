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

describe("a server-side compaction", () => {
  it("after a compaction, sends the compacted reply first and nothing from before it", () => {
    const c = conversation();
    const done = (count: number) => ({
      previousExecution: acks(...Array.from({ length: count }, () => "completed" as const)),
    });
    c.request(req()).accept(reply("batch"));
    c.request(req(done(5))).accept(reply("batch"));
    const compacting = c.request(req(done(5)));
    const compaction = reply("compaction");
    compacting.accept(compaction);
    const after = c.request(req(done(1))).body as Body;
    // The server reads nothing before the compaction block, so the client stops sending it.
    expect(after.messages[0]).toEqual({ role: "assistant", content: compaction.content });
    expect(after.messages.slice(1).map((entry) => entry.role)).toEqual(["user"]);
    expect(JSON.stringify(after).length).toBeLessThan(JSON.stringify(compacting.body).length / 2);
    // From the compaction on, the history is appended to again.
    const later = c.request(req(done(1)));
    later.accept(reply("batch"));
    const last = c.request(req(done(5))).body as Body;
    expect(last.messages.slice(0, after.messages.length)).toEqual(after.messages);
  });

  it("is not recorded when its reply is set aside and asked again", () => {
    const c = conversation();
    c.request(req()).accept(reply("batch"));
    const compacting = c.request(req({ previousExecution: acks("completed", "completed") }));
    compacting.accept({ ...reply("compaction"), stop_reason: "max_tokens" });
    expect(c.request(req({ previousExecution: acks("completed", "completed") })).body).toEqual(
      compacting.body,
    );
    const record = c.record();
    expect(record.requests.at(-1)!.compacted).toBeUndefined();
    expect(record.summarizedTurns).toBe(0);
  });

  it("after cut-off notes, carries the whole conversation again and only appends to it", () => {
    const c = conversation();
    c.request(req()).accept(reply("batch"));
    const done = {
      previousExecution: acks("completed", "completed", "completed", "completed", "completed"),
    };
    const cutOff = c.request(req(done));
    cutOff.accept(reply("compaction-cut-off"));
    const next = c.request(req({ previousExecution: acks("completed") })).body as Body;
    const sent = (cutOff.body as Body).messages;
    expect(next.messages.slice(0, sent.length)).toEqual(sent);
    const answered = next.messages[sent.length]!.content as Block[];
    expect(answered.map((block) => block.type)).toEqual(["tool_use"]);
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

describe("a screenshot before the end of its batch", () => {
  const midImage = new PNG({ width: 1440, height: 950 });
  midImage.data.fill(200);
  const MID = PNG.sync.write(midImage);
  const answered = (ack: CuaActionAcknowledgement): Block[] => {
    const c = conversation();
    c.request(req()).accept(
      reply("batch", [
        call("left_click", { coordinate: [10, 20] }),
        call("screenshot"),
        call("type", { text: "milk" }),
      ]),
    );
    const previousExecution = {
      actions: [
        { index: 0, status: "completed" as const },
        ack,
        { index: 2, status: "completed" as const },
      ],
    };
    return added(c.request(req({ previousExecution })).body as Body);
  };
  const imageData = (result: Block | undefined): string | undefined =>
    ((result?.content as Block[] | undefined)?.[1] as { source?: { data?: string } } | undefined)
      ?.source?.data;

  it("answers with the frame the desktop captured there", () => {
    const results = answered({
      index: 1,
      status: "completed",
      result: { kind: "frame", screenshot: MID },
    });
    expect(results[1]!.is_error).toBeUndefined();
    expect(imageData(results[1])).toBe(MID.toString("base64"));
    // The screen after the batch still rides the last result.
    expect(imageData(results[2])).toBe(SCREEN.toString("base64"));
  });

  it("points to the screen after the batch when the desktop returned no frame", () => {
    const results = answered({ index: 1, status: "completed" });
    expect((results[1]!.content as Block[]).map((block) => block.type)).toEqual(["text"]);
    expect(results[1]!.is_error).toBeUndefined();
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
  it("reads the session uncompacted, keeping earlier notes valid", async () => {
    // A closing request's 4,096-token limit would cut off a compaction's notes, and the account
    // should come from the whole session since the last notes. Compaction blocks already sent
    // are only accepted alongside the compaction strategy, so it stays, with a trigger the
    // request cannot reach.
    const c = conversation();
    c.request(req()).accept(reply("compaction"));
    let body: Record<string, unknown> | undefined;
    await c.close(req({ previousExecution: acks("completed") }), "report", async (payload) => {
      body = JSON.parse(payload) as Record<string, unknown>;
      return reply("closing-report");
    });
    expect(body!.context_management).toEqual({
      edits: [
        expect.objectContaining({
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 1_000_000 },
        }),
      ],
    });
  });

  it("answers the open calls, asks in text, turns tools off and keeps its own output limit", async () => {
    const c = conversation(2048);
    c.request(req()).accept(reply("batch"));
    const bodies: Body[] = [];
    const turn = await c.close(
      req({ contextHint: "The session is over. Give your closing account." }),
      "impressions",
      async (payload) => {
        bodies.push(JSON.parse(payload) as Body);
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
    const send = async (payload: string) => {
      bodies.push(JSON.parse(payload) as Body);
      return reply("closing-json");
    };
    await c.close(req(), "impressions", send);
    await c.close(req(), "impressions", send);
    expect(bodies[0]!.max_tokens).toBe(4096);
    expect(bodies[1]!.messages).toEqual(bodies[0]!.messages);
    expect(bodies[1]!.output_config).toMatchObject({ format: { type: "json_schema" } });
  });

  // The Messages API answers a schema with an array maxItems with a 400 at
  // output_config.format.schema, so the strict retry would never get a reply.
  it.each(["impressions", "report"] as const)(
    "sends the %s retry schema with no array item limit",
    async (closing) => {
      const c = conversation();
      c.request(req()).accept(reply("end-turn"));
      const bodies: Body[] = [];
      const send = async (payload: string) => {
        bodies.push(JSON.parse(payload) as Body);
        return reply("closing-json");
      };
      await c.close(req(), closing, send);
      await c.close(req(), closing, send);
      const format = bodies[1]!.output_config.format as { schema: Record<string, unknown> };
      expect(JSON.stringify(format.schema)).not.toContain("maxItems");
      expect(format.schema).toMatchObject({ type: "object", additionalProperties: false });
    },
  );
});
