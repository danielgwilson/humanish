import { crc32, createInflate } from "node:zlib";

import { PNG } from "pngjs";

import { webpStructure } from "./webp.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_LENGTH = 13;

// The pixel cap pngDecodeRefusal applies before any decode, for verify and the redactor alike.
const SCREENSHOT_MAX_SOURCE_PIXELS = 50_000_000;

// The widest thumbnail the redactor emits. A redacted frame is at most this wide, which is what
// makes it too coarse to read text off; see redactScreenshot.
export const SCREENSHOT_MAX_WIDTH_CAP = 128;

interface PngDimensions {
  width: number;
  height: number;
}

function hasPngSignature(bytes: Buffer): boolean {
  return (
    bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

/**
 * Read dimensions from a structurally positioned PNG IHDR without decoding.
 * CRC and complete-file validity remain the decoder's responsibility.
 */
function readPngDeclaredDimensions(bytes: Buffer): PngDimensions | null {
  if (
    !hasPngSignature(bytes) ||
    bytes.length < 24 ||
    bytes.readUInt32BE(8) !== PNG_IHDR_LENGTH ||
    bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return null;
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

// A noisy 4K RGBA frame is roughly 32 MiB before PNG compression, so this
// admits realistic screenshot payloads while bounding decoder input.
const SCREENSHOT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The PNG chunks screenshot evidence may carry: image data and fixed-format display hints.
 * Text (tEXt, zTXt, iTXt), ICC profiles, Exif, timestamps and private chunks can hold bytes that
 * neither the text scan nor a look at the pixels would see, so a screenshot must not carry them.
 * Frames from E2B desktops carry IHDR, IDAT, IEND and sBIT; blurred frames are re-encoded.
 */
const SCREENSHOT_PNG_CHUNKS = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "sBIT",
  "sRGB",
  "pHYs",
  "bKGD",
]);

interface PngChunk {
  type: string;
  start: number;
  end: number;
}

/** The chunks up to IEND, or null when a chunk runs past the end of the bytes. */
function readPngChunks(bytes: Buffer): PngChunk[] | null {
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= bytes.length) {
    const end = offset + 12 + bytes.readUInt32BE(offset);
    if (end > bytes.length) return null;
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    chunks.push({ type, start: offset, end });
    offset = end;
    if (type === "IEND") break;
  }
  return chunks;
}

/**
 * Drops every chunk outside SCREENSHOT_PNG_CHUNKS, so a frame from any source is written with
 * image data only. Pixels and the kept chunks are copied unchanged. Bytes over the size cap, or
 * that are not a well-formed chunk sequence, are returned as they are, for the evidence check to
 * reject without walking them.
 */
export function stripPngMetadataChunks(bytes: Buffer): Buffer {
  if (!hasPngSignature(bytes) || bytes.length > SCREENSHOT_MAX_BYTES) return bytes;
  const chunks = readPngChunks(bytes);
  if (chunks === null) return bytes;
  const kept = chunks.filter((chunk) => SCREENSHOT_PNG_CHUNKS.has(chunk.type));
  if (kept.length === chunks.length) return bytes;
  return Buffer.concat([
    bytes.subarray(0, PNG_SIGNATURE.length),
    ...kept.map((chunk) => bytes.subarray(chunk.start, chunk.end)),
  ]);
}

/**
 * Why a PNG must not reach the decoder, read from its header. pngjs allocates from the IHDR it
 * finds and inflates interlaced data with no bound, so a PNG whose first chunk is not a 13-byte
 * IHDR (its dimensions unchecked) or an interlaced one can cost gigabytes. Null when decoding is
 * bounded by the byte and pixel caps. Every retained frame is non-interlaced with a 13-byte IHDR.
 */
export function pngDecodeRefusal(bytes: Buffer): string | null {
  if (!hasPngSignature(bytes)) return "expected PNG signature";
  if (bytes.length > SCREENSHOT_MAX_BYTES) {
    return `PNG byte size exceeds ${SCREENSHOT_MAX_BYTES} byte limit`;
  }
  const dimensions = readPngDeclaredDimensions(bytes);
  if (dimensions === null) return "PNG must start with a 13-byte IHDR chunk";
  const dimensionsError = pngDimensionsError(dimensions.width, dimensions.height);
  if (dimensionsError) return dimensionsError;
  // IHDR data: width, height, bit depth, color type, compression, filter, interlace (byte 28).
  if (bytes.length > 28 && bytes[28] !== 0) return "interlaced PNG evidence is not supported";
  return null;
}

/**
 * True when the bytes have exactly the shape redactScreenshot writes: IHDR, IDAT and IEND only,
 * an empty IEND ending the file, and a width within SCREENSHOT_MAX_WIDTH_CAP. A frame claiming
 * `blurred` counts as redacted only in this shape: the claim alone cannot show that the pixels
 * were downscaled, and any other chunk is a place to carry bytes no one reviews.
 */
export function isRedactedFrameShape(bytes: Buffer): boolean {
  if (pngDecodeRefusal(bytes) !== null) return false;
  const chunks = readPngChunks(bytes);
  if (chunks === null || chunks.length < 3) return false;
  const last = chunks[chunks.length - 1]!;
  return (
    chunks[0]!.type === "IHDR" &&
    chunks.slice(1, -1).every((chunk) => chunk.type === "IDAT") &&
    last.type === "IEND" &&
    last.end - last.start === 12 &&
    last.end === bytes.length &&
    bytes.readUInt32BE(16) <= SCREENSHOT_MAX_WIDTH_CAP
  );
}

export async function screenshotEvidenceError(
  relativePath: string,
  bytes: Buffer,
): Promise<string | null> {
  const extension = relativePath.toLowerCase().split(".").pop() ?? "";

  if (extension === "webp") return webpEvidenceError(bytes);
  if (extension !== "png") {
    return `unsupported screenshot extension .${extension || "unknown"}; screenshot evidence is PNG or lossless WebP`;
  }

  const refusal = pngDecodeRefusal(bytes);
  if (refusal) return refusal;

  const chunks = readPngChunks(bytes);
  const foreign = chunks?.find((chunk) => !SCREENSHOT_PNG_CHUNKS.has(chunk.type));
  if (foreign !== undefined) {
    const name = /^[A-Za-z]{4}$/.test(foreign.type) ? foreign.type : "malformed";
    return `PNG carries a ${name} chunk; screenshot evidence may hold image data only`;
  }
  // pngjs reads IEND at any length, so its payload would go unchecked.
  if (chunks?.some((chunk) => chunk.type === "IEND" && chunk.end - chunk.start !== 12)) {
    return "PNG IEND chunk must be empty";
  }

  return chunks === null || !(await pngStructureHolds(bytes, chunks))
    ? "could not decode PNG evidence"
    : null;
}

/**
 * Why a WebP frame is not screenshot evidence, read from its structure (webpStructure) without
 * decoding it. A WebP frame is always raw evidence, which verify never grades share-ready, so a
 * decode would add 17 to 20 ms a frame on the main thread and establish nothing more about bytes
 * no one reviews.
 */
function webpEvidenceError(bytes: Buffer): string | null {
  if (bytes.length > SCREENSHOT_MAX_BYTES)
    return `WebP byte size exceeds ${SCREENSHOT_MAX_BYTES} byte limit`;
  const structure = webpStructure(bytes);
  if (structure.error !== null) return structure.error;
  return imageDimensionsError("WebP", structure.dimensions.width, structure.dimensions.height);
}

/** The bit depths PNG allows for each color type. */
const PNG_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const PNG_CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
/** The fewest bytes the decoder reads from a chunk; a shorter one fails to decode. */
const PNG_MIN_CHUNK_BYTES: Readonly<Record<string, number>> = { gAMA: 4 };

/**
 * Whether a PNG that passed pngDecodeRefusal decodes, read from its structure: the file ends at an
 * empty IEND, every chunk's CRC matches, IHDR comes once with fields PNG defines, the image data is
 * one run of IDAT chunks, and it inflates (inflatesToRows) to exactly the bytes its rows need with
 * nothing after the stream, each row starting with a filter type from 0 to 4. For an image without
 * a palette that is all a decode establishes, at about an eighth of the time of pngjs, which
 * unfilters every pixel in JavaScript; a run holds a screenshot for each turn. A palette image is
 * also decoded, since each pixel must index a palette that comes before the image data; in any
 * other image a palette chunk is only a suggestion, wherever it is.
 */
async function pngStructureHolds(bytes: Buffer, chunks: readonly PngChunk[]): Promise<boolean> {
  const last = chunks.at(-1);
  if (last?.type !== "IEND" || last.end !== bytes.length) return false;
  const crcHolds = (chunk: PngChunk) =>
    crc32(bytes.subarray(chunk.start + 4, chunk.end - 4)) === bytes.readUInt32BE(chunk.end - 4);
  if (!chunks.every(crcHolds)) return false;
  const types = chunks.map((chunk) => chunk.type);
  const firstIdat = types.indexOf("IDAT");
  const idats = chunks.filter((chunk) => chunk.type === "IDAT");
  if (
    types.lastIndexOf("IHDR") !== 0 ||
    firstIdat < 0 ||
    types.lastIndexOf("IDAT") !== firstIdat + idats.length - 1
  )
    return false;
  const [width, height] = [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  const [depth, colorType, compression, filter] = [bytes[24]!, bytes[25]!, bytes[26], bytes[27]];
  if (!PNG_BIT_DEPTHS[colorType]?.includes(depth) || compression !== 0 || filter !== 0)
    return false;
  // The decoder sizes a row in 32-bit arithmetic and refuses one wider; no screenshot is.
  const rowBits = width * PNG_CHANNELS[colorType]! * depth;
  if (rowBits + 7 > 0x7fffffff) return false;
  const trnsBytes = colorType === 0 ? 2 : colorType === 2 ? 6 : 0;
  const tooShort = (chunk: PngChunk) =>
    chunk.end - chunk.start - 12 <
    (chunk.type === "tRNS" ? trnsBytes : (PNG_MIN_CHUNK_BYTES[chunk.type] ?? 0));
  if (chunks.some(tooShort)) return false;
  const rowBytes = 1 + Math.ceil(rowBits / 8);
  const data = Buffer.concat(idats.map((chunk) => bytes.subarray(chunk.start + 8, chunk.end - 4)));
  if (!(await inflatesToRows(data, rowBytes, height))) return false;
  return colorType !== 3 || pngDecodes(bytes);
}

// The most inflated bytes one check holds at once. Checks overlap on the thread pool, so rows held
// whole add up across them. A process running 8 checks of 5000x5000 RGBA frames peaked at 832 MB
// resident with each frame's rows held whole and at 202 MB checked 1 MiB at a time.
const INFLATE_CHUNK_BYTES = 1024 * 1024;

/**
 * Whether `data` inflates to exactly `rows` rows of `rowBytes` bytes, each starting with a filter
 * type from 0 to 4, with nothing after the stream. zlib inflates on libuv's thread pool, so checks
 * of several frames overlap. A stream that would inflate past the rows stops there, so a small
 * file cannot claim gigabytes.
 */
function inflatesToRows(data: Buffer, rowBytes: number, rows: number): Promise<boolean> {
  const total = rowBytes * rows;
  return new Promise((resolve) => {
    const inflate = createInflate({
      chunkSize: Math.max(64, Math.min(total, INFLATE_CHUNK_BYTES)),
    });
    let seen = 0;
    inflate.on("data", (chunk: Buffer) => {
      let filtersHold = true;
      // The first row that starts in this chunk, then each row after it.
      for (let at = (rowBytes - (seen % rowBytes)) % rowBytes; at < chunk.length; at += rowBytes)
        if (chunk[at]! > 4) filtersHold = false;
      seen += chunk.length;
      if (!filtersHold || seen > total) {
        inflate.destroy();
        resolve(false);
      }
    });
    inflate.on("error", () => resolve(false));
    inflate.on("end", () => resolve(seen === total && inflate.bytesWritten === data.length));
    inflate.end(data);
  });
}

function pngDecodes(bytes: Buffer): boolean {
  try {
    PNG.sync.read(bytes, { checkCRC: true });
    return true;
  } catch {
    return false;
  }
}

export async function assertScreenshotEvidence(relativePath: string, bytes: Buffer): Promise<void> {
  const error = await screenshotEvidenceError(relativePath, bytes);
  if (error) {
    throw new Error(`Invalid screenshot evidence ${relativePath}: ${error}`);
  }
}

function pngDimensionsError(width: number, height: number): string | null {
  return imageDimensionsError("PNG", width, height);
}

/** Why an image of these dimensions is refused before any decode, or null. */
export function imageDimensionsError(format: string, width: number, height: number): string | null {
  if (width === 0 || height === 0) {
    return `${format} dimensions must be greater than zero`;
  }
  if (width * height > SCREENSHOT_MAX_SOURCE_PIXELS) {
    return `${format} pixel count exceeds ${SCREENSHOT_MAX_SOURCE_PIXELS} pixel limit`;
  }
  return null;
}
