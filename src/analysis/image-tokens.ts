/** An input image the analysis providers accept; the groups are the image type and its base64 bytes. */
export const INPUT_IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/;

/**
 * Input tokens one image costs at the detail the provider request sends: `detail: "high"` on
 * OpenAI, MEDIA_RESOLUTION_HIGH on Gemini.
 *
 * OpenAI's vision guide (https://developers.openai.com/api/docs/guides/images-vision, read
 * 2026-09-30) prices these patch-based models by 32 px patches: ceil(width / 32) × ceil(height /
 * 32), scaled down to the model's high-detail patch budget, then ceil(patches × multiplier).
 * Scaling down only removes patches, so min(patches, budget) bounds the billed count from above.
 * The guide lists a 2,500-patch high budget and a 1.2 multiplier for each model below; its own
 * examples are 1024×1024 → 1,229 tokens and 2048×2048 → 3,000. It does not list gpt-6-luna or
 * gpt-6.1-sol (read 2026-10-21). Their entries copy gpt-6-astra's because OpenAI billed the same
 * image tokens on all three on 2026-10-21, within the guide's one-token rounding.
 */
const HIGH_DETAIL_SIZING: Readonly<
  Record<string, { patchBudget: number; multiplierTenths: number }>
> = Object.freeze({
  "gpt-6-astra": { patchBudget: 2500, multiplierTenths: 12 },
  "gpt-6.1-sol": { patchBudget: 2500, multiplierTenths: 12 },
  "gpt-6-luna": { patchBudget: 2500, multiplierTenths: 12 },
  "gpt-5.6-sol": { patchBudget: 2500, multiplierTenths: 12 },
  "gpt-5.6-terra": { patchBudget: 2500, multiplierTenths: 12 },
  "gpt-5.6-luna": { patchBudget: 2500, multiplierTenths: 12 },
  "gpt-5.5": { patchBudget: 2500, multiplierTenths: 12 },
});

/** 2,500 patches × 1.2: what any image costs on these models when its size is unknown. */
const HIGH_DETAIL_IMAGE_TOKEN_CEILING = 3000;

/**
 * Gemini bills an image by its media resolution, not its size. The provider sends every capture at
 * MEDIA_RESOLUTION_HIGH, which the media-resolution guide
 * (ai.google.dev/gemini-api/docs/media-resolution, read 2026-10-21) gives as at most 1,120 tokens
 * for an image on Gemini 3 and Gemini 4 models. A 1x1 PNG at that setting was billed 1,089.
 */
const GEMINI_HIGH_RESOLUTION_IMAGE_TOKENS: Readonly<Record<string, number>> = Object.freeze({
  "gemini-3.8-flash": 1120,
  "gemini-3.5-flash-lite": 1120,
  "gemini-3-flash-preview": 1120,
  "gemini-4-argon": 1120,
});

/** The most one image can cost on `model`, whatever its size. */
export const imageTokenCeiling = (model: string): number =>
  GEMINI_HIGH_RESOLUTION_IMAGE_TOKENS[model] ?? HIGH_DETAIL_IMAGE_TOKEN_CEILING;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from a PNG data URL's IHDR chunk; undefined for anything else. */
function pngDimensions(dataUrl: string): { width: number; height: number } | undefined {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]{32})/.exec(dataUrl);
  if (!match) return undefined;
  const header = Buffer.from(match[1]!, "base64");
  if (!header.subarray(0, 8).equals(PNG_SIGNATURE) || header.toString("latin1", 12, 16) !== "IHDR")
    return undefined;
  const width = header.readUInt32BE(16);
  const height = header.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

export function highDetailImageTokens(model: string, dataUrl: string): number {
  const fixed = GEMINI_HIGH_RESOLUTION_IMAGE_TOKENS[model];
  if (fixed !== undefined) return fixed;
  const sizing = HIGH_DETAIL_SIZING[model];
  const size = sizing === undefined ? undefined : pngDimensions(dataUrl);
  if (sizing === undefined || size === undefined) return HIGH_DETAIL_IMAGE_TOKEN_CEILING;
  const patches = Math.ceil(size.width / 32) * Math.ceil(size.height / 32);
  // Integer tenths keep 1,350 × 1.2 at exactly 1,620 instead of a float just above it.
  return Math.ceil((Math.min(patches, sizing.patchBudget) * sizing.multiplierTenths) / 10);
}
