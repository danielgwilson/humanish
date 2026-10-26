import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { ZOOM_FIT, zoomView } from "../../../src/actors/computer-use/zoom-view.js";

// What a participant is shown for a zoom: the crop enlarged to fit the usual screenshot size with
// its aspect ratio kept, as Anthropic's computer-use toolset documents for its zoom member. The
// bundle keeps the crop at the desktop's own pixels; only the participant's copy is enlarged.

function png(width: number, height: number, pixel: (x: number, y: number) => number): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      image.data.fill(pixel(x, y), at, at + 3);
      image.data[at + 3] = 255;
    }
  return PNG.sync.write(image);
}

const size = (bytes: Buffer): [number, number] => {
  const image = PNG.sync.read(bytes);
  return [image.width, image.height];
};

describe("the image a participant is shown for a zoom", () => {
  it("fills the screenshot size along the crop's tighter side, keeping its aspect ratio", () => {
    const strip = png(220, 20, (x) => x % 256);
    expect(size(zoomView(strip, { width: 1440, height: 950 }))).toEqual([1440, 131]);
    const column = png(30, 100, (_x, y) => y);
    expect(size(zoomView(column, { width: 1440, height: 950 }))).toEqual([285, 950]);
  });

  it("fits 1280x800 when no screenshot size is given", () => {
    expect(ZOOM_FIT).toEqual({ width: 1280, height: 800 });
    expect(size(zoomView(png(64, 40, () => 9)))).toEqual([1280, 800]);
  });

  it("returns a crop that already fills the screenshot size unchanged", () => {
    const whole = png(1440, 950, (x, y) => (x + y) % 256);
    expect(zoomView(whole, { width: 1440, height: 950 })).toBe(whole);
    const wider = png(1500, 100, () => 3);
    expect(zoomView(wider, { width: 1440, height: 950 })).toBe(wider);
  });

  it("blends neighbouring pixels, so an edge becomes a ramp", () => {
    const edge = png(2, 1, (x) => (x === 0 ? 0 : 255));
    const shown = PNG.sync.read(zoomView(edge, { width: 8, height: 8 }));
    expect([shown.width, shown.height]).toEqual([8, 4]);
    const row = Array.from({ length: 8 }, (_, x) => shown.data[x * 4]!);
    expect(row).toEqual([0, 0, 32, 96, 159, 223, 255, 255]);
  });

  it("leaves a frame that is not a PNG to the caller", () => {
    expect(() => zoomView(Buffer.from("not an image"))).toThrow(/unrecognised content/);
  });
});
