import { createDeflate, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  assertScreenshotEvidence,
  isRedactedFrameShape,
  screenshotEvidenceError,
  stripPngMetadataChunks,
} from "../../src/evidence/image.js";
import { redactScreenshot } from "../../src/evidence/redaction.js";
import { pngOf, pngTextChunk, withPngChunk, withPngChunkData } from "../helpers/png-chunks.js";
import { BROKEN_PNGS, VALID_PNGS } from "../helpers/png-cases.js";

function encodePng(width = 2, height = 2): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

describe("a screenshot PNG's structure", () => {
  it.each(VALID_PNGS)("accepts %s", async (_name, bytes) => {
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBeNull();
  });

  it.each(BROKEN_PNGS)("refuses %s", async (_name, bytes) => {
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBe(
      "could not decode PNG evidence",
    );
  });

  it("refuses a 16-bit RGBA row of 2^25 pixels, wider than the decoder reads", async () => {
    // 33,554,432 x 1 is within the pixel cap; its 268 MB row inflates from about 260 KB.
    const width = 2 ** 25;
    const deflate = createDeflate();
    const chunks: Buffer[] = [];
    deflate.on("data", (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise((resolve) => deflate.on("end", resolve));
    const block = Buffer.alloc(1 << 20);
    for (let written = 0; written < 1 + width * 8; written += block.length)
      deflate.write(block.subarray(0, Math.min(block.length, 1 + width * 8 - written)));
    deflate.end();
    await ended;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 16;
    ihdr[9] = 6;
    const wide = pngOf([
      { type: "IHDR", data: ihdr },
      { type: "IDAT", data: Buffer.concat(chunks) },
      { type: "IEND", data: Buffer.alloc(0) },
    ]);
    expect(await screenshotEvidenceError("screenshots/wide.png", wide)).toBe(
      "could not decode PNG evidence",
    );
  });

  it("refuses a filter type past the first MiB of a frame's rows", async () => {
    // 1440x950 RGB: rows of 4,321 bytes, about 4 MB in all. Row 900 starts past 3.8 MB.
    const [width, height, rowBytes] = [1440, 950, 1 + 1440 * 3];
    const rows = Buffer.alloc(rowBytes * height);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const frame = (data: Buffer) =>
      pngOf([
        { type: "IHDR", data: ihdr },
        { type: "IDAT", data: deflateSync(data) },
        { type: "IEND", data: Buffer.alloc(0) },
      ]);
    expect(await screenshotEvidenceError("screenshots/frame.png", frame(rows))).toBeNull();
    rows[900 * rowBytes] = 5;
    expect(await screenshotEvidenceError("screenshots/frame.png", frame(rows))).toBe(
      "could not decode PNG evidence",
    );
  });

  it("lets other callbacks run while it inflates a frame", async () => {
    // A 1440x950 RGBA frame inflates to about 5.5 MB of rows. verify checks several frames at a
    // time, and one frame's inflate holding the thread would leave the others waiting.
    const bytes = encodePng(1440, 950);
    let turns = 0;
    let checking = true;
    const turn = (): void => {
      if (!checking) return;
      turns += 1;
      setImmediate(turn);
    };
    setImmediate(turn);
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBeNull();
    checking = false;
    expect(turns).toBeGreaterThan(0);
  });
});

describe("screenshot evidence", () => {
  it("accepts a valid small PNG", async () => {
    const bytes = encodePng();

    expect(await screenshotEvidenceError("screenshots/tiny.png", bytes)).toBeNull();
    await expect(assertScreenshotEvidence("screenshots/tiny.png", bytes)).resolves.toBeUndefined();
  });

  it("rejects text saved with a PNG extension", async () => {
    expect(
      await screenshotEvidenceError("screenshots/not-an-image.png", Buffer.from("not an image")),
    ).toBe("expected PNG signature");
  });

  it("rejects a truncated PNG that still has a valid signature", async () => {
    const truncated = encodePng().subarray(0, 24);

    expect(await screenshotEvidenceError("screenshots/truncated.png", truncated)).toBe(
      "could not decode PNG evidence",
    );
  });

  it("rejects PNG dimensions that exceed the pixel limit before decoding", async () => {
    const oversized = Buffer.from(encodePng());
    oversized.writeUInt32BE(100_000, 16);
    oversized.writeUInt32BE(100_000, 20);

    expect(await screenshotEvidenceError("screenshots/oversized.png", oversized)).toBe(
      "PNG pixel count exceeds 50000000 pixel limit",
    );
  });

  it("rejects PNG payloads that exceed the byte limit before decoding", async () => {
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
    encodePng().copy(oversized);

    expect(await screenshotEvidenceError("screenshots/oversized.png", oversized)).toBe(
      "PNG byte size exceeds 33554432 byte limit",
    );
  });

  it("rejects zero declared dimensions", async () => {
    const emptyWidth = Buffer.from(encodePng());
    emptyWidth.writeUInt32BE(0, 16);

    expect(await screenshotEvidenceError("screenshots/zero-width.png", emptyWidth)).toBe(
      "PNG dimensions must be greater than zero",
    );
  });

  it.each([
    ["jpg", Buffer.from([0xff, 0xd8, 0xff])],
    ["jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["gif", Buffer.from("GIF89a", "ascii")],
  ])("rejects signature-only .%s evidence", async (extension, bytes) => {
    expect(await screenshotEvidenceError(`screenshots/image.${extension}`, bytes)).toBe(
      `unsupported screenshot extension .${extension}; screenshot evidence is PNG or lossless WebP`,
    );
  });

  it("rejects an unknown screenshot extension with a clear message", async () => {
    expect(await screenshotEvidenceError("screenshots/tiny.bmp", encodePng())).toBe(
      "unsupported screenshot extension .bmp; screenshot evidence is PNG or lossless WebP",
    );
  });

  it.each(["tEXt", "zTXt", "iTXt"] as const)(
    "rejects a %s chunk, which no pixel review would see",
    async (type) => {
      const bytes = withPngChunk(encodePng(), type, pngTextChunk(type, "a note"));
      expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBe(
        `PNG carries a ${type} chunk; screenshot evidence may hold image data only`,
      );
    },
  );

  it.each(["eXIf", "iCCP", "tIME", "prVt"])("rejects a %s chunk", async (type) => {
    const bytes = withPngChunk(encodePng(), type, Buffer.from("payload"));
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toContain(
      `a ${type} chunk`,
    );
  });

  it("accepts the display chunks an E2B desktop frame carries", async () => {
    const bytes = withPngChunk(
      withPngChunk(encodePng(), "sBIT", Buffer.from([8, 8, 8, 8])),
      "gAMA",
      Buffer.from([0, 0, 0xb1, 0x8f]),
    );
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBeNull();
  });

  it("strips metadata chunks and keeps the image chunks byte for byte", async () => {
    const clean = withPngChunk(encodePng(), "sBIT", Buffer.from([8, 8, 8, 8]));
    const dirty = withPngChunk(
      withPngChunk(clean, "tEXt", pngTextChunk("tEXt", "a note")),
      "eXIf",
      Buffer.from("payload"),
    );
    const stripped = stripPngMetadataChunks(dirty);
    expect(stripped.equals(clean)).toBe(true);
    expect(await screenshotEvidenceError("screenshots/frame.png", stripped)).toBeNull();
    expect(stripPngMetadataChunks(clean)).toBe(clean);
  });

  it("leaves bytes that are not a chunk sequence for the check to reject", () => {
    const truncated = encodePng().subarray(0, 24);
    expect(stripPngMetadataChunks(truncated)).toBe(truncated);
    const notPng = Buffer.from("not an image");
    expect(stripPngMetadataChunks(notPng)).toBe(notPng);
  });

  // 1207 5a: an IHDR of another length hides its dimensions from the pre-decode pixel cap.
  it("refuses an IHDR that is not 13 bytes before decoding", async () => {
    const declared = Buffer.alloc(14);
    declared.writeUInt32BE(20_000, 0);
    declared.writeUInt32BE(20_000, 4);
    declared.set([8, 6, 0, 0, 0], 8);
    const bytes = withPngChunkData(encodePng(), "IHDR", declared);
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBe(
      "PNG must start with a 13-byte IHDR chunk",
    );
    expect(redactScreenshot(bytes).decoded).toBe(false);
  });

  // 1207 5b: pngjs inflates interlaced data with no bound.
  it("refuses an interlaced PNG before decoding", async () => {
    const header = Buffer.from(encodePng().subarray(16, 29));
    header[12] = 1;
    const bytes = withPngChunkData(encodePng(), "IHDR", header);
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBe(
      "interlaced PNG evidence is not supported",
    );
    expect(redactScreenshot(bytes).decoded).toBe(false);
  });

  // 1207 5c: the strip must not walk an oversized buffer.
  it("returns bytes over the size cap unstripped, for the check to reject", () => {
    const oversized = Buffer.alloc(32 * 1024 * 1024 + 1);
    encodePng().copy(oversized);
    expect(stripPngMetadataChunks(oversized)).toBe(oversized);
  });

  it("rejects an IEND with a payload", async () => {
    const bytes = withPngChunkData(encodePng(), "IEND", Buffer.from("payload"));
    expect(await screenshotEvidenceError("screenshots/frame.png", bytes)).toBe(
      "PNG IEND chunk must be empty",
    );
  });

  it("recognizes the redactor's output shape and nothing wider or with other chunks", () => {
    const thumbnail = redactScreenshot(encodePng(640, 400)).buffer;
    expect(isRedactedFrameShape(thumbnail)).toBe(true);
    expect(isRedactedFrameShape(encodePng(129, 2))).toBe(false);
    expect(
      isRedactedFrameShape(withPngChunk(thumbnail, "gAMA", Buffer.from([0, 0, 0xb1, 0x8f]))),
    ).toBe(false);
    expect(isRedactedFrameShape(Buffer.concat([thumbnail, Buffer.from("tail")]))).toBe(false);
  });
});
