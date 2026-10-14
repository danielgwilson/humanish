import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * DecompressionStream("gzip") that inflates in its flush, within microtasks. Node's inflates on its
 * thread pool, so a page decoding a feed body finishes some event loop turns after a fake timer
 * fires or a mocked fetch answers, after the act() and the assertion that follow it.
 */
class MicrotaskGunzip extends TransformStream<Uint8Array, Uint8Array> {
  constructor(format: string) {
    if (format !== "gzip") throw new TypeError(`MicrotaskGunzip reads gzip, not ${format}`);
    const chunks: Uint8Array[] = [];
    super({
      transform: (chunk) => {
        chunks.push(chunk);
      },
      flush: (controller) => {
        controller.enqueue(new Uint8Array(gunzipSync(Buffer.concat(chunks))));
      },
    });
  }
}

/** Decode feed bodies within microtasks in each test of the calling file. */
export function decodeInMicrotasks(): void {
  beforeEach(() => {
    vi.stubGlobal("DecompressionStream", MicrotaskGunzip);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
