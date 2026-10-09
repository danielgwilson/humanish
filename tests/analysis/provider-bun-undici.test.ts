// Under Bun, `undici` resolves to Bun's built-in module, whose Agent has no destroy() and whose
// fetch ignores a dispatcher. The provider tears its agent down after every request, and that
// teardown must never replace the request's own result.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("undici", () => {
  class Agent {
    dispatch(): boolean {
      return true;
    }
  }
  return { Agent, fetch: () => Promise.reject(new Error("the test injects fetchFn")) };
});

const { createAnalysisProvider } = await import("../../src/analysis/provider.js");
type AnalysisFetch = import("../../src/analysis/provider.js").AnalysisFetch;

const captured = JSON.parse(
  readFileSync(
    new URL("../fixtures/openai-closing-report/typed-closing-report.json", import.meta.url),
    "utf8",
  ),
);
captured.output[0].content[0].text = JSON.stringify({ summary: "The synthetic task was saved." });

const request = {
  model: "gpt-5.6-sol",
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

describe("the analysis provider with an undici Agent that has no destroy()", () => {
  it("returns the completed analysis", async () => {
    const fetchFn = vi.fn<AnalysisFetch>(
      async () => new Response(JSON.stringify(captured), { status: 200 }),
    );
    const result = await createAnalysisProvider({ apiKey: "synthetic-key", fetchFn })(request);
    expect(result).toMatchObject({
      status: "completed",
      output: { summary: "The synthetic task was saved." },
      dispatched: true,
    });
  });

  it("returns a provider failure as that failure", async () => {
    const fetchFn = vi.fn<AnalysisFetch>(async () => new Response("{}", { status: 500 }));
    const result = await createAnalysisProvider({ apiKey: "synthetic-key", fetchFn })(request);
    expect(result).toMatchObject({
      status: "failed",
      errorCode: "provider_http_error",
      httpStatus: 500,
      dispatched: true,
    });
  });
});
