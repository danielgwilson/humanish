import { describe, expect, it } from "vitest";
import { highDetailImageTokens } from "../../src/analysis/image-tokens.js";

/** The first 33 bytes of a PNG: signature, then an IHDR chunk carrying the size. */
function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
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
