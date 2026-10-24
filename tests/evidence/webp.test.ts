import { describe, expect, it } from "vitest";

import { isRedactedFrameShape, screenshotEvidenceError } from "../../src/evidence/image.js";
import { decodeWebp, webpStructure } from "../../src/evidence/webp.js";

/** A 4x3 lossless WebP whose pixel (x, y) is (60x, 80y, 120), encoded by libwebp. */
const FRAME = Buffer.from(
  "UklGRjgAAABXRUJQVlA4TCsAAAAvA4AAAF9AkG0zxCLc3+MOwzN489+DDLBcAIIAEqUUUhhuhRVGjeh/UJcDAA==",
  "base64",
);

/** `FRAME` with `edit` applied to a copy. */
function edited(edit: (bytes: Buffer) => Buffer | void): Buffer {
  const copy = Buffer.from(FRAME);
  return edit(copy) ?? copy;
}

describe("a lossless WebP screenshot", () => {
  it("is evidence, read from its structure, with the dimensions its VP8L header gives", async () => {
    expect(webpStructure(FRAME)).toEqual({ error: null, dimensions: { width: 4, height: 3 } });
    expect(await screenshotEvidenceError("screenshots/p01/turn-01.webp", FRAME)).toBeNull();
  });

  it("decodes to the pixels it was encoded from", async () => {
    const image = await decodeWebp(FRAME);
    expect([image.width, image.height]).toEqual([4, 3]);
    const at = (x: number, y: number) => [
      ...image.data.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4),
    ];
    expect(at(0, 0)).toEqual([0, 0, 120, 255]);
    expect(at(3, 2)).toEqual([180, 160, 120, 255]);
  });

  it("is never the redacted frame shape, which is PNG only", () => {
    expect(isRedactedFrameShape(FRAME)).toBe(false);
  });

  it.each([
    ["a chunk other than VP8L", edited((b) => void b.write("VP8X", 12, "latin1"))],
    [
      "bytes after the chunk",
      Buffer.concat([edited((b) => void b.writeUInt32LE(b.length + 4 - 8, 4)), Buffer.alloc(4)]),
    ],
    ["a RIFF size that is not the file's", edited((b) => void b.writeUInt32LE(b.length, 4))],
    ["a chunk size past the file", edited((b) => void b.writeUInt32LE(b.readUInt32LE(16) + 8, 16))],
    ["no VP8L signature", edited((b) => void (b[20] = 0))],
    ["an unknown VP8L version", edited((b) => void (b[24] = b[24]! | 0x20))],
    ["only a RIFF header", Buffer.from("RIFF0000WEBP", "latin1")],
    ["a PNG", Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")],
  ])("with %s is refused", async (_case, bytes) => {
    expect(webpStructure(bytes).error).not.toBeNull();
    expect(await screenshotEvidenceError("screenshots/frame.webp", bytes)).not.toBeNull();
  });

  it("is refused past the pixel cap before anything decodes it", async () => {
    // 16384 x 16384 is the largest a VP8L header can declare, over the 50 million pixel cap.
    const huge = edited((b) => void b.writeUInt32LE(0x0fffffff, 21));
    expect(await screenshotEvidenceError("screenshots/frame.webp", huge)).toMatch(/pixel/);
  });
});
