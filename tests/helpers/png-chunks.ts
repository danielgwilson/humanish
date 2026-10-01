// Builds PNGs that carry extra chunks, for the screenshot-evidence checks. The chunks are inserted
// before IEND with a correct CRC, so a decoder accepts the file and only the chunk check sees them.
import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** `png` with one chunk of `type` inserted before IEND. */
export function withPngChunk(png: Buffer, type: string, data: Buffer): Buffer {
  const iend = png.length - 12;
  if (png.toString("latin1", iend + 4, iend + 8) !== "IEND") throw new Error("expected IEND last");
  return Buffer.concat([png.subarray(0, iend), chunk(type, data), png.subarray(iend)]);
}

/** The three PNG text chunk encodings, each holding `text` under the keyword Comment. */
export function pngTextChunk(type: "tEXt" | "zTXt" | "iTXt", text: string): Buffer {
  const keyword = Buffer.from("Comment\0", "latin1");
  switch (type) {
    case "tEXt":
      return Buffer.concat([keyword, Buffer.from(text, "latin1")]);
    case "zTXt":
      return Buffer.concat([keyword, Buffer.from([0]), deflateSync(Buffer.from(text, "latin1"))]);
    case "iTXt":
      // Uncompressed, no language tag, no translated keyword.
      return Buffer.concat([keyword, Buffer.from([0, 0, 0, 0]), Buffer.from(text, "utf8")]);
  }
}
