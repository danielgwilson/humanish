import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createStudyAnalysisProvider, parseStudyAnalysisResponse, type StudyAnalysisProviderRequest } from "../src/study-analysis-provider.js";

// Transport envelope/usage derive from the retained live closing-report response. See that
// fixture's provenance README. Analysis content is synthetic; negative cases mutate that wire.
const captured = JSON.parse(readFileSync(new URL("./fixtures/openai-closing-report/typed-closing-report.json", import.meta.url), "utf8"));
const request: StudyAnalysisProviderRequest = {
  model: "gpt-5.6-sol", instructions: "Review retained evidence only.", evidence: "Synthetic evidence.", images: [],
  schema: { type: "object", additionalProperties: false, properties: { summary: { type: "string" } }, required: ["summary"] },
  maxOutputTokens: 8192, timeoutMs: 1000
};
const response = (body: unknown = captured, status = 200): Response => new Response(JSON.stringify(body), { status });

function wire(text = JSON.stringify({ summary: "The synthetic task was saved." })) {
  const value = structuredClone(captured);
  value.output[0].content[0].text = text;
  return value;
}

describe("study analysis provider boundary", () => {
  it("sends one stateless strict request to a fixed origin, with tools and redirects disabled", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response(wire()));
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })(request);
    expect(result).toMatchObject({ status: "completed", output: { summary: "The synthetic task was saved." },
      usage: { input: 13543, output: 221, cachedInput: 0, cacheWriteInput: 13468 }, dispatched: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body))).toMatchObject({ store: false, tools: [], tool_choice: "none",
      service_tier: "default", truncation: "disabled", max_output_tokens: 8192,
      text: { format: { type: "json_schema", strict: true, schema: request.schema } } });
    expect(String(init?.body)).not.toContain("synthetic-key");
  });

  it("sends local image data with explicit high detail and its evidence key", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => response(wire()));
    const dataUrl = "data:image/png;base64,c3ludGhldGlj";
    await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })({ ...request, images: [{ evidenceId: "e1", dataUrl }] });
    const body = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.input[0].content).toContainEqual({ type: "input_text", text: '{"captureEvidenceId":"e1"}' });
    expect(body.input[0].content).toContainEqual({ type: "input_image", image_url: dataUrl, detail: "high" });
  });

  it.each(["https://example.invalid/capture.png", "file:///private/capture.png", "data:image/svg+xml;base64,c3ludGhldGlj"])("refuses nonlocal/unsupported image %s before dispatch", async dataUrl => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })({ ...request, images: [{ evidenceId: "e1", dataUrl }] });
    expect(result).toMatchObject({ status: "failed", dispatched: false, errorCode: "invalid_request" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])("never retries HTTP %i and never returns provider error prose", async status => {
    const fetchFn = vi.fn<typeof fetch>(async () => response({ error: { message: "synthetic-private-payload" } }, status));
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })(request);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "failed", httpStatus: status, usage: null, dispatched: true, errorCode: "provider_http_error" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-payload");
  });

  it("retains uncertain usage after a single network failure without echoing its message", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error("synthetic-private-payload"); });
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })(request);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ usage: null, dispatched: true, errorCode: "provider_network_error" });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-payload");
  });

  it("honors cancellation before dispatch", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })({ ...request, signal: AbortSignal.abort() });
    expect(result).toMatchObject({ status: "cancelled", dispatched: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["caller", "timeout"])("bounds an in-flight request by %s cancellation without retry", async kind => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("synthetic-private-payload")), { once: true });
      if (kind === "caller") controller.abort();
    }));
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })({ ...request, signal: controller.signal, timeoutMs: 10 });
    expect(result).toMatchObject({ status: kind === "caller" ? "cancelled" : "timed_out", usage: null, dispatched: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("bounds response bytes", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("x".repeat(2 * 1024 * 1024 + 1)));
    const result = await createStudyAnalysisProvider({ apiKey: "synthetic-key", fetchFn })(request);
    expect(result).toMatchObject({ status: "failed", errorCode: "response_too_large", usage: null });
  });

  it.each(["incomplete", "invalid-json", "tool-call", "refusal", "incomplete-message"])("rejects %s output while retaining measured usage", kind => {
    const value = wire();
    if (kind === "incomplete") value.status = "incomplete";
    if (kind === "invalid-json") value.output[0].content[0].text = "{unfinished";
    if (kind === "tool-call") value.output.push({ type: "computer_call" });
    if (kind === "refusal") value.output[0].content[0] = { type: "refusal", refusal: "synthetic refusal" };
    if (kind === "incomplete-message") value.output[0].status = "incomplete";
    expect(parseStudyAnalysisResponse(value)).toMatchObject({ output: null, usage: { input: 13543, output: 221 }, dispatched: true });
    expect(parseStudyAnalysisResponse(value).status).not.toBe("completed");
  });

  it.each(["missing", "negative", "fractional", "missing-output", "overlapping-cache"])("keeps %s usage unknown instead of $0", kind => {
    const value = wire();
    if (kind === "missing") delete value.usage;
    if (kind === "negative") value.usage.input_tokens = -1;
    if (kind === "fractional") value.usage.output_tokens = 0.5;
    if (kind === "missing-output") delete value.usage.output_tokens;
    if (kind === "overlapping-cache") value.usage.input_tokens_details.cached_tokens = 13543;
    expect(parseStudyAnalysisResponse(value)).toMatchObject({ status: "completed", usage: null });
  });
});
