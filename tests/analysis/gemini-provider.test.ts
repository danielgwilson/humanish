import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  createAnalysisProvider,
  type AnalysisFetch,
  type AnalysisProviderRequest,
} from "../../src/analysis/provider.js";

// A captured generateContent response; see the fixture's readme. Negative cases mutate that wire.
const captured = JSON.parse(
  readFileSync(
    new URL("../fixtures/gemini-generate-content/structured-answer.json", import.meta.url),
    "utf8",
  ),
);
const request: AnalysisProviderRequest = {
  model: "gemini-3.8-flash",
  instructions: "Review retained evidence only.",
  evidence: "Synthetic evidence.",
  images: [],
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { summary: { type: "string" } },
    required: ["summary"],
  },
  maxOutputTokens: 8192,
  timeoutMs: 1000,
};
const response = (body: unknown = captured, status = 200): Response =>
  new Response(JSON.stringify(body), { status });
const gemini = (fetchFn: AnalysisFetch) =>
  createAnalysisProvider({ vendor: "gemini", apiKey: "synthetic-key", fetchFn });

function wire(mutate: (value: typeof captured) => void = () => {}) {
  const value = structuredClone(captured);
  mutate(value);
  return value;
}
const sent = (fetchFn: ReturnType<typeof vi.fn<AnalysisFetch>>) =>
  JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));

describe("the Gemini analysis request", () => {
  it("sends one stateless request to the model's fixed endpoint with the key in a header", async () => {
    const fetchFn = vi.fn<AnalysisFetch>(async () => response());
    const result = await gemini(fetchFn)(request);
    expect(result).toEqual({
      status: "completed",
      output: {
        summary:
          "The participant successfully saved a draft invoice and observed the confirmation toast notification.",
      },
      usage: { input: 1124, output: 183 },
      dispatched: true,
      errorCode: null,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
    );
    expect(init.redirect).toBe("error");
    expect(init.headers["x-goog-api-key"]).toBe("synthetic-key");
    expect(init.body).not.toContain("synthetic-key");
    expect(sent(fetchFn)).toEqual({
      systemInstruction: { parts: [{ text: "Review retained evidence only." }] },
      contents: [{ parts: [{ text: "Synthetic evidence." }] }],
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: "HIGH" },
        responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: request.schema } },
      },
      serviceTier: "standard",
      store: false,
    });
  });

  it("sends each capture as inline data at high media resolution after its evidence key", async () => {
    const fetchFn = vi.fn<AnalysisFetch>(async () => response());
    await gemini(fetchFn)({
      ...request,
      images: [{ evidenceId: "e1", dataUrl: "data:image/webp;base64,c3ludGhldGlj" }],
    });
    expect(sent(fetchFn).contents[0].parts).toEqual([
      { text: "Synthetic evidence." },
      { text: '{"captureEvidenceId":"e1"}' },
      {
        inlineData: { mimeType: "image/webp", data: "c3ludGhldGlj" },
        mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" },
      },
    ]);
  });

  it("drops the array limits Gemini refuses and keeps the rest of the schema", async () => {
    const fetchFn = vi.fn<AnalysisFetch>(async () => response());
    const items = { type: "string", pattern: "^[A-Za-z0-9]+$" };
    await gemini(fetchFn)({
      ...request,
      schema: {
        type: "object",
        properties: {
          ids: { type: "array", items, minItems: 1, maxItems: 40 },
          maxItems: { type: "integer" },
        },
        required: ["ids", "maxItems"],
      },
    });
    expect(sent(fetchFn).systemInstruction.parts[0].text).toBe(
      "Review retained evidence only.\n\nThe response schema sent with this request omits its array limits. Keep each array at or under its limit, by field path: ids: 40.",
    );
    expect(sent(fetchFn).generationConfig.responseFormat.text.schema).toEqual({
      type: "object",
      properties: {
        ids: { type: "array", items, minItems: 1 },
        maxItems: { type: "integer" },
      },
      required: ["ids", "maxItems"],
    });
  });
});

describe("the Gemini analysis response", () => {
  it.each([
    ["MAX_TOKENS", "incomplete", "output_incomplete"],
    ["CONTINUATION", "incomplete", "output_incomplete"],
    ["SAFETY", "refused", "refusal"],
    ["RECITATION", "refused", "refusal"],
    ["PROHIBITED_CONTENT", "refused", "refusal"],
    ["BLOCKLIST", "refused", "refusal"],
    ["SPII", "refused", "refusal"],
    ["OTHER", "failed", "invalid_response"],
    ["MALFORMED_RESPONSE", "failed", "invalid_response"],
    [undefined, "failed", "invalid_response"],
  ])("ends a %s candidate as %s, keeping its usage", async (finishReason, status, errorCode) => {
    const fetchFn = vi.fn<AnalysisFetch>(async () =>
      response(
        wire((value) => {
          value.candidates[0].finishReason = finishReason;
        }),
      ),
    );
    expect(await gemini(fetchFn)(request)).toEqual({
      status,
      output: null,
      usage: { input: 1124, output: 183 },
      dispatched: true,
      errorCode,
    });
  });

  it("records a blocked prompt as a refusal", async () => {
    const blocked = wire((value) => {
      delete value.candidates;
      value.promptFeedback = { blockReason: "PROHIBITED_CONTENT" };
    });
    expect(
      await gemini(vi.fn<AnalysisFetch>(async () => response(blocked)))(request),
    ).toMatchObject({ status: "refused", output: null, errorCode: "refusal", dispatched: true });
  });

  it.each([
    ["a thought summary part", { text: "Synthetic thought.", thought: true }, "completed"],
    ["a second answer part", { text: '{"summary":"Another."}' }, "failed"],
    ["a function call part", { functionCall: { name: "synthetic", args: {} } }, "failed"],
  ])("reads one answer part: with %s the result is %s", async (_name, part, status) => {
    const value = wire((wireValue) => {
      wireValue.candidates[0].content.parts.push(part);
    });
    const result = await gemini(vi.fn<AnalysisFetch>(async () => response(value)))(request);
    expect(result.status).toBe(status);
  });

  it("fails an answer that is not JSON", async () => {
    const value = wire((wireValue) => {
      wireValue.candidates[0].content.parts[0].text = "{unfinished";
    });
    expect(await gemini(vi.fn<AnalysisFetch>(async () => response(value)))(request)).toMatchObject({
      status: "failed",
      errorCode: "invalid_response",
      output: null,
    });
  });

  it.each([
    [
      "counts cache hits as cached input",
      { cachedContentTokenCount: 1000 },
      { input: 1124, output: 183, cachedInput: 1000 },
    ],
    [
      "counts tool-use prompt tokens as input",
      { toolUsePromptTokenCount: 10, totalTokenCount: 1317 },
      { input: 1134, output: 183 },
    ],
    [
      "counts an absent thoughts count as zero",
      { thoughtsTokenCount: undefined, totalTokenCount: 1147 },
      { input: 1124, output: 23 },
    ],
    ["keeps usage unknown without a prompt count", { promptTokenCount: undefined }, null],
    ["keeps usage unknown when the total disagrees", { totalTokenCount: 1306 }, null],
    ["keeps usage unknown for a negative count", { candidatesTokenCount: -1 }, null],
    ["keeps usage unknown for a cache larger than input", { cachedContentTokenCount: 1125 }, null],
  ])("%s", async (_name, change, usage) => {
    const value = wire((wireValue) => {
      Object.assign(wireValue.usageMetadata, change);
    });
    const result = await gemini(vi.fn<AnalysisFetch>(async () => response(value)))(request);
    expect(result.usage).toEqual(usage);
  });
});

describe("the transport around a Gemini request", () => {
  it.each([400, 429, 503])(
    "never retries HTTP %i and never keeps its error prose",
    async (status) => {
      const fetchFn = vi.fn<AnalysisFetch>(async () =>
        response({ error: { code: status, message: "synthetic-private-payload" } }, status),
      );
      const result = await gemini(fetchFn)(request);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        status: "failed",
        output: null,
        usage: null,
        dispatched: true,
        errorCode: "provider_http_error",
        httpStatus: status,
      });
    },
  );

  it("bounds response bytes", async () => {
    const fetchFn = vi.fn<AnalysisFetch>(async () => new Response("x".repeat(2 * 1024 * 1024 + 1)));
    expect(await gemini(fetchFn)(request)).toMatchObject({
      status: "failed",
      errorCode: "response_too_large",
      usage: null,
    });
  });

  it("refuses a request over the byte cap before sending it", async () => {
    const fetchFn = vi.fn<AnalysisFetch>();
    const result = await gemini(fetchFn)({ ...request, evidence: "x".repeat(32 * 1024 * 1024) });
    expect(result).toMatchObject({
      status: "failed",
      dispatched: false,
      errorCode: "invalid_request",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("ends an in-flight request at its deadline without retry", async () => {
    const fetchFn = vi.fn<AnalysisFetch>(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("synthetic-private")), {
            once: true,
          });
        }),
    );
    const result = await gemini(fetchFn)({ ...request, timeoutMs: 10 });
    expect(result).toEqual({
      status: "timed_out",
      output: null,
      usage: null,
      dispatched: true,
      errorCode: "timeout",
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
