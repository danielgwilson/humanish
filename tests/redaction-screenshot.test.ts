import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { redactScreenshot } from "../src/redaction.js";

// redactScreenshot is the fail-closed public-safety primitive for the
// computer-use lane: a raw desktop frame must never reach a public artifact, so
// the emitted buffer is always a re-encoded, downscaled, blurred thumbnail (or a
// neutral placeholder), never the source pixels. These tests pin those
// guarantees structurally (we cannot OCR in CI, so we assert the invariants that
// make text unreadable: aggressive downscale, re-encode, blur, and fail-closed).

function encodePng(
  width: number,
  height: number,
  fill: (x: number, y: number) => [number, number, number, number]
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const [r, g, b, a] = fill(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  }
  return PNG.sync.write(png);
}

const checkerboard = (x: number, y: number): [number, number, number, number] =>
  (x + y) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255];

const stripes = (period: number) =>
  (x: number, _y: number): [number, number, number, number] =>
    Math.floor(x / period) % 2 === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255];

// Spread between the darkest and lightest red value in a frame. A high-contrast
// (text-like) pattern that survives redaction keeps a wide spread; a properly
// coarsened frame collapses toward a narrow band of mid-tones.
function redChannelSpread(buffer: Buffer): number {
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  for (let i = 0; i < png.width * png.height; i += 1) {
    const v = png.data[i * 4] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
}

describe("redactScreenshot", () => {
  it("downscales a large frame to the max width and re-encodes it", () => {
    const source = encodePng(400, 300, checkerboard);
    const result = redactScreenshot(source);

    expect(result.decoded).toBe(true);
    expect(result.mode).toBe("blurred");
    expect(result.width).toBe(96);
    expect(result.height).toBe(Math.round((300 * 96) / 400)); // 72, aspect preserved

    const out = PNG.sync.read(result.buffer);
    expect(out.width).toBe(96);
    expect(out.height).toBe(72);
    // The emitted bytes are never the source bytes.
    expect(Buffer.compare(result.buffer, source)).not.toBe(0);
  });

  it("blurs even when the source is already smaller than maxWidth (no-downscale path)", () => {
    // 50 < 96 so there is no downscale; detail-bearing content must still be
    // blurred (a solid color would re-encode byte-identically, which is harmless,
    // so use a checkerboard to prove the blur pass actually runs on this path).
    const source = encodePng(50, 40, checkerboard);
    const result = redactScreenshot(source);

    expect(result.decoded).toBe(true);
    expect(result.width).toBe(50); // never upscaled past the source
    expect(result.height).toBe(40);
    expect(Buffer.compare(result.buffer, source)).not.toBe(0);
  });

  it("destroys high-frequency detail (text-like content cannot survive)", () => {
    // A per-pixel checkerboard is the worst case for legibility: if any of it
    // survived, fine detail would too. After area-average downscale + blur every
    // output pixel should collapse toward the mean (~128), proving detail is gone.
    const source = encodePng(400, 300, checkerboard);
    const out = PNG.sync.read(redactScreenshot(source).buffer);

    let min = 255;
    let max = 0;
    for (let i = 0; i < out.width * out.height; i += 1) {
      const v = out.data[i * 4] ?? 0; // red channel
      if (v < min) min = v;
      if (v > max) max = v;
    }
    // No sharp black/white edges remain; everything is mid-gray.
    expect(min).toBeGreaterThan(96);
    expect(max).toBeLessThan(160);
  });

  it("is deterministic (no Date/random): same input yields identical bytes", () => {
    const source = encodePng(200, 200, checkerboard);
    const a = redactScreenshot(source);
    const b = redactScreenshot(source);
    expect(Buffer.compare(a.buffer, b.buffer)).toBe(0);
  });

  it("fails closed to a placeholder on non-PNG input", () => {
    const garbage = Buffer.from("this is definitely not a png frame", "utf8");
    const result = redactScreenshot(garbage);

    expect(result.decoded).toBe(false);
    expect(result.mode).toBe("blurred");
    // Still a valid, decodable PNG, and never the input bytes.
    const out = PNG.sync.read(result.buffer);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
    expect(Buffer.compare(result.buffer, garbage)).not.toBe(0);
  });

  it("fails closed on empty input", () => {
    const result = redactScreenshot(Buffer.alloc(0));
    expect(result.decoded).toBe(false);
    const out = PNG.sync.read(result.buffer);
    expect(out.width).toBeGreaterThan(0);
  });

  it("fails closed on truncated/corrupt PNG bytes", () => {
    const source = encodePng(120, 90, checkerboard);
    const truncated = source.subarray(0, 24); // valid signature, no image data
    const result = redactScreenshot(truncated);
    expect(result.decoded).toBe(false);
    expect(() => PNG.sync.read(result.buffer)).not.toThrow();
  });

  it("respects a smaller maxWidth", () => {
    const source = encodePng(400, 300, checkerboard);
    const result = redactScreenshot(source, { maxWidth: 32 });
    expect(result.width).toBe(32);
    expect(result.height).toBe(Math.round((300 * 32) / 400)); // 24
  });

  it("enforces the width cap: a huge maxWidth cannot widen the frame", () => {
    // The "too coarse to read" invariant must hold even when a caller tries to
    // disable the downscale. Before the cap, maxWidth 100000 left a full-res,
    // blur-only frame that stayed legible; this test pins that it cannot.
    const source = encodePng(400, 300, stripes(2));
    const result = redactScreenshot(source, { maxWidth: 100_000 });
    expect(result.width).toBeLessThanOrEqual(128);
    expect(redChannelSpread(result.buffer)).toBeLessThan(64);
  });

  it("keeps the no-downscale path illegible (small native frame)", () => {
    // 90 < 128 so there is no downscale; the internal blur floor (not a caller
    // knob) must still erase high-frequency, text-like detail. This would fail
    // with the old fixed radius-2 blur.
    const source = encodePng(90, 60, stripes(2));
    const result = redactScreenshot(source);
    expect(result.width).toBe(90); // confirms we are on the no-downscale path
    expect(redChannelSpread(result.buffer)).toBeLessThan(96);
  });

  it("fails closed on an oversized PNG without decoding it (OOM guard)", () => {
    // Valid signature + an IHDR declaring 100000x100000 (~10 gigapixels). The
    // guard must return a placeholder before allocating, never attempt decode.
    const header = Buffer.alloc(24);
    header.writeUInt32BE(0x89_50_4e_47, 0); // PNG signature (first 4 bytes)
    header.writeUInt32BE(100_000, 16); // IHDR width
    header.writeUInt32BE(100_000, 20); // IHDR height
    const result = redactScreenshot(header);
    expect(result.decoded).toBe(false);
    expect(() => PNG.sync.read(result.buffer)).not.toThrow();
  });

  it("normalizes a non-RGBA source encoding (grayscale) and stays illegible", () => {
    const rgba = encodePng(400, 300, stripes(2));
    const grayscale = PNG.sync.write(PNG.sync.read(rgba), { colorType: 0 });
    const result = redactScreenshot(grayscale);
    expect(result.decoded).toBe(true);
    const out = PNG.sync.read(result.buffer);
    expect(out.data.length).toBe(out.width * out.height * 4); // always RGBA
    expect(redChannelSpread(result.buffer)).toBeLessThan(64);
  });

  it("always emits a well-formed RGBA PNG, whatever the input", () => {
    const inputs = [encodePng(300, 200, checkerboard), Buffer.alloc(0), Buffer.from("nope", "utf8")];
    for (const input of inputs) {
      const out = PNG.sync.read(redactScreenshot(input).buffer);
      expect(out.data.length).toBe(out.width * out.height * 4);
    }
  });

  it("accepts a Uint8Array as well as a Buffer", () => {
    const source = encodePng(100, 100, () => [200, 100, 50, 255]);
    const asU8 = new Uint8Array(source);
    const result = redactScreenshot(asU8);
    expect(result.decoded).toBe(true);
    expect(result.width).toBe(96);
  });
});
