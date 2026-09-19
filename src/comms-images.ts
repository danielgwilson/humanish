import type { CommsInlineImage } from "./comms-types.js";

export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;
export const MAX_INLINE_IMAGES_BYTES = 2 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 12;

/** Captured bytes only. Never dereference attachment URLs or local paths. */
export function inlineImageData(image: CommsInlineImage): string | undefined {
  const { contentType, base64 } = image;
  if (base64.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;
  const bytes = Buffer.from(base64, "base64");
  if (!bytes.length || bytes.length > MAX_INLINE_IMAGE_BYTES || bytes.toString("base64") !== base64) return undefined;
  const valid = contentType === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : contentType === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : contentType === "image/gif" ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
        : contentType === "image/webp" && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return valid ? `data:${contentType};base64,${base64}` : undefined;
}

export function capturedInlineImages(value: unknown): CommsInlineImage[] {
  if (!Array.isArray(value)) return [];
  const images: CommsInlineImage[] = [];
  let total = 0;
  for (const item of value.slice(0, MAX_INLINE_IMAGES)) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.contentId !== "string" || !raw.contentId.trim() || raw.contentId.length > 256 || typeof raw.contentType !== "string" || typeof raw.base64 !== "string") continue;
    const image = { contentId: raw.contentId.trim().replace(/^<|>$/g, ""), contentType: raw.contentType.toLowerCase(), base64: raw.base64 };
    if (!inlineImageData(image)) continue;
    total += Buffer.byteLength(image.base64, "base64");
    if (total > MAX_INLINE_IMAGES_BYTES) break;
    images.push(image);
  }
  return images;
}
