import { PNG } from "pngjs";

// ---------------------------------------------------------------------------
// Perceptual signature.
//
// A coarse, deterministic hash of a frame for no-progress detection in the loop.
// It is robust to small noise (a blinking cursor, a single changed clock digit)
// because it area-averages the frame down to a 16x16 grayscale grid and then
// quantizes each cell to 4 levels (2 bits). Two visually-identical frames produce
// the same signature; a clearly different frame differs. It is NOT reversible to
// the image, so exposing it (e.g. in a trace) is public-safe. On any decode
// failure it returns a stable fallback so two unreadable frames compare equal.
// ---------------------------------------------------------------------------

const SIGNATURE_GRID = 32;
const SIGNATURE_LEVELS = 16;
const SIGNATURE_FALLBACK = "unreadable";

/**
 * A perceptual hash of a PNG frame for no-progress detection. Decodes the PNG, area-averages it to
 * a SIGNATURE_GRID x SIGNATURE_GRID grayscale grid, CONTRAST-NORMALIZES that grid, quantizes each
 * cell to SIGNATURE_LEVELS, and packs the cells into a hex string. Deterministic (no Date, no
 * random). Returns SIGNATURE_FALLBACK on any decode failure so two unreadable frames compare equal.
 *
 * Why normalization, and why this grid (#383). The original was 16x16 at 2 bits per cell with no
 * normalization. On a 1440x950 desktop that is one cell per ~90x59 px, and on a light-themed web app
 * the area-average of nearly every cell lands at the top of the range: a measured run had 93% of the
 * 256 cells pinned to level 3 and levels 0 and 1 never used at all. The hash was effectively a
 * constant, so renaming a row in a sidebar, adding a list item, or opening a small panel could not
 * move it — 22 frames across one run produced 5 distinct values, and 9 visibly different consecutive
 * frames produced ONE. The no-progress backstop read that as a stuck agent and ended a lane that was
 * a foreign key away from finishing its mission.
 *
 * Stretching each frame's own min..max across the full range before quantizing is what makes a
 * mostly-white UI use the levels it actually has, and the finer grid shrinks a cell to ~45x30 px so
 * ordinary widget-sized changes survive the averaging.
 *
 * This is still a coarse whole-frame hash and it is still only ONE input to the backstop — see the
 * corroboration rule in computer-use.ts, which is what keeps a blind frame from ending a run on its
 * own.
 */
export function perceptualSignature(pngBytes: Buffer | Uint8Array): string {
  let cells: number[];
  try {
    const source = Buffer.isBuffer(pngBytes) ? pngBytes : Buffer.from(pngBytes);
    if (source.length === 0) return SIGNATURE_FALLBACK;
    const decoded = PNG.sync.read(source);
    const srcW = decoded.width;
    const srcH = decoded.height;
    if (!srcW || !srcH) return SIGNATURE_FALLBACK;
    cells = quantizedGrid(decoded.data, srcW, srcH);
    return `${brightnessAnchor(decoded.data, srcW, srcH)}${packCells(cells)}`;
  } catch {
    return SIGNATURE_FALLBACK;
  }
}

/** Area-average an RGBA buffer to a grid of grayscale cells, contrast-normalized then quantized. */
function quantizedGrid(data: Buffer, srcW: number, srcH: number): number[] {
  const grays: number[] = [];
  const xRatio = srcW / SIGNATURE_GRID;
  const yRatio = srcH / SIGNATURE_GRID;
  for (let gy = 0; gy < SIGNATURE_GRID; gy += 1) {
    const sy0 = Math.floor(gy * yRatio);
    const sy1 = Math.min(srcH, Math.max(sy0 + 1, Math.floor((gy + 1) * yRatio)));
    for (let gx = 0; gx < SIGNATURE_GRID; gx += 1) {
      const sx0 = Math.floor(gx * xRatio);
      const sx1 = Math.min(srcW, Math.max(sx0 + 1, Math.floor((gx + 1) * xRatio)));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        for (let sx = sx0; sx < sx1; sx += 1) {
          const si = (sy * srcW + sx) * 4;
          const r = data[si] ?? 0;
          const g = data[si + 1] ?? 0;
          const b = data[si + 2] ?? 0;
          sum += Math.round((r + g + b) / 3);
          n += 1;
        }
      }
      grays.push(n ? Math.round(sum / n) : 0);
    }
  }
  // Stretch this frame's own range across the full scale before quantizing. Without this a light UI
  // occupies a sliver at the top of 0..255 and quantizes to a near-constant (#383).
  //
  // The endpoints are TRIMMED rather than the raw min/max: a handful of extreme cells must not be
  // able to rescale the whole frame, or a blinking text cursor would rewrite every cell and read as
  // progress forever. Trimming K cells from each end clamps that away while still preserving real
  // structure, which occupies far more cells than K (a row of sidebar text covers dozens).
  const sorted = [...grays].sort((a, b) => a - b);
  const trim = Math.max(2, Math.floor(sorted.length / 256));
  const lo = sorted[Math.min(trim, sorted.length - 1)] ?? 0;
  const hi = sorted[Math.max(0, sorted.length - 1 - trim)] ?? 255;
  const span = hi - lo;
  const top = SIGNATURE_LEVELS - 1;
  return grays.map((gray) =>
    span <= 0 ? 0 : Math.min(top, Math.max(0, Math.round(((gray - lo) / span) * top)))
  );
}

/**
 * The frame's overall brightness, coarsely quantized. Normalization deliberately discards absolute
 * level, so this is prefixed back on for the two cases where absolute level IS the change: a uniform
 * frame (an all-white blank vs an all-black screen normalize identically), and a whole-page dim such
 * as a modal overlay, which preserves relative structure while changing the whole frame. Quantized
 * coarsely so ordinary antialiasing noise cannot move it.
 */
function brightnessAnchor(data: Buffer, srcW: number, srcH: number): string {
  let sum = 0;
  let n = 0;
  const stride = Math.max(1, Math.floor((srcW * srcH) / 4096));
  for (let p = 0; p < srcW * srcH; p += stride) {
    const si = p * 4;
    sum += ((data[si] ?? 0) + (data[si + 1] ?? 0) + (data[si + 2] ?? 0)) / 3;
    n += 1;
  }
  const mean = n ? sum / n : 0;
  return (Math.min(15, Math.floor(mean / 16))).toString(16);
}

/** Pack 4-bit cells (two per byte) into a compact hex string. */
function packCells(cells: number[]): string {
  const bytes = Buffer.alloc(Math.ceil(cells.length / 2));
  for (let i = 0; i < cells.length; i += 1) {
    const byteIndex = i >> 1;
    const shift = (i & 1) * 4;
    const value = (cells[i] ?? 0) & 0xf;
    bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (value << shift);
  }
  return bytes.toString("hex");
}
