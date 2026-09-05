import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { CuaTurnRequest } from "../src/computer-use.js";
import { createOpenAiResponsesProvider, type FetchLike } from "../src/openai-responses-cu.js";

// See the adjacent provenance note. Both positive response shapes are excerpts
// of a captured live run; negative cases deliberately mutate that real response.
const pending = JSON.parse(readFileSync(new URL("./fixtures/openai-closing-report/pending-computer-call.json", import.meta.url), "utf8"));
const closing = JSON.parse(readFileSync(new URL("./fixtures/openai-closing-report/typed-closing-report.json", import.meta.url), "utf8"));
const request: CuaTurnRequest = {
  instructions: "Use the synthetic task list.",
  observation: { screenshot: Buffer.from("synthetic-frame"), stateSignature: "saved" },
  contextHint: "The interaction has ended. Report what you observed."
};
const signal = new AbortController().signal;

function harness(second: unknown = closing, status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const delayFn = vi.fn(async () => undefined);
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const value = bodies.length === 1 ? pending : second;
    const code = bodies.length === 1 ? 200 : status;
    return { ok: code === 200, status: code, text: async () => JSON.stringify(value), json: async () => value };
  };
  return { bodies, delayFn, provider: createOpenAiResponsesProvider({ apiKey: "synthetic-key", fetchFn, delayFn, maxRetries: 3, env: {} }) };
}

describe("captured OpenAI closing-report contract", () => {
  it("continues the actual pending computer call once, disables tools, and preserves typed report and usage", async () => {
    const h = harness();
    expect(h.provider.debrief).toBeUndefined();
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({
      previous_response_id: pending.id,
      tool_choice: "none",
      max_output_tokens: 1024,
      text: { format: { type: "json_schema", strict: true, schema: {
        additionalProperties: false, required: ["summary", "frictionReports"]
      } } }
    });
    expect(h.bodies[1]!.input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "computer_call_output", call_id: pending.output[0].call_id })
    ]));
    expect(result.closingReport).toEqual(JSON.parse(closing.output[0].content[0].text));
    expect(result.actions).toEqual([]);
    expect(result.usage).toMatchObject({ input: 13543, output: 221, cacheWriteInput: 13468 });
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it.each(["incomplete", "invalid-json", "extra-key", "empty-summary"])("rejects a %s report while retaining usage", async (kind) => {
    const invalid = structuredClone(closing);
    if (kind === "incomplete") invalid.status = "incomplete";
    if (kind === "invalid-json") invalid.output[0].content[0].text = "{broken";
    if (kind === "extra-key") invalid.output[0].content[0].text = JSON.stringify({ summary: "Saved.", frictionReports: [], extra: true });
    if (kind === "empty-summary") invalid.output[0].content[0].text = JSON.stringify({ summary: "", frictionReports: [] });
    const h = harness(invalid);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(result.closingReport).toBeUndefined();
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
    expect(h.bodies).toHaveLength(2);
  });

  it.each([429, 500])("does not retry a closing request after HTTP %i", async (status) => {
    const h = harness({}, status);
    await h.provider.nextTurn(request, signal);
    await expect(h.provider.debrief!(request, signal)).rejects.toThrow(`OpenAI Responses ${status}`);
    expect(h.bodies).toHaveLength(2);
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it("does not offer a retrospective report without retained conversation history", async () => {
    const provider = createOpenAiResponsesProvider({ apiKey: "synthetic-key", zeroDataRetention: true, env: {},
      fetchFn: async () => ({ ok: true, status: 200, text: async () => "", json: async () => pending }) });
    await provider.nextTurn(request, signal);
    expect(provider.debrief).toBeUndefined();
  });
});
