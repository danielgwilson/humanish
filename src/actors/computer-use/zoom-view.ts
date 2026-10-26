import { PNG } from "pngjs";

// The image a participant is shown for a zoom. The desktop returns the region at its own pixels,
// which is what the bundle keeps; a participant looking closer is shown the region enlarged.
// Anthropic's computer-use toolset documents its zoom member as the region "scaled to fit within
// your usual screenshot dimensions with its aspect ratio preserved".

/** The size a zoom is enlarged to fit when the caller has no screenshot size: 1280x800, the
 *  screenshot size Anthropic's computer-use guide recommends for web applications. */
export const ZOOM_FIT: Readonly<{ width: number; height: number }> = { width: 1280, height: 800 };

/** The width and height a PNG's IHDR declares, or undefined for bytes that are not a PNG. */
export function screenSize(png: Buffer | undefined): { width: number; height: number } | undefined {
  if (png === undefined || png.length < 24) return undefined;
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return undefined;
  if (png.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * `crop` (a PNG) enlarged to fit within `fit`, its usual screenshot size, with its aspect ratio
 * kept, by bilinear sampling. A crop that already reaches `fit` on either side comes back
 * unchanged: a zoom never shows less than the desktop's own pixels. Bytes that are not a PNG
 * come back unchanged too, for the caller's own image checks to refuse.
 *
 * Bilinear rather than nearest: the factor is rarely a whole number (a 220x20 strip fit to
 * 1440x950 is 6.5x), and nearest sampling at a fractional factor repeats some source columns once
 * more than others, so strokes of one width in small text come out at two widths. Bilinear keeps
 * their proportions and softens their edges.
 */
export function zoomView(
  crop: Buffer,
  fit: Readonly<{ width: number; height: number }> = ZOOM_FIT,
): Buffer {
  let source: PNG;
  try {
    source = PNG.sync.read(crop);
  } catch {
    return crop;
  }
  const scale = Math.min(fit.width / source.width, fit.height / source.height);
  if (!(scale > 1)) return crop;
  const width = Math.max(1, Math.min(fit.width, Math.round(source.width * scale)));
  const height = Math.max(1, Math.min(fit.height, Math.round(source.height * scale)));
  const shown = new PNG({ width, height });
  const from = source.data;
  const to = shown.data;
  const sx = source.width / width;
  const sy = source.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(source.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(source.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const wx = fx - x0;
      const a = (y0 * source.width + x0) * 4;
      const b = (y0 * source.width + x1) * 4;
      const c = (y1 * source.width + x0) * 4;
      const d = (y1 * source.width + x1) * 4;
      const out = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const top = from[a + channel]! + (from[b + channel]! - from[a + channel]!) * wx;
        const bottom = from[c + channel]! + (from[d + channel]! - from[c + channel]!) * wx;
        to[out + channel] = Math.round(top + (bottom - top) * wy);
      }
    }
  }
  return PNG.sync.write(shown);
}
