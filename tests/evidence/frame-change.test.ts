import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { watchFrames, type FrameVerdict } from "../../src/evidence/frame-change.js";

// Later looks at one screen compared with the frame the participant last saw. The four retained
// frames are public pages from live runs (tests/fixtures/frame-change/README.md); the rest are
// drawn here at the geometry the design note measured. Looks come every 5 s unless a case says
// otherwise. A small region settles once all its tiles have held still for more than 65 s and no
// tile within 4 tiles of it ticked or moved with a large region in that time.

const fixture = (name: string): Buffer =>
  readFileSync(new URL(`../fixtures/frame-change/${name}`, import.meta.url));

const CLOCK_2229 = fixture("example-clock-2229.png");
const CLOCK_2230 = fixture("example-clock-2230.png");
const TUI_DRY = fixture("tui-dry-run-selected.png");
const TUI_LIVE = fixture("tui-live-run-selected.png");

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A light frame with dark boxes drawn on it. */
function drawn(width: number, height: number, boxes: readonly Box[]): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(240);
  for (const box of boxes)
    for (let y = box.y; y < box.y + box.height; y += 1)
      for (let x = box.x; x < box.x + box.width; x += 1) {
        const at = (y * width + x) * 4;
        image.data[at] = 20;
        image.data[at + 1] = 20;
        image.data[at + 2] = 20;
      }
  return PNG.sync.write(image);
}

/** `frame` with the pixels inside `box` inverted: different pixels in the same tiles. */
function inverted(frame: Buffer, box: Box): Buffer {
  const image = PNG.sync.read(frame);
  for (let y = box.y; y < box.y + box.height; y += 1)
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const at = (y * image.width + x) * 4;
      for (let channel = 0; channel < 3; channel += 1)
        image.data[at + channel] = 255 - image.data[at + channel]!;
    }
  return PNG.sync.write(image);
}

/** Feed `frameAt(t)` to one watch at each look time and return the verdicts by time. */
function watch(
  reference: Buffer,
  times: readonly number[],
  frameAt: (atMs: number) => Buffer,
): Array<[number, FrameVerdict]> {
  const frames = watchFrames(reference);
  return times.map((atMs) => [atMs, frames.next(frameAt(atMs), atMs)]);
}

const everyFiveSeconds = (fromS: number, toS: number): number[] =>
  Array.from({ length: (toS - fromS) / 5 + 1 }, (_, index) => (fromS + index * 5) * 1000);

const settledTimes = (verdicts: Array<[number, FrameVerdict]>): number[] =>
  verdicts.filter(([, verdict]) => verdict.verdict === "settled").map(([atMs]) => atMs);

describe("watchFrames on retained frames", () => {
  it("reads a byte-identical frame as unchanged", () => {
    expect(watchFrames(CLOCK_2229).next(CLOCK_2229, 5_000)).toEqual({ verdict: "unchanged" });
  });

  it("sees the TUI selection move at once and settles it at the quick look after", () => {
    const frames = watchFrames(TUI_DRY);
    // 35 tiles appear at once, more than 24, so the next look comes soon.
    expect(frames.next(TUI_LIVE, 5_000)).toEqual({ verdict: "changing", lookSoon: true });
    // Rows 24 to 26 and columns 0 to 11 of 16 px tiles hold the two changed lines (x 8 to 184,
    // y 389 to 421 in pixels); held still since the last look, they wake the participant.
    expect(frames.next(TUI_LIVE, 5_500)).toEqual({
      verdict: "settled",
      area: { x: 0, y: 384, width: 192, height: 48 },
      small: false,
    });
  });

  it("never settles a panel clock's tens digit while its ones digit ticks each minute", () => {
    // The fixtures read 22:29 and 22:30: the tens digit (x 1385 to 1391) sits in the tile column
    // at x 1376 and the ones digit (x 1392 to 1399) in the column at x 1392. Both move at 30 s.
    // At 90 s and 150 s only the ones digit moves, drawn here by inverting its pixels. At 150 s
    // the tens tiles form a region alone, still for 120 s, but the ones tiles next to them ticked
    // (moves 60 s apart), so they are held back. The earlier rule woke the participant here, once
    // in each 10 minutes on a hosted desktop (wave 7 live run 1a: 6 wakes in an hour).
    const onesDigit = { x: 1392, y: 7, width: 8, height: 11 };
    const clock2231 = inverted(CLOCK_2230, onesDigit);
    const clock2232 = inverted(clock2231, { x: 1392, y: 12, width: 8, height: 6 });
    const verdicts = watch(CLOCK_2229, everyFiveSeconds(5, 150), (atMs) =>
      atMs < 30_000
        ? CLOCK_2229
        : atMs < 90_000
          ? CLOCK_2230
          : atMs < 150_000
            ? clock2231
            : clock2232,
    );
    expect(settledTimes(verdicts)).toEqual([]);
    expect(verdicts.at(-1)?.[1]).toEqual({
      verdict: "changing",
      lookSoon: false,
      held: { x: 1376, y: 0, width: 16, height: 32 },
    });
  });

  it("settles a small change that stops moving once it has held for more than 65 s", () => {
    // Still from 30 s: 65 s at the 95 s look is not more than 65 s; 70 s at 100 s is.
    const verdicts = watch(CLOCK_2229, everyFiveSeconds(5, 105), (atMs) =>
      atMs < 30_000 ? CLOCK_2229 : CLOCK_2230,
    );
    expect(settledTimes(verdicts)[0]).toBe(100_000);
    expect(verdicts.find(([atMs]) => atMs === 100_000)?.[1]).toEqual({
      verdict: "settled",
      area: { x: 1376, y: 0, width: 32, height: 32 },
      small: true,
    });
  });
});

// The synthetic checks of the wave 9 pixel-rule study (rules/pixel/RESULT.md, "Synthetic checks"),
// on a 320 x 160 screen of 20 x 10 tiles whose row 0 is the panel. A glyph is 40 dark pixels in one
// tile, placed by its seed, so two seeds draw different pixels in the same tile. Each watch looks
// every 5 s for 600 s; the expected wakes are the study's column for the proposed rule.

type Glyph = readonly [column: number, row: number, seed: number];

function glyphs(list: readonly Glyph[]): Buffer {
  const image = new PNG({ width: 320, height: 160 });
  image.data.fill(240);
  for (const [column, row, seed] of list) {
    let state = (seed * 2654435761) >>> 0;
    for (let dot = 0; dot < 40; dot += 1) {
      state = (state * 1103515245 + 12345) >>> 0;
      const at =
        ((row * 16 + ((state >>> 16) % 16)) * 320 + column * 16 + ((state >>> 8) % 16)) * 4;
      image.data.fill(30, at, at + 3);
    }
  }
  return PNG.sync.write(image);
}

/** How often a counter has changed by `atMs`, when it changes at `fromMs` and every `everyMs`. */
const ticksBy = (atMs: number, everyMs: number, fromMs: number): number =>
  atMs < fromMs ? 0 : 1 + Math.floor((atMs - fromMs) / everyMs);

/** The first look of a 600 s watch over `scene` that settled, as [time, verdict]. */
const firstSettled = (scene: (atMs: number) => Buffer): [number, FrameVerdict] | undefined =>
  watch(scene(0), everyFiveSeconds(5, 600), scene).find(
    ([, verdict]) => verdict.verdict === "settled",
  );

describe("watchFrames on the wave 9 synthetic screens", () => {
  it("never settles a panel clock's tens tile beside its ticking minutes tile", () => {
    // The minutes tile (column 18) changes at 30 s and every 60 s after; the tens tile (column 17)
    // changes once at 30 s. The earlier rule woke at 150 s.
    const scene = (atMs: number) =>
      glyphs([
        [18, 0, 100 + ticksBy(atMs, 60_000, 30_000)],
        [17, 0, atMs < 30_000 ? 1 : 2],
      ]);
    expect(firstSettled(scene)).toBeUndefined();
  });

  it("never settles a relative timestamp's tail 4 tiles from its ticking digit", () => {
    // Live run 2a: "1 minute ago" became "2 minutes ago", so the tail (columns 8 to 10) shifted
    // once at 30 s, while the digit (column 4) changes every 60 s. The earlier rule woke at 100 s.
    const scene = (atMs: number) =>
      glyphs([
        [4, 5, 100 + ticksBy(atMs, 60_000, 30_000)],
        ...[8, 9, 10].map((column): Glyph => [column, 5, column + (atMs < 30_000 ? 0 : 50)]),
      ]);
    expect(firstSettled(scene)).toBeUndefined();
  });

  it("never settles a label beside a moving chart of 36 tiles", () => {
    // The chart (rows 7 to 9, columns 2 to 13) changes at every look; a 3-tile label appears in
    // row 5 at 20 s. The chart's tiles move every look, so they never tick; they move with a
    // region of more than 24 tiles. The earlier rule woke at 90 s.
    const scene = (atMs: number) => {
      const chart: Glyph[] = [];
      for (let column = 2; column < 14; column += 1)
        for (const row of [7, 8, 9])
          chart.push([column, row, 3000 + Math.floor(atMs / 5_000) * 64 + column * 3 + row]);
      const label: Glyph[] = [6, 7, 8].map((column) => [column, 5, 700 + column]);
      return glyphs(atMs < 20_000 ? chart : [...chart, ...label]);
    };
    expect(firstSettled(scene)).toBeUndefined();
  });

  it("settles a label beside a spinner tile that changes at every look, at 90 s", () => {
    // The spinner (column 5, row 5) moves every 5 s, so it never ticks; the label in columns 6 to
    // 8 appears at 20 s and is still for 70 s at 90 s.
    const spinner = (atMs: number): Glyph => [5, 5, 500 + Math.floor(atMs / 5_000)];
    const scene = (atMs: number) =>
      glyphs([
        spinner(atMs),
        ...(atMs < 20_000 ? [] : [6, 7, 8].map((column): Glyph => [column, 5, 700 + column])),
      ]);
    expect(firstSettled(scene)).toEqual([
      90_000,
      { verdict: "settled", area: { x: 96, y: 80, width: 48, height: 16 }, small: true },
    ]);
  });

  it("settles a label 5 tiles from a ticking digit, outside the 4 tiles that hold it back", () => {
    // The digit (column 4) changes at 30 s and every 60 s after; the label in columns 9 to 11
    // appears at 10 s and is still for 70 s at 80 s.
    const scene = (atMs: number) =>
      glyphs([
        [4, 5, 100 + ticksBy(atMs, 60_000, 30_000)],
        ...(atMs < 10_000 ? [] : [9, 10, 11].map((column): Glyph => [column, 5, 700 + column])),
      ]);
    expect(firstSettled(scene)).toEqual([
      80_000,
      { verdict: "settled", area: { x: 144, y: 80, width: 48, height: 16 }, small: true },
    ]);
  });

  // A tile 2 tiles from a label (column 4) changes every `everyMs` from `everyMs`; the label in
  // columns 6 to 8 appears at 10 s.
  const besideMover = (everyMs: number) => (atMs: number) =>
    glyphs([
      [4, 5, 300 + ticksBy(atMs, everyMs, everyMs)],
      ...(atMs < 10_000 ? [] : [6, 7, 8].map((column): Glyph => [column, 5, 700 + column])),
    ]);

  it("settles a label beside a tile that changes every 20 s, which does not tick, at 80 s", () => {
    // Its moves are 20 s apart, under the 30 s a tick needs, so only its first move holds the
    // label back.
    expect(firstSettled(besideMover(20_000))).toEqual([
      80_000,
      { verdict: "settled", area: { x: 96, y: 80, width: 48, height: 16 }, small: true },
    ]);
  });

  it("never settles a label beside a tile that changes every 30 s, which ticks", () => {
    expect(firstSettled(besideMover(30_000))).toBeUndefined();
  });

  it("counts a ticker's move back to its first frame as a tick that holds a label back", () => {
    // The ticker (column 0, row 5) changes at 30 s and returns to the reference frame at 90 s; the
    // label in columns 2 to 4 appears at 10 s. The move back holds the label until 65 s after it:
    // 155 s is 65 s after, not more, so the label first settles at 160 s.
    const scene = (atMs: number) =>
      glyphs([
        ...(atMs >= 30_000 && atMs < 90_000 ? [[0, 5, 77] as const] : []),
        ...(atMs < 10_000 ? [] : [2, 3, 4].map((column): Glyph => [column, 5, 600 + column])),
      ]);
    expect(firstSettled(scene)).toEqual([
      160_000,
      { verdict: "settled", area: { x: 32, y: 80, width: 48, height: 16 }, small: true },
    ]);
  });

  it("settles a one-time 3-tile label 70 s after it appears", () => {
    // The label appears at 100 s in columns 12 to 14 of row 7, with nothing else moving.
    const scene = (atMs: number) =>
      glyphs(atMs < 100_000 ? [] : [12, 13, 14].map((column): Glyph => [column, 7, 900 + column]));
    expect(firstSettled(scene)).toEqual([
      170_000,
      { verdict: "settled", area: { x: 192, y: 112, width: 48, height: 16 }, small: true },
    ]);
  });

  it("settles a 30-tile popup over the panel at the look after it appears", () => {
    // Rows 0 and 1, columns 5 to 19, from 10 s: still at the 15 s look, and large.
    const popup: Glyph[] = [];
    for (let column = 5; column < 20; column += 1)
      for (const row of [0, 1]) popup.push([column, row, 1000 + column + row]);
    expect(firstSettled((atMs) => glyphs(atMs < 10_000 ? [] : popup))).toEqual([
      15_000,
      { verdict: "settled", area: { x: 80, y: 0, width: 240, height: 32 }, small: false },
    ]);
  });

  it("settles a 30-tile row beside a spinner at the look after it appears", () => {
    // The spinner (column 5, row 5) moves every 5 s; the row (rows 6 and 7, columns 2 to 16)
    // appears at 50 s.
    const row: Glyph[] = [];
    for (let column = 2; column < 17; column += 1)
      for (const line of [6, 7]) row.push([column, line, 1200 + column + line]);
    const scene = (atMs: number) =>
      glyphs([[5, 5, 500 + Math.floor(atMs / 5_000)], ...(atMs < 50_000 ? [] : row)]);
    expect(firstSettled(scene)).toEqual([
      55_000,
      { verdict: "settled", area: { x: 32, y: 96, width: 240, height: 32 }, small: false },
    ]);
  });
});

describe("watchFrames on drawn frames", () => {
  // A 1 x 27 px text caret at x 100 crosses two 16 px tiles, as the measured carets did.
  const CARET = { x: 100, y: 100, width: 1, height: 27 };
  const caretShown = drawn(320, 240, [CARET]);
  const caretHidden = drawn(320, 240, []);

  it("never settles a caret seen visible and hidden on alternating looks", () => {
    const verdicts = watch(caretShown, everyFiveSeconds(5, 120), (atMs) =>
      (atMs / 5_000) % 2 === 1 ? caretHidden : caretShown,
    );
    expect(settledTimes(verdicts)).toEqual([]);
  });

  it("settles a caret seen hidden at every look once the hold passes, the sampling limit", () => {
    // Hidden from the 5 s look: 65 s still at 70 s, 70 s at 75 s.
    const verdicts = watch(caretShown, everyFiveSeconds(5, 75), () => caretHidden);
    expect(settledTimes(verdicts)).toEqual([75_000]);
  });

  it("reads a turning tab spinner as changing at every look", () => {
    // Chrome's tab throbber at x 56 to 72, y 68 to 84: a dot at a new place each phase.
    const phase = (step: number): Buffer =>
      drawn(320, 240, [
        { x: 56 + (step % 4) * 4, y: 68 + ((step + 1) % 4) * 4, width: 4, height: 4 },
      ]);
    const verdicts = watch(phase(0), [5_000, 10_000, 15_000], (atMs) => phase(atMs / 5_000));
    expect(verdicts.map(([, verdict]) => verdict)).toEqual([
      { verdict: "changing", lookSoon: false },
      { verdict: "changing", lookSoon: false },
      { verdict: "changing", lookSoon: false },
    ]);
  });

  it("settles a new label beside a spinner that never stops, with the label's area only", () => {
    // The label fills tiles 5 to 7 of row 5 from 10 s; the spinner in tiles 8 and 9 next to it
    // moves at every look. The label is still for 70 s at 80 s.
    const LABEL = { x: 80, y: 80, width: 48, height: 16 };
    const spinner = (step: number): Box => ({
      x: 128 + (step % 3) * 8,
      y: 80 + (step % 2) * 8,
      width: 8,
      height: 8,
    });
    const verdicts = watch(drawn(320, 240, [spinner(0)]), everyFiveSeconds(5, 80), (atMs) => {
      const step = atMs / 5_000;
      return drawn(320, 240, atMs < 10_000 ? [spinner(step)] : [LABEL, spinner(step)]);
    });
    expect(settledTimes(verdicts)).toEqual([80_000]);
    expect(verdicts.at(-1)?.[1]).toEqual({ verdict: "settled", area: LABEL, small: true });
  });

  it("settles the icon a progress bar ends in once the icon has held past the hold", () => {
    // The bar grows over three looks, then a 2-tile icon replaces it at 20 s: 70 s still at 90 s.
    // The icon draws two dots inside tiles 4 and 5 of row 8, which the full bar had filled.
    const bar = (tiles: number): Box => ({ x: 32, y: 128, width: tiles * 16, height: 16 });
    const ICON = { x: 64, y: 128, width: 32, height: 16 };
    const dots = [
      { x: 68, y: 132, width: 8, height: 8 },
      { x: 84, y: 132, width: 8, height: 8 },
    ];
    const verdicts = watch(drawn(320, 240, []), everyFiveSeconds(5, 95), (atMs) =>
      drawn(320, 240, atMs < 20_000 ? [bar((atMs / 5_000) * 2)] : dots),
    );
    expect(settledTimes(verdicts)[0]).toBe(90_000);
    expect(verdicts.find(([atMs]) => atMs === 90_000)?.[1]).toEqual({
      verdict: "settled",
      area: ICON,
      small: true,
    });
  });

  it("restarts a label's hold when it changes again in the same tiles", () => {
    // Three tiles at 10 s, different pixels in the same tiles at 30 s: 70 s still at 100 s.
    const first = drawn(320, 240, [{ x: 80, y: 80, width: 48, height: 16 }]);
    const second = drawn(320, 240, [{ x: 80, y: 84, width: 48, height: 8 }]);
    const verdicts = watch(drawn(320, 240, []), everyFiveSeconds(5, 100), (atMs) =>
      atMs < 10_000 ? drawn(320, 240, []) : atMs < 30_000 ? first : second,
    );
    expect(settledTimes(verdicts)).toEqual([100_000]);
  });

  it("never settles a tile that differs from the reference by 2 pixels, an antialiased edge", () => {
    // Live run 3c (wave 7): one tile held only a spinner's top edge, 2 pixels over the tolerance
    // (largest channel difference 30), and woke a 900 s watch. Here 2 pixels of one tile darken
    // by 30 from 10 s on.
    const edge = PNG.sync.read(drawn(320, 160, []));
    for (const x of [163, 164]) edge.data.fill(210, (103 * 320 + x) * 4, (103 * 320 + x) * 4 + 3);
    const verdicts = watch(drawn(320, 160, []), everyFiveSeconds(5, 600), (atMs) =>
      atMs < 10_000 ? drawn(320, 160, []) : PNG.sync.write(edge),
    );
    expect(settledTimes(verdicts)).toEqual([]);
  });

  it("counts a tile changed when 3 of its pixels differ, and settles it after the hold", () => {
    // 3 pixels of the tile at x 160, y 96 darken by 30 from 10 s on: still for 70 s at 80 s.
    const edge = PNG.sync.read(drawn(320, 160, []));
    for (const x of [163, 164, 165])
      edge.data.fill(210, (103 * 320 + x) * 4, (103 * 320 + x) * 4 + 3);
    const verdicts = watch(drawn(320, 160, []), everyFiveSeconds(5, 80), (atMs) =>
      atMs < 10_000 ? drawn(320, 160, []) : PNG.sync.write(edge),
    );
    expect(settledTimes(verdicts)).toEqual([80_000]);
    expect(verdicts.at(-1)?.[1]).toEqual({
      verdict: "settled",
      area: { x: 160, y: 96, width: 16, height: 16 },
      small: true,
    });
  });

  it("reads a frame of another size as one settled change over the whole frame", () => {
    const frames = watchFrames(drawn(320, 240, []));
    expect(frames.next(drawn(160, 120, []), 5_000)).toEqual({
      verdict: "settled",
      area: { x: 0, y: 0, width: 160, height: 120 },
      small: false,
    });
  });
});
