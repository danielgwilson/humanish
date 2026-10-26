import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import { createOpenAiResponsesProvider } from "../../../src/actors/computer-use/openai-provider.js";
import { type FetchLike } from "../../../src/actors/computer-use/provider-http.js";
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
const impressionsOnly = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openai-closing-report/impressions-only.json", import.meta.url),
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
    const h = harness(withImpressions);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({
      previous_response_id: pending.id,
      tool_choice: "none",
      max_output_tokens: 3072,
    });
    expect(h.bodies[1]).not.toHaveProperty("text");
    expect(h.bodies[1]!.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "computer_call_output",
          call_id: pending.output[0].call_id,
        }),
      ]),
    );
    expect(result.closingReport).toEqual(JSON.parse(withImpressions.output[0].content[0].text));
    expect(result.actions).toEqual([]);
    expect(result.usage).toMatchObject({ input: 13543, output: 221, cacheWriteInput: 13468 });
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it.each([
    ["incomplete", undefined],
    ["invalid-json", true],
    ["extra-key", true],
    ["empty-summary", true],
  ])("rejects a %s report while retaining usage; closingRetry %s", async (kind, closingRetry) => {
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
    expect(result.closingRetry).toBe(closingRetry);
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
    expect(h.bodies).toHaveLength(2);
  });

  it.each([429, 500])("does not retry a closing request after HTTP %i", async (status) => {
    const h = harness({}, status);
    await h.provider.nextTurn(request, signal);
    await expect(h.provider.debrief!(request, signal)).rejects.toThrow(
      `OpenAI Responses ${status}`,
    );
    expect(h.bodies).toHaveLength(2);
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it("asks for the report on the conversation the client carries, with tools off", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      zeroDataRetention: true,
      env: {},
      fetchFn: async (_url: string, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const value = bodies.length === 1 ? pending : withImpressions;
        return { ok: true, status: 200, text: async () => "", json: async () => value };
      },
    });
    await provider.nextTurn(request, signal);
    await provider.debrief!(request, signal);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ store: false, tool_choice: "none" });
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    // The report request carries the first turn's opening message and reply.
    expect(JSON.stringify(bodies[1]!.input)).toContain(
      JSON.stringify(bodies[0]!.input).slice(1, 40),
    );
  });
});

describe("a closing request that reads the session's cache", () => {
  // OpenAI's cache reads a request's prefix: the model, instructions, tools, reasoning settings,
  // text.format and the conversation before the new input. A closing request that changes any of
  // them pays to write the whole session again.
  async function nextBodies(zeroDataRetention: boolean, close: boolean) {
    const bodies: Record<string, unknown>[] = [];
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      maxOutputTokens: 8192,
      env: {},
      ...(zeroDataRetention ? { zeroDataRetention: true } : {}),
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        const value = bodies.length === 1 ? pending : closing;
        return { ok: true, status: 200, text: async () => "", json: async () => value };
      },
    });
    await provider.nextTurn(request, signal);
    await (close ? provider.debrief!(request, signal) : provider.nextTurn(request, signal));
    return bodies;
  }

  it.each([false, true])(
    "sends the next turn's prefix with tools off and no text.format, explicit context %s",
    async (zeroDataRetention) => {
      const turn = (await nextBodies(zeroDataRetention, false))[1]!;
      const closingBody = (await nextBodies(zeroDataRetention, true))[1]!;
      const { input: turnInput, max_output_tokens: _turnLimit, ...turnFields } = turn;
      const { input: closingInput, tool_choice, max_output_tokens, ...closingFields } = closingBody;
      expect(closingFields).toEqual(turnFields);
      expect(closingBody).not.toHaveProperty("text");
      expect(tool_choice).toBe("none");
      expect(max_output_tokens).toBe(3072);
      expect((closingInput as unknown[]).slice(0, (turnInput as unknown[]).length)).toEqual(
        turnInput,
      );
    },
  );
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
    expect(result.closingRetry).toBe(true);
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
    expect(h.bodies).toHaveLength(2);
  });
});

describe("impressions-only request after the participant ends the session itself", () => {
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

  it("continues the threaded conversation once with tools off and states a schema of impressions only", async () => {
    const h = sequence([finalAnswer, impressionsOnly]);
    const ended = await h.provider.nextTurn(request, signal);
    expect(ended.actions).toEqual([]);
    const result = await h.provider.requestImpressions!(hint, signal);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({
      previous_response_id: finalAnswer.id,
      tool_choice: "none",
      max_output_tokens: 3072,
    });
    expect(h.bodies[1]).not.toHaveProperty("text");
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
    ["cut off by the output limit", 2, () => cutOff],
    [
      "an extra key",
      3,
      () => {
        const reply = structuredClone(impressionsOnly);
        reply.output[0].content[0].text = JSON.stringify({ summary: "Saved.", impressions: [] });
        return reply;
      },
    ],
    [
      "an unknown kind",
      3,
      () => {
        const reply = structuredClone(impressionsOnly);
        reply.output[0].content[0].text = JSON.stringify({
          impressions: [{ kind: "annoying", text: "Slow." }],
        });
        return reply;
      },
    ],
  ])("keeps no impressions from a reply %s, after %i requests", async (_name, requests, reply) => {
    const h = sequence([finalAnswer, reply(), reply()]);
    await h.provider.nextTurn(request, signal);
    // As the loop asks: once, and once more for a reply marked closingRetry.
    const first = await h.provider.requestImpressions!(hint, signal);
    const result = first.closingRetry ? await h.provider.requestImpressions!(hint, signal) : first;
    expect(result.impressions).toBeUndefined();
    expect(result.usage?.input).toBeGreaterThan(0);
    expect(h.bodies).toHaveLength(requests);
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
