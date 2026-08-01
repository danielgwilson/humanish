const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_LENGTH = 13;

// Shared by validation and redaction so their pre-decode allocation guard
// cannot drift.
export const SCREENSHOT_MAX_SOURCE_PIXELS = 50_000_000;

export interface PngDimensions {
  width: number;
  height: number;
}

export function hasPngSignature(bytes: Buffer): boolean {
  return bytes.length >= PNG_SIGNATURE.length
    && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

/**
 * Read dimensions from a structurally positioned PNG IHDR without decoding.
 * CRC and complete-file validity remain the decoder's responsibility.
 */
export function readPngDeclaredDimensions(bytes: Buffer): PngDimensions | null {
  if (
    !hasPngSignature(bytes)
    || bytes.length < 24
    || bytes.readUInt32BE(8) !== PNG_IHDR_LENGTH
    || bytes.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    return null;
  }

  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20)
  };
}
