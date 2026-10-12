// Screenshot PNGs whose structure is broken in one way each, and valid ones of every kind a
// screenshot can be, for the evidence check. Built from small synthetic images.
import { PNG } from "pngjs";
import { deflateSync, inflateSync } from "node:zlib";

import { pngChunks, pngOf } from "./png-chunks.js";

const WIDTH = 37;
const HEIGHT = 23;

function noisy(options: { colorType?: 0 | 2 | 4 | 6; bitDepth?: 8 | 16 } = {}): Buffer {
  const png = new PNG({ width: WIDTH, height: HEIGHT, ...options });
  for (let i = 0; i < png.data.length; i += 1) png.data[i] = (i * 131 + (i >> 7) * 17) % 256;
  return PNG.sync.write(png, options);
}

type Chunks = { type: string; data: Buffer }[];

const withIhdr = (png: Buffer, patch: (ihdr: Buffer) => void): Buffer =>
  pngOf(
    pngChunks(png).map((chunk) => {
      if (chunk.type !== "IHDR") return chunk;
      const data = Buffer.from(chunk.data);
      patch(data);
      return { type: "IHDR", data };
    }),
  );

const idat = (png: Buffer): Buffer =>
  Buffer.concat(
    pngChunks(png)
      .filter((chunk) => chunk.type === "IDAT")
      .map((chunk) => chunk.data),
  );

/** `png` with its IDAT data replaced by `data`, in chunks of `split` bytes. */
function withIdat(png: Buffer, data: Buffer, split = data.length): Buffer {
  const chunks: Chunks = [];
  for (const chunk of pngChunks(png)) {
    if (chunk.type !== "IDAT") chunks.push(chunk);
    else if (!chunks.some((c) => c.type === "IDAT"))
      for (let at = 0; at < data.length; at += split)
        chunks.push({ type: "IDAT", data: data.subarray(at, at + split) });
  }
  return pngOf(chunks);
}

/** `png` with one chunk of `type` before its image data. */
function withChunkBeforeIdat(png: Buffer, type: string, data: Buffer): Buffer {
  const chunks = pngChunks(png);
  const at = chunks.findIndex((chunk) => chunk.type === "IDAT");
  return pngOf([...chunks.slice(0, at), { type, data }, ...chunks.slice(at)]);
}

const flipByte = (png: Buffer, at: number): Buffer => {
  const out = Buffer.from(png);
  out[at] = out[at]! ^ 0xff;
  return out;
};

/** The offset of the CRC of the first chunk of `type`. */
function crcOffset(png: Buffer, type: string): number {
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("latin1", offset + 4, offset + 8) === type) return offset + 8 + length;
    offset += 12 + length;
  }
  throw new Error(`no ${type}`);
}

const rgb = noisy({ colorType: 2 });
const raw = inflateSync(idat(rgb));
const rowBytes = 1 + WIDTH * 3;

/** A PNG of the cases' size whose rows are `rowBytes` bytes of `fill` after filter type 0. */
function rowsPng(
  colorType: number,
  depth: number,
  rowBytes: number,
  fill: number,
  extra: { type: string; data: Buffer }[] = [],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH, 0);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = depth;
  ihdr[9] = colorType;
  const rows = Buffer.alloc(HEIGHT * (1 + rowBytes), fill);
  for (let row = 0; row < HEIGHT; row += 1) rows[row * (1 + rowBytes)] = 0;
  return pngOf([
    { type: "IHDR", data: ihdr },
    ...extra,
    { type: "IDAT", data: deflateSync(rows) },
    { type: "IEND", data: Buffer.alloc(0) },
  ]);
}

/** A palette image of `entries` colors whose pixels use index `index`. */
const palette = (entries: number, index: number, withPlte = true): Buffer =>
  rowsPng(
    3,
    8,
    WIDTH,
    index,
    withPlte ? [{ type: "PLTE", data: Buffer.alloc(entries * 3, 90) }] : [],
  );

const indexed = palette(4, 3);
/** A 1-bit grayscale image: its width is odd, so each row ends in a partly used byte. */
const bilevel = rowsPng(0, 1, Math.ceil(WIDTH / 8), 0xaa);

export const VALID_PNGS: [string, Buffer][] = [
  ["8-bit RGB", rgb],
  ["8-bit RGBA", noisy({ colorType: 6 })],
  ["8-bit grayscale", noisy({ colorType: 0 })],
  ["8-bit grayscale with alpha", noisy({ colorType: 4 })],
  ["16-bit RGBA", noisy({ colorType: 6, bitDepth: 16 })],
  ["a palette image", indexed],
  ["image data split across IDAT chunks", withIdat(rgb, idat(rgb), 100)],
  ["1-bit grayscale of an odd width", bilevel],
  ["16-bit RGB", noisy({ colorType: 2, bitDepth: 16 })],
  ["16-bit grayscale", noisy({ colorType: 0, bitDepth: 16 })],
];

export const BROKEN_PNGS: [string, Buffer][] = [
  ["an IHDR whose CRC does not match", flipByte(rgb, crcOffset(rgb, "IHDR"))],
  ["an IDAT whose CRC does not match", flipByte(rgb, crcOffset(rgb, "IDAT"))],
  ["an IEND whose CRC does not match", flipByte(rgb, crcOffset(rgb, "IEND"))],
  ["a zlib stream cut short", withIdat(rgb, idat(rgb).subarray(0, -6))],
  ["a row fewer than IHDR declares", withIhdr(rgb, (d) => d.writeUInt32BE(HEIGHT + 1, 4))],
  ["a row more than IHDR declares", withIhdr(rgb, (d) => d.writeUInt32BE(HEIGHT - 1, 4))],
  [
    "a row whose filter type is not 0 to 4",
    withIdat(rgb, deflateSync(Buffer.from(raw).fill(5, rowBytes * 4, rowBytes * 4 + 1))),
  ],
  ["a bit depth the color type does not allow", withIhdr(rgb, (d) => (d[8] = 3))],
  ["a color type PNG does not define", withIhdr(rgb, (d) => (d[9] = 5))],
  ["a compression method other than 0", withIhdr(rgb, (d) => (d[10] = 1))],
  ["a filter method other than 0", withIhdr(rgb, (d) => (d[11] = 1))],
  ["a palette image without PLTE", palette(4, 3, false)],
  ["no IDAT", pngOf(pngChunks(rgb).filter((chunk) => chunk.type !== "IDAT"))],
  ["no IEND", pngOf(pngChunks(rgb).filter((chunk) => chunk.type !== "IEND"))],
  ["bytes after IEND", Buffer.concat([rgb, Buffer.from("trailing note")])],
  [
    "IDAT chunks with another chunk between them",
    (() => {
      const split = pngChunks(withIdat(rgb, idat(rgb), 100));
      const at = split.findIndex((chunk) => chunk.type === "IDAT") + 1;
      return pngOf([
        ...split.slice(0, at),
        { type: "gAMA", data: Buffer.from([0, 0, 0xb1, 0x8f]) },
        ...split.slice(at),
      ]);
    })(),
  ],
  [
    "PLTE after the image data",
    (() => {
      const chunks = pngChunks(palette(4, 3));
      const plte = chunks.find((chunk) => chunk.type === "PLTE")!;
      const rest = chunks.filter((chunk) => chunk !== plte);
      return pngOf([...rest.slice(0, -1), plte, rest.at(-1)!]);
    })(),
  ],
  [
    "a second IHDR",
    (() => {
      const chunks = pngChunks(rgb);
      return pngOf([chunks[0]!, chunks[0]!, ...chunks.slice(1)]);
    })(),
  ],
  ["a palette index past the palette", palette(4, 9)],
  ["bytes after the zlib stream", withIdat(rgb, Buffer.concat([idat(rgb), Buffer.from("note")]))],
  ["a gAMA shorter than 4 bytes", withChunkBeforeIdat(rgb, "gAMA", Buffer.alloc(3))],
  ["a tRNS shorter than an RGB color", withChunkBeforeIdat(rgb, "tRNS", Buffer.alloc(5))],
  [
    "a zlib header that names no deflate stream",
    withIdat(rgb, Buffer.concat([Buffer.from([0x79, 0x9c]), idat(rgb).subarray(2)])),
  ],
  [
    "a zlib stream that needs a preset dictionary",
    withIdat(rgb, Buffer.concat([Buffer.from([0x78, 0xbb]), idat(rgb).subarray(2)])),
  ],
  ["a palette image's zlib stream cut short", withIdat(indexed, idat(indexed).subarray(0, -6))],
  [
    "a palette image with bytes after the zlib stream",
    withIdat(indexed, Buffer.concat([idat(indexed), Buffer.from("note")])),
  ],
  ["a palette image a row short", withIhdr(indexed, (d) => d.writeUInt32BE(HEIGHT + 1, 4))],
  ["a 1-bit image a row short", withIhdr(bilevel, (d) => d.writeUInt32BE(HEIGHT + 1, 4))],
];
