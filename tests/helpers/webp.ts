import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import encode, { init } from "@jsquash/webp/encode.js";
import { PNG } from "pngjs";

declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

let ready: Promise<void> | undefined;

/** A PNG's pixels as a lossless WebP, encoded as the computer-use writer encodes frames. */
export async function pngToWebp(png: Buffer): Promise<Buffer> {
  ready ??= readFile(
    createRequire(import.meta.url).resolve("@jsquash/webp/codec/enc/webp_enc.wasm"),
  )
    .then((wasm) => WebAssembly.compile(wasm))
    .then(async (module) => void (await init(module)));
  await ready;
  const image = PNG.sync.read(png);
  const data = new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length);
  const webp = await encode(
    { data, width: image.width, height: image.height, colorSpace: "srgb" },
    { lossless: 1, exact: 1, method: 1, quality: 50 },
  );
  return Buffer.from(webp);
}
