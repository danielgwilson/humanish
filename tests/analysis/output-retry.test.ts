import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveAutomaticAnalysis } from "../../src/analysis/automatic-config.js";
import { estimateAnalysisAdmission, runAnalysis } from "../../src/analysis/execute.js";
import type { AnalysisFetch, AnalysisProvider } from "../../src/analysis/provider.js";
import type { AnalysisConfig, AnalysisInput } from "../../src/analysis/types.js";
import { digestAnalysisInput, validateAnalysisArtifact } from "../../src/analysis/validation.js";
import { syntheticInput as packetWithCapture, syntheticResult } from "./fixtures.js";

// Envelopes and usage come from captured live responses; provenance:
// fixtures/openai-closing-report/README.md and fixtures/openai-incomplete/README.md. Only the
// synthetic answer and the token counts are replaced.
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const completed = fixture("openai-closing-report/typed-closing-report.json");
const incomplete = fixture("openai-incomplete/reasoning-only.json");

/** The synthetic packet without its capture, which has no image bytes to send. */
function syntheticInput(): AnalysisInput {
  const value = packetWithCapture();
  value.evidence = value.evidence.filter((entry) => entry.capture === null);
  value.coverage = { ...value.coverage, evidenceCount: 1, captureCount: 0 };
  value.inputDigest = digestAnalysisInput(value);
  return value;
}

const config: AnalysisConfig = {
  model: "gpt-6.1-sol",
  reasoningEffort: "medium",
  question: null,
  maxCostUsd: 10,
  timeoutMs: 1000,
  maxOutputTokens: 14_336,
};

/** An incomplete response that spent the whole output allowance on 25,754 input tokens. */
function ranOut(outputTokens = config.maxOutputTokens!): Response {
  const wire = structuredClone(incomplete) as { usage: Record<string, unknown> };
  wire.usage = {
    input_tokens: 25_754,
    input_tokens_details: { cache_write_tokens: 25_751, cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: outputTokens },
    total_tokens: 25_754 + outputTokens,
  };
  return new Response(JSON.stringify(wire));
}

function finished(): Response {
  const wire = structuredClone(completed) as {
    output: Array<{ content: Array<{ text: string }> }>;
  };
  wire.output[0]!.content[0]!.text = JSON.stringify(syntheticResult(syntheticInput()));
  return new Response(JSON.stringify(wire));
}

/** A fetch that answers each request with the next response in `answers`. */
function answering(...answers: Array<() => Response>) {
  const queue = [...answers];
  return vi.fn<AnalysisFetch>(async () => queue.shift()!());
}

describe("a request that runs out of output", () => {
  it("is sent once more, and the attempt keeps the second answer and counts both", async () => {
    const fetch = answering(ranOut, finished);
    const warnings: string[] = [];
    const artifact = await runAnalysis(syntheticInput(), config, {
      apiKey: "synthetic-key",
      fetch,
      warnings,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [first, second] = fetch.mock.calls.map(([, init]) => init.body);
    expect(second).toBe(first);
    // The captured completed response used 13,543 input and 221 output tokens.
    expect(artifact).toMatchObject({
      status: "complete",
      error: null,
      usage: {
        inputTokens: 25_754 + 13_543,
        outputTokens: 14_336 + 221,
        dispatched: true,
        usageComplete: true,
      },
    });
    expect(artifact.result?.findings).toEqual(syntheticResult(syntheticInput()).findings);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^The analysis request ran out of output before it finished its report: 14336 of 14336 output tokens, 25754 input tokens, \$0\.21\. humanish sent the same request once more; the attempt's usage counts both requests\.$/,
      ),
    ]);
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("fails with output_incomplete when the second request also runs out", async () => {
    const fetch = answering(ranOut, ranOut);
    const warnings: string[] = [];
    const artifact = await runAnalysis(syntheticInput(), config, {
      apiKey: "synthetic-key",
      fetch,
      warnings,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(artifact).toMatchObject({
      status: "failed",
      result: null,
      error: "analysis_output_incomplete",
      usage: { inputTokens: 2 * 25_754, outputTokens: 2 * 14_336, usageComplete: true },
    });
    expect(warnings).toEqual([
      expect.stringMatching(/humanish sent the same request once more/),
      "The analysis request ran out of output again, so this attempt has no report.",
    ]);
  });

  it("is not sent again when the spend so far and the retry would pass the cap", async () => {
    // Admission admits one request under $0.25. The first request bills $0.21, and another
    // request at admission's estimate would take the spend past $0.25.
    const capped = { ...config, maxCostUsd: 0.25 };
    expect(estimateAnalysisAdmission(syntheticInput(), capped).allowed).toBe(true);
    const fetch = answering(ranOut, finished);
    const warnings: string[] = [];
    const artifact = await runAnalysis(syntheticInput(), capped, {
      apiKey: "synthetic-key",
      fetch,
      warnings,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(artifact).toMatchObject({ status: "failed", error: "analysis_output_incomplete" });
    expect(warnings).toEqual([
      expect.stringMatching(
        /^The analysis request ran out of output before it finished its report: 14336 of 14336 output tokens, 25754 input tokens, \$0\.21\. humanish did not send it again: the \$0\.21 spent so far plus \$0\.\d\d for one more request at admission's estimate is over the \$0\.25 cap\./,
      ),
    ]);
  });

  it("is not sent again when its usage is unknown", async () => {
    const fetch = answering(() => {
      const wire = structuredClone(incomplete);
      delete wire.usage;
      return new Response(JSON.stringify(wire));
    }, finished);
    const warnings: string[] = [];
    const artifact = await runAnalysis(syntheticInput(), config, {
      apiKey: "synthetic-key",
      fetch,
      warnings,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(artifact).toMatchObject({ status: "failed", error: "analysis_output_incomplete" });
    expect(warnings).toEqual([
      expect.stringMatching(/did not report its usage, so humanish cannot tell whether a second/),
    ]);
  });

  it("keeps a retried report complete when the bill passes one request's worst case", async () => {
    // Admission priced one request. A retry that spends most of the allowance first bills more
    // than that request's worst case, and less than the worst case of both.
    const admission = estimateAnalysisAdmission(syntheticInput(), config);
    const artifact = await runAnalysis(syntheticInput(), config, {
      apiKey: "synthetic-key",
      fetch: answering(ranOut, finished),
    });
    expect(artifact.usage.estimatedCostUsd).toBeGreaterThan(admission.worstCaseCostUsd!);
    expect(artifact).toMatchObject({ status: "complete", error: null });
  });

  it("is not sent again by the Codex account analyst, which has no cost cap", async () => {
    const codexProvider = vi.fn<AnalysisProvider>(async () => ({
      status: "incomplete",
      output: null,
      usage: { input: 100, output: 20 },
      usageComplete: true,
      dispatched: true,
      errorCode: "output_incomplete",
    }));
    const selected = resolveAutomaticAnalysis({ provider: "codex", timeoutMs: 1000 });
    if (!selected.ok || selected.config?.provider !== "codex") throw new Error("not Codex");
    const artifact = await runAnalysis(syntheticInput(), selected.config, { codexProvider });
    expect(codexProvider).toHaveBeenCalledTimes(1);
    expect(artifact).toMatchObject({ status: "failed", error: "analysis_output_incomplete" });
  });
});

/** A finished run of `count` participants, one statement each: two cohorts past 16. */
function runOf(count: number): AnalysisInput {
  const streamIds = Array.from(
    { length: count },
    (_, index) => `p${String(index).padStart(2, "0")}`,
  );
  const base = packetWithCapture();
  const value: AnalysisInput = {
    ...base,
    participants: streamIds.map((streamId) => ({ ...base.participants[0]!, streamId })),
    coverage: {
      ...base.coverage,
      includedStreamIds: streamIds,
      evidenceCount: count,
      captureCount: 0,
    },
    evidence: streamIds.map((streamId, index) => ({
      ...base.evidence[1]!,
      id: `e${String(index + 1).padStart(6, "0")}`,
      eventId: `account-${index}`,
      streamId,
    })),
  };
  value.inputDigest = digestAnalysisInput(value);
  return value;
}

/** The packet a request sent, from the OpenAI request body. */
function sentPacket(body: string): { cohorts?: unknown[] } & Pick<AnalysisInput, "participants"> {
  return JSON.parse(JSON.parse(body).input[0].content[0].text);
}

/** Each cohort request's report on its own participants, and the merge request's answer. */
function cohortAnswer(body: string): Response {
  const packet = sentPacket(body) as unknown as AnalysisInput & { cohorts?: unknown[] };
  const answer = packet.cohorts
    ? {
        summary: "Each participant said they could not create the item.",
        concernReviews: [],
        findings: [],
        designFindings: [],
        limitations: ["Synthetic fixture."],
      }
    : syntheticResult({
        ...packet,
        evidence: packet.evidence.map((entry) => ({ ...entry, capture: null })),
      });
  const wire = structuredClone(completed) as {
    output: Array<{ content: Array<{ text: string }> }>;
  };
  wire.output[0]!.content[0]!.text = JSON.stringify(answer);
  return new Response(JSON.stringify(wire));
}

describe("a request of a run analysed in cohorts that runs out of output", () => {
  it("is the merge request, sent once more, and the attempt keeps one report", async () => {
    let merges = 0;
    const fetch = vi.fn<AnalysisFetch>(async (_url, init) =>
      sentPacket(init.body).cohorts && merges++ === 0 ? ranOut() : cohortAnswer(init.body),
    );
    const warnings: string[] = [];
    const input = runOf(17);
    const artifact = await runAnalysis(input, config, { apiKey: "synthetic-key", fetch, warnings });
    expect(fetch.mock.calls.map(([, init]) => sentPacket(init.body).cohorts !== undefined)).toEqual(
      [false, false, true, true],
    );
    expect(artifact).toMatchObject({
      status: "complete",
      error: null,
      usage: { inputTokens: 3 * 13_543 + 25_754, outputTokens: 3 * 221 + 14_336 },
    });
    expect(artifact.result!.participants).toHaveLength(17);
    expect(warnings).toEqual([
      expect.stringMatching(
        /^The request that merges the 2 cohort reports ran out of output before it finished its report: .* humanish sent the same request once more/,
      ),
    ]);
    expect(validateAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("is not sent again when the requests still to come leave no room under the cap", async () => {
    const input = runOf(17);
    // A cap that admits the three requests and leaves nothing for a fourth.
    const capped = {
      ...config,
      maxCostUsd: estimateAnalysisAdmission(input, config).admittedCostUsd!,
    };
    const fetch = vi.fn<AnalysisFetch>(async (_url, init) =>
      sentPacket(init.body).participants.some((entry) => entry.streamId === "p00")
        ? ranOut()
        : cohortAnswer(init.body),
    );
    const warnings: string[] = [];
    const artifact = await runAnalysis(input, capped, { apiKey: "synthetic-key", fetch, warnings });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(artifact).toMatchObject({ status: "failed", error: "analysis_output_incomplete" });
    expect(warnings[0]).toMatch(
      /^The request for one cohort \(9 of the 17 participants\) ran out of output .* humanish did not send it again: the \$\d+\.\d\d spent so far, the \$\d+\.\d\d admission holds for requests still running, plus /,
    );
  });
});
