import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { estimateStudyAnalysisAdmission } from "../../src/analysis/engine.js";
import { highDetailImageTokens } from "../../src/analysis/image-tokens.js";
import type { StudyAnalysisConfig, StudyAnalysisInput } from "../../src/analysis/study-analysis.js";
import { digestStudyAnalysisInput } from "../../src/analysis/validation.js";
import { syntheticInput } from "./fixtures.js";

/** The first 33 bytes of a PNG: signature, then an IHDR chunk carrying the size. */
function pngBytes(width: number, height: number, salt = 0): Buffer {
  const bytes = Buffer.alloc(33 + 4);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(salt, 33); // keeps each capture's sha256 distinct
  return bytes;
}
const pngUrl = (width: number, height: number) =>
  `data:image/png;base64,${pngBytes(width, height).toString("base64")}`;

describe("high-detail image tokens", () => {
  it("follows the vision guide's patch formula for gpt-6-astra", () => {
    // The guide's own examples.
    expect(highDetailImageTokens("gpt-6-astra", pngUrl(1024, 1024))).toBe(1229);
    expect(highDetailImageTokens("gpt-6-astra", pngUrl(2048, 2048))).toBe(3000);
    // The capture sizes of the 2026-09-30 live pass.
    expect(highDetailImageTokens("gpt-6-astra", pngUrl(1440, 950))).toBe(1620);
    expect(highDetailImageTokens("gpt-6-astra", pngUrl(500, 896))).toBe(538);
    // Past the 2,500-patch budget the image is scaled down, so the budget bounds it.
    expect(highDetailImageTokens("gpt-6-astra", pngUrl(100_000, 10))).toBe(3000);
  });

  it("falls back to the 3,000-token ceiling when the size or the model's sizing is unknown", () => {
    const jpeg = `data:image/jpeg;base64,${Buffer.alloc(40, 1).toString("base64")}`;
    const notPng = `data:image/png;base64,${Buffer.alloc(40, 1).toString("base64")}`;
    const zeroWide = pngUrl(0, 950);
    expect(highDetailImageTokens("gpt-6-astra", jpeg)).toBe(3000);
    expect(highDetailImageTokens("gpt-6-astra", notPng)).toBe(3000);
    expect(highDetailImageTokens("gpt-6-astra", zeroWide)).toBe(3000);
    expect(highDetailImageTokens("gpt-6-astra", "data:image/png;base64,iVBORw0K")).toBe(3000);
    // The guide lists no sizing for a plain gpt-5.6 id.
    expect(highDetailImageTokens("gpt-5.6", pngUrl(1024, 1024))).toBe(3000);
  });
});

/**
 * Today's four billed analyses (2026-09-30 live pass). `textBytes` is each run's measured text
 * term (UTF-8 bytes of instructions, evidence and schema, plus 2,048 framing); `billedInput` is the
 * input token count the provider billed for that analysis.
 */
const BILLED = [
  { run: "persona-contrast", images: [[40, 1440, 950]], textBytes: 87_786, billedInput: 87_081 },
  { run: "try-live", images: [[10, 1440, 950]], textBytes: 32_957, billedInput: 23_035 },
  { run: "try-live 2 lanes", images: [[11, 1440, 950]], textBytes: 38_453, billedInput: 26_132 },
  {
    run: "shared-world",
    images: [
      [6, 1440, 950],
      [3, 500, 896],
    ],
    textBytes: 32_617,
    billedInput: 17_877,
  },
] as const;

const config: StudyAnalysisConfig = {
  provider: "openai",
  model: "gpt-6-astra",
  question: null,
  timeoutMs: 600_000,
  maxCostUsd: 1000,
  maxOutputTokens: 32_768,
};

// Evidence items have a size limit, so the padding is spread over this many messages.
const MESSAGES = 16;

/** A valid packet with the given captures and `padding` characters spread over the messages. */
function packet(sizes: readonly (readonly [number, number, number])[], padding: number) {
  const input: StudyAnalysisInput = syntheticInput();
  const message = input.evidence.find((item) => item.capture === null)!;
  input.evidence = Array.from({ length: MESSAGES }, (_unused, i) => ({
    ...message,
    id: `m${String(i + 1).padStart(6, "0")}`,
    eventId: `message-${i + 1}`,
    text: "x".repeat(Math.floor(padding / MESSAGES) + (i < padding % MESSAGES ? 1 : 0)),
  }));
  input.images = [];
  let n = 0;
  for (const [count, width, height] of sizes) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      const bytes = pngBytes(width, height, n);
      const id = `c${String(n).padStart(6, "0")}`;
      input.evidence.push({
        ...message,
        id,
        eventId: `capture-${n}`,
        kind: "screenshot",
        text: "Capture",
        quoteEligible: false,
        capture: {
          eventId: `capture-${n}`,
          path: `captures/${id}.png`,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mimeType: "image/png",
        },
      });
      input.images.push({
        evidenceId: id,
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
      });
    }
  }
  input.coverage = { ...input.coverage, evidenceCount: input.evidence.length, captureCount: n };
  input.inputDigest = digestStudyAnalysisInput(input);
  return input;
}

describe("admission estimate against billed analyses", () => {
  it.each(BILLED)(
    "stays at or above the billed input for $run",
    ({ images, textBytes, billedInput }) => {
      const imageTokens = images.reduce(
        (sum, [count, width, height]) =>
          sum + count * highDetailImageTokens("gpt-6-astra", pngUrl(width, height)),
        0,
      );
      // Pad the messages so the packet's text term equals the run's measured text term.
      const bare = estimateStudyAnalysisAdmission(packet(images, MESSAGES), config);
      expect(bare.allowed).toBe(true);
      const padding = MESSAGES + textBytes - (bare.inputTokenAllowance! - imageTokens);
      const admission = estimateStudyAnalysisAdmission(packet(images, padding), config);
      expect(admission.inputTokenAllowance).toBe(textBytes + imageTokens);
      expect(admission.inputTokenAllowance).toBeGreaterThanOrEqual(billedInput);
    },
  );
});
