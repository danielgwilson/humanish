export function screenshotEvidenceError(relativePath: string, bytes: Buffer): string | null {
  const extension = relativePath.toLowerCase().split(".").pop() ?? "";

  if (extension === "png") {
    return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      ? null
      : "expected PNG signature";
  }

  if (extension === "jpg" || extension === "jpeg") {
    return hasPrefix(bytes, [0xff, 0xd8, 0xff]) ? null : "expected JPEG signature";
  }

  if (extension === "webp") {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString("ascii") === "RIFF"
      && bytes.subarray(8, 12).toString("ascii") === "WEBP"
      ? null
      : "expected WEBP signature";
  }

  if (extension === "gif") {
    const signature = bytes.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a" ? null : "expected GIF signature";
  }

  return `unsupported screenshot extension .${extension || "unknown"}`;
}

export function assertScreenshotEvidence(relativePath: string, bytes: Buffer): void {
  const error = screenshotEvidenceError(relativePath, bytes);
  if (error) {
    throw new Error(`Invalid screenshot evidence ${relativePath}: ${error}`);
  }
}

function hasPrefix(bytes: Buffer, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}
