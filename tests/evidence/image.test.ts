import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  assertScreenshotEvidence,
  screenshotEvidenceError,
  stripPngMetadataChunks,
} from "../../src/evidence/image.js";
import { pngTextChunk, withPngChunk } from "../helpers/png-chunks.js";

function encodePng(width = 2, height = 2): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

describe("screenshot evidence", () => {
  it("accepts a valid small PNG", () => {
    const bytes = encodePng();

    expect(screenshotEvidenceError("screenshots/tiny.png", bytes)).toBeNull();
    expect(() => assertScreenshotEvidence("screenshots/tiny.png", bytes)).not.toThrow();
  });

  it("rejects text saved with a PNG extension", () => {
    expect(
      screenshotEvidenceError("screenshots/not-an-image.png", Buffer.from("not an image")),
    ).toBe("expected PNG signature");
  });

  it("rejects a truncated PNG that still has a valid signature", () => {
    const truncated = encodePng().subarray(0, 24);

    expect(screenshotEvidenceError("screenshots/truncated.png", truncated)).toBe(
      "could not decode PNG evidence",
    );
  });

  it("rejects PNG dimensions that exceed the pixel limit before decoding", () => {
    const oversized = Buffer.from(encodePng());
    oversized.writeUInt32BE(100_000, 16);
    oversized.writeUInt32BE(100_000, 20);

    expect(screenshotEvidenceError("screenshots/oversized.png", oversized)).toBe(
      "PNG pixel count exceeds 50000000 pixel limit",
    );
  });

  it("rejects PNG payloads that exceed the byte limit before decoding", () => {
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
    encodePng().copy(oversized);

    expect(screenshotEvidenceError("screenshots/oversized.png", oversized)).toBe(
      "PNG byte size exceeds 33554432 byte limit",
    );
  });

  it("rejects zero declared dimensions", () => {
    const emptyWidth = Buffer.from(encodePng());
    emptyWidth.writeUInt32BE(0, 16);

    expect(screenshotEvidenceError("screenshots/zero-width.png", emptyWidth)).toBe(
      "PNG dimensions must be greater than zero",
    );
  });

  it.each([
    ["jpg", Buffer.from([0xff, 0xd8, 0xff])],
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["webp", Buffer.from("RIFF0000WEBP", "ascii")],
    ["gif", Buffer.from("GIF89a", "ascii")],
  ])("rejects signature-only .%s evidence", (extension, bytes) => {
    expect(screenshotEvidenceError(`screenshots/image.${extension}`, bytes)).toBe(
      `unsupported screenshot extension .${extension}; only decoded PNG evidence is supported`,
    );
  });

  it("rejects an unknown screenshot extension with a clear message", () => {
    expect(screenshotEvidenceError("screenshots/tiny.bmp", encodePng())).toBe(
      "unsupported screenshot extension .bmp; only decoded PNG evidence is supported",
    );
  });

  it.each(["tEXt", "zTXt", "iTXt"] as const)(
    "rejects a %s chunk, which no pixel review would see",
    (type) => {
      const bytes = withPngChunk(encodePng(), type, pngTextChunk(type, "a note"));
      expect(screenshotEvidenceError("screenshots/frame.png", bytes)).toBe(
        `PNG carries a ${type} chunk; screenshot evidence may hold image data only`,
      );
    },
  );

  it.each(["eXIf", "iCCP", "tIME", "prVt"])("rejects a %s chunk", (type) => {
    const bytes = withPngChunk(encodePng(), type, Buffer.from("payload"));
    expect(screenshotEvidenceError("screenshots/frame.png", bytes)).toContain(`a ${type} chunk`);
  });

  it("accepts the display chunks an E2B desktop frame carries", () => {
    const bytes = withPngChunk(
      withPngChunk(encodePng(), "sBIT", Buffer.from([8, 8, 8, 8])),
      "gAMA",
      Buffer.from([0, 0, 0xb1, 0x8f]),
    );
    expect(screenshotEvidenceError("screenshots/frame.png", bytes)).toBeNull();
  });

  it("strips metadata chunks and keeps the image chunks byte for byte", () => {
    const clean = withPngChunk(encodePng(), "sBIT", Buffer.from([8, 8, 8, 8]));
    const dirty = withPngChunk(
      withPngChunk(clean, "tEXt", pngTextChunk("tEXt", "a note")),
      "eXIf",
      Buffer.from("payload"),
    );
    const stripped = stripPngMetadataChunks(dirty);
    expect(stripped.equals(clean)).toBe(true);
    expect(screenshotEvidenceError("screenshots/frame.png", stripped)).toBeNull();
    expect(stripPngMetadataChunks(clean)).toBe(clean);
  });

  it("leaves bytes that are not a chunk sequence for the check to reject", () => {
    const truncated = encodePng().subarray(0, 24);
    expect(stripPngMetadataChunks(truncated)).toBe(truncated);
    const notPng = Buffer.from("not an image");
    expect(stripPngMetadataChunks(notPng)).toBe(notPng);
  });
});
