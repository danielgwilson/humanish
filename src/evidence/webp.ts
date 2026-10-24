// Lossless WebP screenshots: the file shape verify accepts, and a bounded decode for the readers
// that need pixels. Only the simple lossless form is accepted: a RIFF container holding one VP8L
// chunk. The extended form (VP8X) is where EXIF, XMP, ICC and animation chunks live, so a frame
// in the simple form carries image data only. The VP8L bitstream itself is not proven consumed,
// so a WebP frame is never redacted evidence: a blurred frame is the PNG redactScreenshot writes.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import decodeWebpImage, { init as initWebpDecoder } from "@jsquash/webp/decode.js";

const RIFF_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const VP8L_SIGNATURE = 0x2f;
/** The VP8L header: its signature byte, then 14-bit width and height, an alpha hint, a version. */
const VP8L_HEADER_BYTES = 5;

export interface WebpDimensions {
  width: number;
  height: number;
}

/**
 * Why `bytes` is not a simple-format lossless WebP, or null with its dimensions when it is: RIFF
 * and WEBP, then one VP8L chunk that ends the file (with its pad byte, zero, when its size is
 * odd), whose header has the VP8L signature and version 0.
 */
export function webpStructure(
  bytes: Buffer,
): { error: string } | { error: null; dimensions: WebpDimensions } {
  const failed = (error: string) => ({ error });
  if (
    bytes.length < RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES + VP8L_HEADER_BYTES ||
    bytes.toString("latin1", 0, 4) !== "RIFF" ||
    bytes.toString("latin1", 8, 12) !== "WEBP"
  )
    return failed("expected a RIFF WEBP file");
  if (bytes.readUInt32LE(4) !== bytes.length - 8)
    return failed("the RIFF size does not match the file size");
  const chunk = bytes.toString("latin1", 12, 16);
  if (chunk !== "VP8L")
    return failed(
      `WebP evidence must be one lossless VP8L chunk, not ${/^[A-Za-z0-9 ]{4}$/.test(chunk) ? chunk.trim() : "a malformed chunk"}`,
    );
  const size = bytes.readUInt32LE(16);
  const start = RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES;
  const end = start + size + (size % 2);
  if (end !== bytes.length || (size % 2 === 1 && bytes[end - 1] !== 0))
    return failed("the VP8L chunk must end the file");
  if (size < VP8L_HEADER_BYTES) return failed("the VP8L chunk has no VP8L header");
  const dimensions = webpHeaderDimensions(bytes);
  if (dimensions === undefined) return failed("the VP8L header is not one this reader knows");
  return { error: null, dimensions };
}

/** The bytes webpHeaderDimensions reads: the RIFF header, the VP8L chunk header, the VP8L header. */
export const WEBP_HEADER_BYTES = RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES + VP8L_HEADER_BYTES;

/**
 * Width and height from the first WEBP_HEADER_BYTES of a simple-format lossless WebP: a VP8L
 * signature and version 0. Undefined for anything else.
 */
export function webpHeaderDimensions(header: Buffer): WebpDimensions | undefined {
  const start = RIFF_HEADER_BYTES + CHUNK_HEADER_BYTES;
  if (
    header.length < WEBP_HEADER_BYTES ||
    header.toString("latin1", 0, 4) !== "RIFF" ||
    header.toString("latin1", 8, 16) !== "WEBPVP8L" ||
    header[start] !== VP8L_SIGNATURE
  )
    return undefined;
  const bits = header.readUInt32LE(start + 1);
  if (bits >>> 29 !== 0) return undefined;
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

// Node defines WebAssembly; the ES2023 library this build types against does not.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

let decoderReady: Promise<void> | undefined;

/** Loads the decoder from the package's own wasm file: the codec's default fetches it by URL. */
function readyDecoder(): Promise<void> {
  // The codec builds its result with ImageData, which Node does not define.
  const scope = globalThis as { ImageData?: unknown };
  scope.ImageData ??= class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  };
  decoderReady ??= readFile(
    createRequire(import.meta.url).resolve("@jsquash/webp/codec/dec/webp_dec.wasm"),
  )
    .then((wasm) => WebAssembly.compile(wasm))
    .then((module) => initWebpDecoder(module));
  return decoderReady;
}

/**
 * The RGBA pixels of a WebP frame that webpStructure accepts, whose dimensions the caller has
 * checked against its pixel cap; the decoder allocates from them.
 */
export async function decodeWebp(
  bytes: Buffer,
): Promise<{ width: number; height: number; data: Buffer }> {
  await readyDecoder();
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const image = await decodeWebpImage(copy.buffer);
  return {
    width: image.width,
    height: image.height,
    data: Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength),
  };
}
