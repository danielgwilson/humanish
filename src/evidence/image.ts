import { PNG } from "pngjs";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_LENGTH = 13;

// Shared by validation here and redaction so their pre-decode allocation guard
// cannot drift.
export const SCREENSHOT_MAX_SOURCE_PIXELS = 50_000_000;

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
export function readPngDeclaredDimensions(bytes: Buffer): PngDimensions | null {
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

export function screenshotEvidenceError(relativePath: string, bytes: Buffer): string | null {
  const extension = relativePath.toLowerCase().split(".").pop() ?? "";

  if (extension !== "png") {
    return `unsupported screenshot extension .${extension || "unknown"}; only decoded PNG evidence is supported`;
  }

  if (!hasPngSignature(bytes)) {
    return "expected PNG signature";
  }

  if (bytes.length > SCREENSHOT_MAX_BYTES) {
    return `PNG byte size exceeds ${SCREENSHOT_MAX_BYTES} byte limit`;
  }

  const declaredDimensions = readPngDeclaredDimensions(bytes);
  if (declaredDimensions) {
    const dimensionsError = pngDimensionsError(declaredDimensions.width, declaredDimensions.height);
    if (dimensionsError) {
      return dimensionsError;
    }
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
