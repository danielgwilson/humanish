import { PNG } from "pngjs";

// Whether a screen changed while a participant waited, and whether the change has stopped
// changing. The loop's watch (src/actors/computer-use/loop/watch.ts) asks after each look.
//
// The constants were chosen on 323 idle screenshot pairs from 203 retained hosted-desktop runs
// (design note for #1814). Regions that changed on their own were the panel clock (2 to 6 tiles,
// every 60 s), a text caret (2 tiles, about every 0.5 s), Chrome's tab spinner (2 to 4 tiles) and
// one landing page's rotating tagline (10 to 36 tiles, median 18). Page loads, navigations and app
// updates changed 94 to 2,598 tiles. A moved list selection changed 35 tiles and a re-rendered
// block of timestamps 8 to 12, both missed by the frame hash in frame-signature.ts.

/** The side of a square tile, in pixels: one tile is the unit of change. */
const TILE_PX = 16;
/** A pixel changed when one of its channels differs by more than this (0 to 255). */
const PIXEL_TOLERANCE = 24;
/**
 * A still region of more than this many tiles wakes the participant at once: it is above every
 * self-changing region measured except 11 of 110 tagline swaps, and below every page change.
 */
const LARGE_REGION_TILES = 24;
/**
 * A still region of at most LARGE_REGION_TILES tiles wakes the participant once every tile in it
 * has held still for more than this. Minute updates (a clock, "2 min ago") move again within it.
 */
const SMALL_REGION_HOLD_MS = 65_000;

/** A rectangle of the frame, in pixels from its top-left corner. */
export interface FrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What one look found, compared with the frame the participant last saw. `settled`: a region of
 * change held still long enough to wake the participant; `area` bounds it. `changing`: tiles moved
 * since the previous look and nothing settled; `lookSoon` when more than LARGE_REGION_TILES moved,
 * so a large change is confirmed by a quick look. `unchanged`: nothing moved and nothing settled.
 */
export type FrameVerdict =
  | { readonly verdict: "unchanged" }
  | { readonly verdict: "changing"; readonly lookSoon: boolean }
  | { readonly verdict: "settled"; readonly area: FrameRegion };

interface Decoded {
  readonly width: number;
  readonly height: number;
  readonly data: Buffer;
}

const UNCHANGED: FrameVerdict = { verdict: "unchanged" };

function decode(frame: Buffer): Decoded | undefined {
  try {
    const image = PNG.sync.read(frame);
    return image.width > 0 && image.height > 0 ? image : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compare later looks at one screen with `reference`, the frame the participant last saw. Call
 * `next` once per look, in order, with the look's time. Each tile that differs from the reference
 * keeps the time it last moved, so a moving tile (a spinner) never joins or delays a still region
 * beside it. Nothing is masked: a change that stops changing always settles. Stillness is sampled
 * at looks, so a blink seen in the same phase at every look reads as still.
 */
export function watchFrames(reference: Buffer): {
  next(frame: Buffer, atMs: number): FrameVerdict;
} {
  const base = decode(reference);
  let previous = base;
  /** Tile index to the last look it moved at, for each tile now differing from the reference. */
  const movedAt = new Map<number, number>();
  return {
    next(frame, atMs) {
      const current = decode(frame);
      // A frame that cannot be decoded is compared by its bytes; a frame of another size is a new
      // screen, one change over the whole frame.
      if (base === undefined || current === undefined)
        return frame.equals(reference) ? UNCHANGED : wholeFrame(current ?? base);
      if (current.width !== base.width || current.height !== base.height)
        return wholeFrame(current);
      const verdict = compare(base, previous ?? base, current, atMs, movedAt);
      previous = current;
      return verdict;
    },
  };
}

function wholeFrame(image: Decoded | undefined): FrameVerdict {
  return {
    verdict: "settled",
    area: { x: 0, y: 0, width: image?.width ?? 0, height: image?.height ?? 0 },
  };
}

function compare(
  base: Decoded,
  previous: Decoded,
  current: Decoded,
  atMs: number,
  movedAt: Map<number, number>,
): FrameVerdict {
  const columns = Math.ceil(base.width / TILE_PX);
  const rows = Math.ceil(base.height / TILE_PX);
  const still = new Set<number>();
  let moved = 0;
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const tile = row * columns + column;
      if (!tileDiffers(base, current, column, row)) {
        movedAt.delete(tile);
        continue;
      }
      // A tile that starts differing has moved, whatever the previous look's pixels were.
      if (!movedAt.has(tile) || tileDiffers(previous, current, column, row)) {
        movedAt.set(tile, atMs);
        moved += 1;
      } else still.add(tile);
    }
  const regions = stillRegions(still, columns);
  const large = largest(regions.filter((region) => region.length > LARGE_REGION_TILES));
  const held = largest(
    regions.filter((region) =>
      region.every((tile) => atMs - (movedAt.get(tile) ?? atMs) > SMALL_REGION_HOLD_MS),
    ),
  );
  const settled = large ?? held;
  if (settled !== undefined)
    return { verdict: "settled", area: areaOf(settled, columns, base.width, base.height) };
  if (moved > 0) return { verdict: "changing", lookSoon: moved > LARGE_REGION_TILES };
  return UNCHANGED;
}

/** Whether any pixel of one tile differs between two frames of the same size. */
function tileDiffers(a: Decoded, b: Decoded, column: number, row: number): boolean {
  const { width, height } = a;
  const xEnd = Math.min(width, (column + 1) * TILE_PX);
  const yEnd = Math.min(height, (row + 1) * TILE_PX);
  for (let y = row * TILE_PX; y < yEnd; y += 1)
    for (let x = column * TILE_PX; x < xEnd; x += 1) {
      const at = (y * width + x) * 4;
      if (
        Math.abs(a.data[at]! - b.data[at]!) > PIXEL_TOLERANCE ||
        Math.abs(a.data[at + 1]! - b.data[at + 1]!) > PIXEL_TOLERANCE ||
        Math.abs(a.data[at + 2]! - b.data[at + 2]!) > PIXEL_TOLERANCE
      )
        return true;
    }
  return false;
}

/** Still tiles grouped with every still tile next to them, diagonals included. */
function stillRegions(still: ReadonlySet<number>, columns: number): number[][] {
  const seen = new Set<number>();
  const regions: number[][] = [];
  for (const start of still) {
    if (seen.has(start)) continue;
    seen.add(start);
    const region: number[] = [];
    const queue = [start];
    for (let tile = queue.pop(); tile !== undefined; tile = queue.pop()) {
      region.push(tile);
      const column = tile % columns;
      for (const dy of [-1, 0, 1])
        for (const dx of [-1, 0, 1]) {
          const neighbourColumn = column + dx;
          const neighbour = tile + dy * columns + dx;
          if (neighbourColumn < 0 || neighbourColumn >= columns) continue;
          if (!still.has(neighbour) || seen.has(neighbour)) continue;
          seen.add(neighbour);
          queue.push(neighbour);
        }
    }
    regions.push(region);
  }
  return regions;
}

function largest(regions: number[][]): number[] | undefined {
  return regions.reduce<number[] | undefined>(
    (best, region) => (best === undefined || region.length > best.length ? region : best),
    undefined,
  );
}

function areaOf(tiles: readonly number[], columns: number, width: number, height: number) {
  const columnsOf = tiles.map((tile) => tile % columns);
  const rowsOf = tiles.map((tile) => Math.floor(tile / columns));
  const x = Math.min(...columnsOf) * TILE_PX;
  const y = Math.min(...rowsOf) * TILE_PX;
  return {
    x,
    y,
    width: Math.min(width, (Math.max(...columnsOf) + 1) * TILE_PX) - x,
    height: Math.min(height, (Math.max(...rowsOf) + 1) * TILE_PX) - y,
  };
}
