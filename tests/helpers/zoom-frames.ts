import { PNG } from "pngjs";

// Real PNG frames for tests of what a participant is handed for a zoom: a screenshot whose size
// the zoom is enlarged to fit, and a crop smaller than it.

/** A PNG of `width` x `height` in one shade. */
export function pngOfSize(width: number, height: number, shade = 90): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(shade);
  return PNG.sync.write(image);
}

/** A PNG's decoded width and height. */
export function sizeOf(png: Buffer): [number, number] {
  const image = PNG.sync.read(png);
  return [image.width, image.height];
}
