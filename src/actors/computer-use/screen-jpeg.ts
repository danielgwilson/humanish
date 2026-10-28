// The JPEG a desktop frame goes to Claude as. The Messages API keeps no conversation, so every
// request carries each screenshot since the last compaction, and on photo-heavy pages PNG frames
// brought a request near the 32 MB limit before the server compacted at 60,000 tokens. Anthropic's
// computer-use reference sends JPEG at quality 75, the value its desktop app's encoder uses. The
// run bundle keeps the lossless frame; only the model's copy is lossy.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import encode, { init } from "@jsquash/jpeg/encode.js";
import { PNG } from "pngjs";

/**
 * Quality 75 with baseline coding and the standard quantization tables, as libjpeg writes it:
 * mozjpeg's progressive default took about twice as long for 12% fewer bytes. Chroma stays
 * subsampled 4:2:0, as in the reference.
 */
const OPTIONS = { quality: 75, progressive: false, quant_table: 0 } as const;

// Node defines WebAssembly; the ES2023 library this build types against does not.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

let ready: Promise<void> | undefined;

/** Loads the encoder from the package's own wasm file: the codec's default fetches it by URL. */
function readyEncoder(): Promise<void> {
  ready ??= readFile(
    createRequire(import.meta.url).resolve("@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm"),
  )
    .then((wasm) => WebAssembly.compile(wasm))
    .then((module) => init(module));
  return ready;
}

/** The JPEG of a PNG frame, at the frame's own size. */
export async function screenJpeg(png: Buffer): Promise<Buffer> {
  await readyEncoder();
  const image = PNG.sync.read(png);
  const data = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length);
  const jpeg = await encode(
    { data, width: image.width, height: image.height, colorSpace: "srgb" },
    OPTIONS,
  );
  return Buffer.from(jpeg);
}
