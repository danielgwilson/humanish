import { PNG } from "pngjs";

// Whether a screen changed while a participant waited, and whether the change has stopped
// changing. The loop's watch (src/actors/computer-use/loop/watch.ts) asks after each look.
//
// The constants were chosen on 323 idle screenshot pairs from 203 retained hosted-desktop runs.
// Regions that changed on their own were the panel clock (2 to 6 tiles, every 60 s), a text caret
// (2 tiles, about every 0.5 s), Chrome's tab spinner (2 to 4 tiles) and one landing page's
// rotating tagline (10 to 36 tiles, median 18). Page loads, navigations and app updates changed
// 94 to 2,598 tiles. A moved list selection changed 35 tiles and a re-rendered
// block of timestamps 8 to 12, both missed by the frame hash in frame-signature.ts.
//
// The rule for small regions was chosen on the wave 9 look corpus: 3 pages recorded for 40 minutes
// each on hosted desktops, replayed over 84 to 168 look timelines a page. There a small region
// that held still woke the participant falsely beside a panel clock, a relative timestamp
// ("Opened 3 minutes ago", whose digit ticks each minute and whose tail shifts when the text
// grows) and a moving chart. With the conditions below it woke none falsely and missed no event.

/** The side of a square tile, in pixels: one tile is the unit of change. */
const TILE_PX = 16;
/**
 * A pixel changed when one of its channels differs by more than this (0 to 255). On the wave 9
 * corpus 32 added a false chart wake, and 48 split a new row's light fill from its text, so a row
 * read as small regions and was seen 69.9 s late.
 */
const PIXEL_TOLERANCE = 24;
/**
 * A tile changed when at least this many of its pixels changed. One or two pixels are an
 * antialiased edge: a spinner edge 2 pixels over the tolerance woke a 900 s watch in wave 7 live
 * run 3c. On the wave 9 corpus every tile of its status and export labels changed 10 to 69 pixels,
 * and its new rows (509 and 545 tiles) lost 7 or 8 tiles at 3. 1 and 3 gave the same wakes there.
 */
const TILE_MIN_PIXELS = 3;
/**
 * A still region of more than this many tiles wakes the participant at once: it is above every
 * self-changing region measured except 11 of 110 tagline swaps, and below every page change. On
 * the wave 9 corpus the status label (30 tiles) and new rows were large, and the export label (8
 * tiles) small.
 */
const LARGE_REGION_TILES = 24;
/**
 * A still region of at most LARGE_REGION_TILES tiles wakes the participant once every tile in it
 * has held still for more than this, and no tile within NEAR_TILES of it ticked or moved with a
 * region of more than LARGE_REGION_TILES tiles (a chart, a video) in this time. Minute updates (a
 * clock's minutes digit, "2 min ago") move again within it. On the wave 9 corpus a one-time
 * 8-tile text change was seen 72.4 s after it landed (median, 5 s looks). Without the moves in a
 * large region, a chart's tiles woke 3 watches falsely in its page's 40 minutes.
 */
const SMALL_REGION_HOLD_MS = 65_000;
/**
 * How near, in tiles, a ticking tile or a large moving region holds a small region back. The
 * relative timestamp's tail ("1 minute ago" to "2 minutes ago") sat 4 tiles from its digit in
 * wave 7 live run 2a and on the wave 9 corpus, where a distance of 1 left 4 tail wakes in 168
 * timelines and 4 left none.
 */
const NEAR_TILES = 4;
/**
 * A tile ticks when its last move came at least this long after the move before it, or when it
 * has moved once. A minute counter ticks. A spinner tile that moves every few looks does not, so a
 * label beside a spinner still wakes the participant, at 90 s on the wave 9 synthetic screens.
 */
const TICK_GAP_MS = 30_000;

/** A rectangle of the frame, in pixels from its top-left corner. */
export interface FrameRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What one look found, compared with the frame the participant last saw. `settled`: a region of
 * change held still long enough to wake the participant; `area` bounds it, and `small` is true
 * when it is at most LARGE_REGION_TILES tiles, which the participant's hint names. `changing`: tiles moved
 * since the previous look and nothing settled; `lookSoon` when more than LARGE_REGION_TILES moved,
 * so a large change is confirmed by a quick look. `unchanged`: nothing moved and nothing settled.
 * `held` on the last two bounds a small region that held still past the hold and is held back by a
 * ticking tile or a large moving region near it.
 */
export type FrameVerdict =
  | { readonly verdict: "unchanged"; readonly held?: FrameRegion }
  | { readonly verdict: "changing"; readonly lookSoon: boolean; readonly held?: FrameRegion }
  | { readonly verdict: "settled"; readonly area: FrameRegion; readonly small: boolean };

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
 * keeps the time it last moved, so a moving tile (a spinner) never joins a still region beside
 * it. Nothing is masked: a large change that stops changing always settles, and a small one does
 * unless a tile near it keeps ticking. Stillness is sampled at looks, so a blink seen in the same
 * phase at every look reads as still.
 */
export function watchFrames(reference: Buffer): {
  next(frame: Buffer, atMs: number): FrameVerdict;
} {
  const base = decode(reference);
  // Only tiles that differ from the reference are kept from the previous look, so a watch holds
  // one decoded frame and not two.
  const differing = new Map<number, DifferingTile>();
  let moves: TileMoves | undefined;
  return {
    next(frame, atMs) {
      const current = decode(frame);
      // A frame that cannot be decoded is compared by its bytes; a frame of another size is a new
      // screen, one change over the whole frame.
      if (base === undefined || current === undefined)
        return frame.equals(reference) ? UNCHANGED : wholeFrame(current ?? base);
      if (current.width !== base.width || current.height !== base.height)
        return wholeFrame(current);
      moves ??= tileMoves(base);
      return compare(base, current, atMs, differing, moves);
    },
  };
}

/** A tile that differed from the reference at the previous look. */
interface DifferingTile {
  /** The time of the last look it moved at. */
  movedAt: number;
  /** Its pixels at the look it last moved at, row by row. */
  pixels: Uint8Array;
}

/**
 * Per tile, the times of its last two moves (a move back to the reference counts), and of its
 * last move together with a connected moving region of more than LARGE_REGION_TILES tiles.
 */
interface TileMoves {
  readonly columns: number;
  readonly rows: number;
  readonly moved: Float64Array;
  readonly movedBefore: Float64Array;
  readonly movedLarge: Float64Array;
}

function tileMoves(image: Decoded): TileMoves {
  const columns = Math.ceil(image.width / TILE_PX);
  const rows = Math.ceil(image.height / TILE_PX);
  const never = () => new Float64Array(columns * rows).fill(Number.NaN);
  return { columns, rows, moved: never(), movedBefore: never(), movedLarge: never() };
}

function wholeFrame(image: Decoded | undefined): FrameVerdict {
  return {
    verdict: "settled",
    area: { x: 0, y: 0, width: image?.width ?? 0, height: image?.height ?? 0 },
    small: false,
  };
}

function compare(
  base: Decoded,
  current: Decoded,
  atMs: number,
  differing: Map<number, DifferingTile>,
  moves: TileMoves,
): FrameVerdict {
  const { columns, rows } = moves;
  const still = new Set<number>();
  const movedNow = new Set<number>();
  let moved = 0;
  const move = (tile: number) => {
    moves.movedBefore[tile] = moves.moved[tile]!;
    moves.moved[tile] = atMs;
    movedNow.add(tile);
  };
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      const tile = row * columns + column;
      const before = differing.get(tile);
      if (!framesDiffer(base, current, column, row)) {
        if (before === undefined) continue;
        differing.delete(tile);
        // A move back to the reference is a move: a ticking digit can tick back to its old shape.
        if (tileDiffers(before.pixels, current, column, row)) move(tile);
        continue;
      }
      // A tile that starts differing has moved, whatever the previous look's pixels were.
      if (before === undefined || tileDiffers(before.pixels, current, column, row)) {
        differing.set(tile, { movedAt: atMs, pixels: tilePixels(current, column, row) });
        move(tile);
        moved += 1;
      } else still.add(tile);
    }
  for (const region of connectedRegions(movedNow, columns))
    if (region.length > LARGE_REGION_TILES)
      for (const tile of region) moves.movedLarge[tile] = atMs;
  const regions = connectedRegions(still, columns);
  const area = (region: readonly number[]) => areaOf(region, columns, base.width, base.height);
  const large = largest(regions.filter((region) => region.length > LARGE_REGION_TILES));
  if (large !== undefined) return { verdict: "settled", area: area(large), small: false };
  const heldSmall = regions.filter((region) =>
    region.every((tile) => atMs - (differing.get(tile)?.movedAt ?? atMs) > SMALL_REGION_HOLD_MS),
  );
  const settled = largest(heldSmall.filter((region) => !heldBack(region, moves, atMs)));
  if (settled !== undefined) return { verdict: "settled", area: area(settled), small: true };
  const waiting = largest(heldSmall);
  const held = waiting === undefined ? {} : { held: area(waiting) };
  if (moved > 0) return { verdict: "changing", lookSoon: moved > LARGE_REGION_TILES, ...held };
  return { verdict: "unchanged", ...held };
}

/**
 * Whether a tile within NEAR_TILES of the region, outside it, ticked or moved with a large region
 * within the hold.
 */
function heldBack(region: readonly number[], moves: TileMoves, atMs: number): boolean {
  const inRegion = new Set(region);
  // NaN, a tile that never moved, is never recent.
  const recent = (ms: number) => atMs - ms <= SMALL_REGION_HOLD_MS;
  for (const tile of region)
    for (let dy = -NEAR_TILES; dy <= NEAR_TILES; dy += 1)
      for (let dx = -NEAR_TILES; dx <= NEAR_TILES; dx += 1) {
        const column = (tile % moves.columns) + dx;
        const row = Math.floor(tile / moves.columns) + dy;
        if (column < 0 || column >= moves.columns || row < 0 || row >= moves.rows) continue;
        const near = row * moves.columns + column;
        const moved = moves.moved[near]!;
        if (inRegion.has(near) || !recent(moved)) continue;
        const before = moves.movedBefore[near]!;
        if (
          Number.isNaN(before) ||
          moved - before >= TICK_GAP_MS ||
          recent(moves.movedLarge[near]!)
        )
          return true;
      }
  return false;
}

/** Whether at least TILE_MIN_PIXELS pixels of one tile differ between two frames of one size. */
function framesDiffer(a: Decoded, b: Decoded, column: number, row: number): boolean {
  const { width, height } = a;
  const xEnd = Math.min(width, (column + 1) * TILE_PX);
  const yEnd = Math.min(height, (row + 1) * TILE_PX);
  let changed = 0;
  for (let y = row * TILE_PX; y < yEnd; y += 1)
    for (let x = column * TILE_PX; x < xEnd; x += 1) {
      const at = (y * width + x) * 4;
      if (
        (Math.abs(a.data[at]! - b.data[at]!) > PIXEL_TOLERANCE ||
          Math.abs(a.data[at + 1]! - b.data[at + 1]!) > PIXEL_TOLERANCE ||
          Math.abs(a.data[at + 2]! - b.data[at + 2]!) > PIXEL_TOLERANCE) &&
        ++changed >= TILE_MIN_PIXELS
      )
        return true;
    }
  return false;
}

/** A copy of one tile's RGBA pixels, row by row. */
function tilePixels(image: Decoded, column: number, row: number): Uint8Array {
  const xStart = column * TILE_PX;
  const xEnd = Math.min(image.width, xStart + TILE_PX);
  const yEnd = Math.min(image.height, (row + 1) * TILE_PX);
  const pixels = new Uint8Array((xEnd - xStart) * (yEnd - row * TILE_PX) * 4);
  let to = 0;
  for (let y = row * TILE_PX; y < yEnd; y += 1) {
    const from = (y * image.width + xStart) * 4;
    pixels.set(image.data.subarray(from, from + (xEnd - xStart) * 4), to);
    to += (xEnd - xStart) * 4;
  }
  return pixels;
}

/**
 * Whether at least TILE_MIN_PIXELS pixels of one tile of `image` differ from `pixels`, that tile's
 * earlier pixels.
 */
function tileDiffers(pixels: Uint8Array, image: Decoded, column: number, row: number): boolean {
  const xStart = column * TILE_PX;
  const xEnd = Math.min(image.width, xStart + TILE_PX);
  const yEnd = Math.min(image.height, (row + 1) * TILE_PX);
  const { data } = image;
  let at = 0;
  let changed = 0;
  for (let y = row * TILE_PX; y < yEnd; y += 1)
    for (let x = xStart; x < xEnd; x += 1, at += 4) {
      const from = (y * image.width + x) * 4;
      if (
        (Math.abs(pixels[at]! - data[from]!) > PIXEL_TOLERANCE ||
          Math.abs(pixels[at + 1]! - data[from + 1]!) > PIXEL_TOLERANCE ||
          Math.abs(pixels[at + 2]! - data[from + 2]!) > PIXEL_TOLERANCE) &&
        ++changed >= TILE_MIN_PIXELS
      )
        return true;
    }
  return false;
}

/** Tiles grouped with every tile of the set next to them, diagonals included. */
function connectedRegions(tiles: ReadonlySet<number>, columns: number): number[][] {
  const seen = new Set<number>();
  const regions: number[][] = [];
  for (const start of tiles) {
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
          if (!tiles.has(neighbour) || seen.has(neighbour)) continue;
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
