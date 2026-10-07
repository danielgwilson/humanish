import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  automaticAnalysisBudget,
  resolveAutomaticAnalysis,
} from "../../src/analysis/automatic-config.js";
import {
  estimateAnalysisAdmission,
  preferLargerAnalysisOutput,
} from "../../src/analysis/execute.js";
import type { AnalysisConfig, AnalysisInput } from "../../src/analysis/types.js";
import { digestAnalysisInput } from "../../src/analysis/validation.js";

/** The first 33 bytes of a PNG: signature, then an IHDR chunk carrying the size. */
function pngBytes(width: number, height: number, salt: number): Buffer {
  const bytes = Buffer.alloc(33 + 4);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(salt, 33); // keeps each capture's sha256 distinct
  return bytes;
}

interface PacketShape {
  participants: number;
  /** Evidence entries, captures included. */
  entries: number;
  /** UTF-8 bytes of evidence text, spread over the entries. */
  textBytes: number;
  captures: number;
  width?: number;
  height?: number;
}

/**
 * A packet shaped like a retained run: entries carry the same fields, id lengths and timestamps a
 * captured run does, so the packet's structure costs what a real one costs.
 */
function packet(shape: PacketShape): AnalysisInput {
  const { participants, entries, textBytes, captures, width = 1440, height = 950 } = shape;
  const streamIds = Array.from(
    { length: participants },
    (_unused, i) => `player-${String(i + 1).padStart(2, "0")}`,
  );
  const input: AnalysisInput = {
    runId: "concurrent-shared-world-synthetic",
    sourceRunSha256: "a".repeat(64),
    inputDigest: "",
    participants: streamIds.map((streamId, i) => ({
      streamId,
      label: `Player ${i + 1}`,
      assignment: "Join the lobby, pick a seat at the table and start a round with the others.",
      recordedStatus: "passed",
      recordedReason: "goal_satisfied",
      provenance: {
        actorStatus: null,
        completionReason: null,
        stopCause: null,
        goalSource: null,
        declaredOutcome: "reached",
        taskOutcomes: null,
      },
    })),
    coverage: {
      includedStreamIds: streamIds,
      omittedStreamIds: [],
      evidenceCount: entries,
      captureCount: captures,
      complete: true,
      omissions: [],
    },
    evidence: [],
    images: [],
  };
  const captureEvery = captures === 0 ? Infinity : Math.floor(entries / captures);
  let captured = 0;
  for (let i = 0; i < entries; i += 1) {
    const id = `e${String(i + 1).padStart(6, "0")}`;
    const eventId = `evt-${String(i + 1).padStart(9, "0")}`;
    const share = Math.floor(textBytes / entries) + (i < textBytes % entries ? 1 : 0);
    const capture = captured < captures && i % captureEvery === 0;
    const base = {
      id,
      streamId: streamIds[i % participants]!,
      eventId,
      kind: capture ? "screenshot" : "ui_action",
      text: "x".repeat(share),
      quoteEligible: false,
      at: new Date(Date.UTC(2026, 8, 27, 20, 57) + i * 1500).toISOString(),
      elapsedMs: i * 1500,
      frame: i,
    };
    if (!capture) {
      input.evidence.push({ ...base, capture: null });
      continue;
    }
    captured += 1;
    const bytes = pngBytes(width, height, captured);
    input.evidence.push({
      ...base,
      capture: {
        eventId,
        path: `screenshots/${id}.png`,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/png",
      },
    });
    input.images.push({
      evidenceId: id,
      dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    });
  }
  input.inputDigest = digestAnalysisInput(input);
  return input;
}

type OpenAIConfig = Exclude<AnalysisConfig, { provider: "codex" }>;

/** The configuration an undeclared analysis gets, as automatic analysis resolves it. */
function defaultConfig(): OpenAIConfig {
  const resolved = resolveAutomaticAnalysis(undefined);
  if (!resolved.ok || !resolved.config || resolved.config.provider === "codex")
    throw new Error("the default analysis did not resolve to OpenAI");
  return resolved.config;
}

/**
 * Retained gpt-6-astra analyses: each packet's shape and the cost the provider billed. Every
 * capture was 1440 by 950. The packets are rebuilt synthetically with the same participants,
 * entries, evidence text bytes and captures.
 */
const BILLED = [
  {
    participants: 8,
    entries: 800,
    textBytes: 27_309,
    captures: 40,
    allowance: 32_768,
    input: 129_678,
    usd: 2.457068,
  },
  {
    participants: 2,
    entries: 309,
    textBytes: 21_486,
    captures: 40,
    allowance: 32_768,
    input: 95_002,
    usd: 1.823374,
  },
  {
    participants: 2,
    entries: 203,
    textBytes: 12_587,
    captures: 40,
    allowance: 16_384,
    input: 84_915,
    usd: 1.679816,
  },
  {
    participants: 1,
    entries: 105,
    textBytes: 7_404,
    captures: 24,
    allowance: 32_768,
    input: 50_658,
    usd: 1.233054,
  },
  {
    participants: 1,
    entries: 13,
    textBytes: 1_823,
    captures: 0,
    allowance: 32_768,
    input: 4_062,
    usd: 0.106889,
  },
] as const;

describe("analysis admission estimate", () => {
  it.each(BILLED)(
    "expects at least the $usd billed for $participants participants and $entries entries",
    ({ allowance, input, usd, ...shape }) => {
      const config = { ...defaultConfig(), maxCostUsd: 1000, maxOutputTokens: allowance };
      const admission = estimateAnalysisAdmission(packet(shape), config);
      expect(admission.inputTokenAllowance).toBeGreaterThanOrEqual(input);
      expect(admission.estimatedCostUsd).toBeGreaterThanOrEqual(usd);
      // Analyses that cost a dollar or more are expected within half again their bill.
      if (usd >= 1) expect(admission.estimatedCostUsd).toBeLessThanOrEqual(usd * 1.5);
      expect(admission.worstCaseCostUsd).toBeGreaterThanOrEqual(admission.estimatedCostUsd!);
    },
  );

  it("admits a 6-participant study's analysis under the default cap", () => {
    // 800 entries and 40 captures are the packet limits; the text matches a large retained run.
    const input = packet({ participants: 6, entries: 800, textBytes: 27_309, captures: 40 });
    const config = preferLargerAnalysisOutput(input, defaultConfig());
    const admission = estimateAnalysisAdmission(input, config);
    expect(admission).toMatchObject({ allowed: true, error: null, maxCostUsd: 3 });
    expect(admission.estimatedCostUsd).toBeLessThan(3);
    expect(admission.worstCaseCostUsd).toBeGreaterThan(admission.estimatedCostUsd!);
  });

  it("expands the default output allowance only when the cap admits the larger one", () => {
    const input = packet({ participants: 8, entries: 800, textBytes: 27_309, captures: 40 });
    const base = { ...defaultConfig(), maxOutputTokens: 16_384 };
    const larger = { ...base, maxOutputTokens: 32_768 };
    expect(preferLargerAnalysisOutput(input, base)).toEqual(larger);
    // Eight participants are expected to write more than 16,384 tokens, so the larger allowance
    // raises the expected cost as well as the worst case.
    const small = estimateAnalysisAdmission(input, { ...base, maxCostUsd: 1000 });
    const large = estimateAnalysisAdmission(input, { ...larger, maxCostUsd: 1000 });
    expect(large.estimatedCostUsd).toBeGreaterThan(small.estimatedCostUsd!);
    const between = { ...base, maxCostUsd: 2.8 };
    expect(estimateAnalysisAdmission(input, between).allowed).toBe(true);
    expect(estimateAnalysisAdmission(input, { ...between, maxOutputTokens: 32_768 }).allowed).toBe(
      false,
    );
    expect(preferLargerAnalysisOutput(input, between)).toEqual(between);
    const denied = { ...base, maxCostUsd: 0.000001 };
    expect(preferLargerAnalysisOutput(input, denied)).toEqual(denied);
    expect(estimateAnalysisAdmission(input, denied).allowed).toBe(false);
    const explicit = { ...base, maxOutputTokens: 8192 };
    expect(preferLargerAnalysisOutput(input, explicit)).toEqual(explicit);
  });

  it("gives study check a range that brackets a 6-participant study's packets", () => {
    const range = automaticAnalysisBudget(undefined, "computer-use", 6)?.expectedCostUsd;
    const config = { ...defaultConfig(), maxCostUsd: 1000 };
    const expected = (shape: PacketShape) =>
      estimateAnalysisAdmission(packet(shape), preferLargerAnalysisOutput(packet(shape), config))
        .estimatedCostUsd!;
    const smallest = expected({ participants: 6, entries: 6, textBytes: 60, captures: 0 });
    // The packet limits: 800 entries, 160 KiB of text and 40 captures.
    const largest = expected({
      participants: 6,
      entries: 800,
      textBytes: 160 * 1024 - 6 * 200,
      captures: 40,
    });
    expect(range!.low).toBeLessThanOrEqual(smallest);
    expect(range!.high).toBeGreaterThanOrEqual(largest);
    expect(range!.high).toBeLessThan(largest * 1.5);
  });
});
