// The worker thread src/evidence/webp-transcoder.ts runs: PNG frames in, lossless WebP out, one at
// a time. It imports packages only, so Node can run this file from source with its types stripped
// as well as from dist.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";

import encode, { init } from "@jsquash/webp/encode.js";
import { PNG } from "pngjs";

// Node defines WebAssembly; the ES2023 library this build types against does not.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<object> };

interface Job {
  id: number;
  png: Uint8Array;
}

/**
 * Lossless, and `exact` keeps the color under fully transparent pixels, so decoded pixels equal the
 * PNG's. Method 1 at quality 50 measured 0.47 of the PNG bytes at about 330 ms for a 1440x950
 * frame; higher efforts saved 2% more at twice the time.
 */
const OPTIONS = { lossless: 1, exact: 1, method: 1, quality: 50 } as const;

const port = parentPort;
if (port === null) throw new Error("webp-encode-worker runs only as a worker thread.");

const ready = readFile(
  createRequire(import.meta.url).resolve("@jsquash/webp/codec/enc/webp_enc_simd.wasm"),
)
  .then((wasm) => WebAssembly.compile(wasm))
  .then(async (module) => void (await init(module)));

ready.then(
  () => port.postMessage({ ready: true }),
  (error: unknown) => port.postMessage({ ready: false, error: String(error) }),
);

port.on("message", (job: Job) => {
  void ready
    .then(async () => {
      const image = PNG.sync.read(Buffer.from(job.png.buffer, job.png.byteOffset, job.png.length));
      const data = new Uint8ClampedArray(
        image.data.buffer,
        image.data.byteOffset,
        image.data.length,
      );
      const webp = await encode(
        { data, width: image.width, height: image.height, colorSpace: "srgb" },
        OPTIONS,
      );
      port.postMessage({ id: job.id, webp: new Uint8Array(webp) }, [webp]);
    })
    .catch((error: unknown) => port.postMessage({ id: job.id, error: String(error) }));
});
