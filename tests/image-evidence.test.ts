import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { assertScreenshotEvidence, screenshotEvidenceError } from "../src/image-evidence.js";

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
    expect(screenshotEvidenceError("screenshots/not-an-image.png", Buffer.from("not an image")))
      .toBe("expected PNG signature");
  });

  it("rejects a truncated PNG that still has a valid signature", () => {
    const truncated = encodePng().subarray(0, 24);

    expect(screenshotEvidenceError("screenshots/truncated.png", truncated))
      .toBe("could not decode PNG evidence");
  });

  it("rejects PNG dimensions that exceed the pixel limit before decoding", () => {
    const oversized = Buffer.from(encodePng());
    oversized.writeUInt32BE(100_000, 16);
    oversized.writeUInt32BE(100_000, 20);

    expect(screenshotEvidenceError("screenshots/oversized.png", oversized))
      .toBe("PNG pixel count exceeds 50000000 pixel limit");
  });

  it("rejects PNG payloads that exceed the byte limit before decoding", () => {
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
    encodePng().copy(oversized);

    expect(screenshotEvidenceError("screenshots/oversized.png", oversized))
      .toBe("PNG byte size exceeds 33554432 byte limit");
  });

  it("rejects zero declared dimensions", () => {
    const emptyWidth = Buffer.from(encodePng());
    emptyWidth.writeUInt32BE(0, 16);

    expect(screenshotEvidenceError("screenshots/zero-width.png", emptyWidth))
      .toBe("PNG dimensions must be greater than zero");
  });

  it.each([
    ["jpg", Buffer.from([0xff, 0xd8, 0xff])],
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["webp", Buffer.from("RIFF0000WEBP", "ascii")],
    ["gif", Buffer.from("GIF89a", "ascii")]
  ])("rejects signature-only .%s evidence", (extension, bytes) => {
    expect(screenshotEvidenceError(`screenshots/image.${extension}`, bytes))
      .toBe(`unsupported screenshot extension .${extension}; only decoded PNG evidence is supported`);
  });

  it("rejects an unknown screenshot extension with a clear message", () => {
    expect(screenshotEvidenceError("screenshots/tiny.bmp", encodePng()))
      .toBe("unsupported screenshot extension .bmp; only decoded PNG evidence is supported");
  });
});
