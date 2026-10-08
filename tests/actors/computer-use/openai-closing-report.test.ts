import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import { ComputerUseAdmissionLimitError } from "../../../src/actors/computer-use/admission-limit.js";

// See the adjacent provenance note. Both positive response shapes are excerpts
// of a captured live run; negative cases deliberately mutate that real response.
const pending = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openai-closing-report/pending-computer-call.json", import.meta.url),
    "utf8",
  ),
);
const closing = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openai-closing-report/typed-closing-report.json", import.meta.url),
    "utf8",
  ),
);
const withImpressions = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/openai-closing-report/typed-closing-report-impressions.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const request: CuaTurnRequest = {
  instructions: "Use the synthetic task list.",
  observation: { screenshot: Buffer.from("synthetic-frame"), stateSignature: "saved" },
  contextHint: "The interaction has ended. Report what you observed.",
};
const signal = new AbortController().signal;

function harness(second: unknown = closing, status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const delayFn = vi.fn(async () => undefined);
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const value = bodies.length === 1 ? pending : second;
    const code = bodies.length === 1 ? 200 : status;
    return {
      ok: code === 200,
      status: code,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  return {
    bodies,
    delayFn,
    provider: createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn,
      delayFn,
      maxRetries: 3,
      env: {},
    }),
  };
}

describe("captured OpenAI closing-report contract", () => {
  it("preserves a local closing-request refusal after a captured interaction without dispatch or retry", async () => {
    const transport = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => pending,
    }));
    const admission = vi.fn(async () => {
      if (transport.mock.calls.length > 0) {
        const error = new ComputerUseAdmissionLimitError();
        error.message = "synthetic-private-payload";
        throw error;
      }
      return transport();
    });
    const delayFn = vi.fn(async () => {});
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn: admission,
      delayFn,
      env: {},
    });
    await provider.nextTurn(request, signal);
    await expect(provider.debrief!(request, signal)).rejects.toThrow(
      new ComputerUseAdmissionLimitError().message,
    );
    expect(admission).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(delayFn).not.toHaveBeenCalled();
  });

  it("continues the actual pending computer call once, disables tools, and preserves typed report and usage", async () => {
    const h = harness();
    expect(h.provider.debrief).toBeUndefined();
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({
      previous_response_id: pending.id,
      tool_choice: "none",
      max_output_tokens: 3072,
      text: {
        format: {
          type: "json_schema",
          strict: true,
          schema: {
            additionalProperties: false,
            required: ["summary", "frictionReports", "impressions"],
            properties: {
              impressions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["kind", "text"],
                  properties: {
                    kind: {
                      enum: [
                        "unclear",
                        "unfinished",
                        "untrustworthy",
                        "liked",
                        "missing",
                        "unlike_my_work",
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(h.bodies[1]!.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "computer_call_output",
          call_id: pending.output[0].call_id,
        }),
      ]),
    );
    expect(result.closingReport).toEqual(JSON.parse(closing.output[0].content[0].text));
    expect(result.actions).toEqual([]);
    expect(result.usage).toMatchObject({ input: 13543, output: 221, cacheWriteInput: 13468 });
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it.each(["incomplete", "invalid-json", "extra-key", "empty-summary"])(
    "rejects a %s report while retaining usage",
    async (kind) => {
      const invalid = structuredClone(closing);
      if (kind === "incomplete") invalid.status = "incomplete";
      if (kind === "invalid-json") invalid.output[0].content[0].text = "{broken";
      if (kind === "extra-key")
        invalid.output[0].content[0].text = JSON.stringify({
          summary: "Saved.",
          frictionReports: [],
          extra: true,
        });
      if (kind === "empty-summary")
        invalid.output[0].content[0].text = JSON.stringify({ summary: "", frictionReports: [] });
      const h = harness(invalid);
      await h.provider.nextTurn(request, signal);
      const result = await h.provider.debrief!(request, signal);
      expect(result.closingReport).toBeUndefined();
      expect(result.usage).toMatchObject({ input: 13543, output: 221 });
      expect(h.bodies).toHaveLength(2);
    },
  );

  it.each([429, 500])("does not retry a closing request after HTTP %i", async (status) => {
    const h = harness({}, status);
    await h.provider.nextTurn(request, signal);
    await expect(h.provider.debrief!(request, signal)).rejects.toThrow(
      `OpenAI Responses ${status}`,
    );
    expect(h.bodies).toHaveLength(2);
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it("does not offer a retrospective report without retained conversation history", async () => {
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      zeroDataRetention: true,
      env: {},
      fetchFn: async () => ({
        ok: true,
        status: 200,
        text: async () => "",
        json: async () => pending,
      }),
    });
    await provider.nextTurn(request, signal);
    expect(provider.debrief).toBeUndefined();
  });
});

describe("limits the OpenAI participant is told", () => {
  const said = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
  const impressionsWire = {
    type: "array",
    maxItems: 6,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text"],
      properties: {
        kind: {
          type: "string",
          enum: ["unclear", "unfinished", "untrustworthy", "liked", "missing", "unlike_my_work"],
        },
        text: said(500),
      },
    },
  };
  const schemaOf = (body: Record<string, unknown> | undefined) =>
    (body?.text as { format: { schema: unknown } } | undefined)?.format.schema;

  it("asks for a closing report within the limits its reply is checked against", async () => {
    const h = harness();
    await h.provider.nextTurn(request, signal);
    await h.provider.debrief!(request, signal);
    expect(schemaOf(h.bodies[1])).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["summary", "frictionReports", "impressions"],
      properties: {
        summary: said(4000),
        frictionReports: { type: "array", maxItems: 8, items: said(2000) },
        impressions: impressionsWire,
      },
    });
  });

  it("asks for impressions only within the same limits", async () => {
    const h = harness();
    await h.provider.nextTurn(request, signal);
    await h.provider.requestImpressions!(request, signal);
    expect(schemaOf(h.bodies[1])).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["impressions"],
      properties: { impressions: impressionsWire },
    });
  });
});

describe("impressions in the captured OpenAI closing report", () => {
  it("keeps the participant's typed impressions from a closing reply", async () => {
    const h = harness(withImpressions);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(result.closingReport?.impressions).toEqual([
      {
        kind: "unclear",
        text: "The Save button looked the same as the task text, so I could not tell it was a button at first.",
      },
      {
        kind: "unlike_my_work",
        text: "On my paper list I cross out the old name and write the new one beside it. Here the old name just disappeared, so I could not check what I had changed.",
      },
    ]);
  });

  it.each([
    ["seven impressions", Array(7).fill({ kind: "liked", text: "The list was easy to scan." })],
    ["an unknown kind", [{ kind: "annoying", text: "The list was slow." }]],
    ["an empty text", [{ kind: "liked", text: " " }]],
    ["a text over 500 characters", [{ kind: "missing", text: "x".repeat(501) }]],
    ["an extra key", [{ kind: "liked", text: "Fast.", screen: "list" }]],
  ])("rejects a report with %s while retaining usage", async (_name, impressions) => {
    const invalid = structuredClone(withImpressions);
    const report = JSON.parse(invalid.output[0].content[0].text);
    invalid.output[0].content[0].text = JSON.stringify({ ...report, impressions });
    const h = harness(invalid);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(result.closingReport).toBeUndefined();
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
  });
});

describe("impressions-only request after the participant ends the session itself", () => {
  const impressionsOnly = JSON.parse(
    readFileSync(
      new URL("../../fixtures/openai-closing-report/impressions-only.json", import.meta.url),
      "utf8",
    ),
  );
  const cutOff = JSON.parse(
    readFileSync(
      new URL("../../fixtures/openai-incomplete/partial-message.json", import.meta.url),
      "utf8",
    ),
  );
  // The captured final answer has no computer call, so as an interaction reply it ends the session.
  const finalAnswer = closing;
  const hint = { ...request, contextHint: "Return only impressions." };

  function sequence(
    replies: unknown[],
    options: { zeroDataRetention?: boolean; status?: number } = {},
  ) {
    const bodies: Record<string, unknown>[] = [];
    const delayFn = vi.fn(async () => undefined);
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const value = replies[bodies.length - 1];
      const code = bodies.length === replies.length ? (options.status ?? 200) : 200;
      return {
        ok: code === 200,
        status: code,
        text: async () => JSON.stringify(value),
        json: async () => value,
      };
    };
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn,
      delayFn,
      maxRetries: 3,
      env: {},
      ...(options.zeroDataRetention ? { zeroDataRetention: true } : {}),
    });
    return { bodies, delayFn, provider };
  }

  it("continues the threaded conversation once with tools off and a schema of impressions only", async () => {
    const h = sequence([finalAnswer, impressionsOnly]);
    const ended = await h.provider.nextTurn(request, signal);
    expect(ended.actions).toEqual([]);
    const result = await h.provider.requestImpressions!(hint, signal);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({
      previous_response_id: finalAnswer.id,
      tool_choice: "none",
      max_output_tokens: 3072,
      text: {
        format: {
          type: "json_schema",
          name: "participant_impressions",
          strict: true,
          schema: { additionalProperties: false, required: ["impressions"] },
        },
      },
    });
    expect(
      Object.keys(
        (h.bodies[1]!.text as { format: { schema: { properties: object } } }).format.schema
          .properties,
      ),
    ).toEqual(["impressions"]);
    expect(JSON.stringify(h.bodies[1]!.input)).toContain("Return only impressions.");
    expect(result.impressions).toEqual(
      JSON.parse(impressionsOnly.output[0].content[0].text).impressions,
    );
    expect(result.closingReport).toBeUndefined();
    expect(result.actions).toEqual([]);
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it("carries the conversation itself in explicit_context", async () => {
    const h = sequence([finalAnswer, impressionsOnly], { zeroDataRetention: true });
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.requestImpressions!(hint, signal);
    expect(h.bodies[1]).not.toHaveProperty("previous_response_id");
    expect(h.bodies[1]).toMatchObject({ store: false, tool_choice: "none" });
    const input = JSON.stringify(h.bodies[1]!.input);
    expect(input).toContain(request.instructions);
    expect(input).toContain("REACHED THE GOAL.");
    expect(result.impressions).toHaveLength(2);
  });

  it.each([
    ["cut off by the output limit", () => cutOff],
    [
      "an extra key",
      () => {
        const reply = structuredClone(impressionsOnly);
        reply.output[0].content[0].text = JSON.stringify({ summary: "Saved.", impressions: [] });
        return reply;
      },
    ],
    [
      "an unknown kind",
      () => {
        const reply = structuredClone(impressionsOnly);
        reply.output[0].content[0].text = JSON.stringify({
          impressions: [{ kind: "annoying", text: "Slow." }],
        });
        return reply;
      },
    ],
  ])("keeps no impressions from a reply %s and makes no second request", async (_name, reply) => {
    const h = sequence([finalAnswer, reply()]);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.requestImpressions!(hint, signal);
    expect(result.impressions).toBeUndefined();
    expect(result.usage?.input).toBeGreaterThan(0);
    expect(h.bodies).toHaveLength(2);
  });

  it("does not retry an impressions request after HTTP 429", async () => {
    const h = sequence([finalAnswer, {}], { status: 429 });
    await h.provider.nextTurn(request, signal);
    await expect(h.provider.requestImpressions!(hint, signal)).rejects.toThrow(
      "OpenAI Responses 429",
    );
    expect(h.bodies).toHaveLength(2);
    expect(h.delayFn).not.toHaveBeenCalled();
  });
});
