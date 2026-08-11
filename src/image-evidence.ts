import { PNG } from "pngjs";

import {
  SCREENSHOT_MAX_SOURCE_PIXELS,
  hasPngSignature,
  readPngDeclaredDimensions
} from "./screenshot-image.js";

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
