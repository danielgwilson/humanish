import { PNG } from "pngjs";
import { expect, it } from "vitest";

import { decodeWebp, webpStructure } from "../../src/evidence/webp.js";
import { webpTranscoder } from "../../src/evidence/webp-transcoder.js";

/** A frame with text-like detail and a transparent corner, so exactness shows. */
function frame(width: number, height: number): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    image.data[i * 4] = (x * 7) % 256;
    image.data[i * 4 + 1] = (y * 13) % 256;
    image.data[i * 4 + 2] = (x ^ y) % 256;
    image.data[i * 4 + 3] = x < 4 && y < 4 ? 0 : 255;
  }
  return PNG.sync.write(image);
}

it("encodes frames in its worker as lossless WebP that decodes to the same pixels", async () => {
  const pngs = [frame(320, 200), frame(64, 48), frame(1, 1)];
  const webps = await Promise.all(pngs.map((png) => webpTranscoder().transcode(png)!.webp));
  for (const [index, webp] of webps.entries()) {
    expect(webpStructure(webp).error).toBeNull();
    const decoded = await decodeWebp(webp);
    expect(decoded.data.equals(PNG.sync.read(pngs[index]!).data)).toBe(true);
  }
});

it("rejects bytes that are not a PNG and goes on encoding", async () => {
  await expect(webpTranscoder().transcode(Buffer.from("not a png"))!.webp).rejects.toThrow(/./);
  const webp = await webpTranscoder().transcode(frame(8, 8))!.webp;
  expect(webpStructure(webp).error).toBeNull();
});

it("stops waiting for an abandoned frame", async () => {
  const job = webpTranscoder().transcode(frame(64, 64))!;
  job.abandon();
  await expect(job.webp).rejects.toThrow(/abandoned/);
});

it("counts an abandoned frame's bytes against its queue until the worker answers", async () => {
  // Two 36 MB frames, stored uncompressed, are over the 64 MB queue together.
  const image = new PNG({ width: 3000, height: 3000 });
  image.data.fill(90);
  const large = PNG.sync.write(image, { deflateLevel: 0 });
  const first = webpTranscoder().transcode(large)!;
  first.abandon();
  await expect(first.webp).rejects.toThrow(/abandoned/);
  // The worker still holds the first frame, so the second one does not fit.
  expect(webpTranscoder().transcode(large)).toBeUndefined();
});
