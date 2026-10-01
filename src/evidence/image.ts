import { PNG } from "pngjs";

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

export function screenshotEvidenceError(relativePath: string, bytes: Buffer): string | null {
  const extension = relativePath.toLowerCase().split(".").pop() ?? "";

  if (extension !== "png") {
    return `unsupported screenshot extension .${extension || "unknown"}; only decoded PNG evidence is supported`;
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

  try {
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    return pngDimensionsError(decoded.width, decoded.height);
  } catch {
    return "could not decode PNG evidence";
  }
}

export function assertScreenshotEvidence(relativePath: string, bytes: Buffer): void {
  const error = screenshotEvidenceError(relativePath, bytes);
  if (error) {
    throw new Error(`Invalid screenshot evidence ${relativePath}: ${error}`);
  }
}

function pngDimensionsError(width: number, height: number): string | null {
  if (width === 0 || height === 0) {
    return "PNG dimensions must be greater than zero";
  }
  if (width * height > SCREENSHOT_MAX_SOURCE_PIXELS) {
    return `PNG pixel count exceeds ${SCREENSHOT_MAX_SOURCE_PIXELS} pixel limit`;
  }
  return null;
}
