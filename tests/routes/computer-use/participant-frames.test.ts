import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PNG } from "pngjs";
import { afterEach, beforeEach, expect, it } from "vitest";

import type { ActorTrace, ActorTraceItem } from "../../../src/actors/contract.js";
import type { WebpTranscoder } from "../../../src/evidence/webp-transcoder.js";
import { prepareSelectedOutputDirectory } from "../../../src/run/contained-output.js";
import { participantFrames } from "../../../src/routes/computer-use/participant-frames.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "humanish-participant-frames-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

function png(): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(200);
  return PNG.sync.write(image);
}

/** A transcoder whose frames finish when the test says, or never, or fail. */
function controlled() {
  const pending: { resolve: (webp: Buffer) => void; reject: (error: Error) => void }[] = [];
  const transcoder: WebpTranscoder = {
    transcode: () => new Promise((resolve, reject) => void pending.push({ resolve, reject })),
  };
  return { transcoder, pending };
}

const shot = (id: string, framePath: string): ActorTraceItem => ({
  id,
  kind: "screenshot",
  lifecycle: "completed",
  title: id,
  screenshotRef: { path: framePath, redaction: "none" },
});

it("references each frame as PNG until the session ends, then by its WebP where one was written", async () => {
  const root = await prepareSelectedOutputDirectory(dir, "run");
  const { transcoder, pending } = controlled();
  const frames = participantFrames(root, { screenshotDir: "p01" }, { blurred: false, transcoder });
  expect(await frames.write("turn-01.png", png())).toBe("screenshots/p01/turn-01.png");
  expect(await frames.write("turn-02.png", png())).toBe("screenshots/p01/turn-02.png");
  expect(await frames.write("turn-03.png", png())).toBe("screenshots/p01/turn-03.png");
  // While the session runs, every reference names a PNG that exists.
  expect((await readdir(path.join(dir, "run", "screenshots", "p01"))).sort()).toEqual([
    "turn-01.png",
    "turn-02.png",
    "turn-03.png",
  ]);
  pending[0]!.resolve(Buffer.from("webp-1"));
  pending[1]!.reject(new Error("synthetic encode failure"));
  pending[2]!.resolve(Buffer.from("webp-3"));
  const trace = {
    items: [shot("a", "screenshots/p01/turn-01.png"), shot("b", "screenshots/p01/turn-02.png")],
  } as ActorTrace;
  const remove = await frames.finish(trace);
  expect(trace.items.map((item) => item.screenshotRef?.path)).toEqual([
    "screenshots/p01/turn-01.webp",
    "screenshots/p01/turn-02.png",
  ]);
  expect(frames.screenshots).toEqual([
    "screenshots/p01/turn-01.webp",
    "screenshots/p01/turn-02.png",
    "screenshots/p01/turn-03.webp",
  ]);
  // The PNGs stay until the trace naming the WebP is written.
  expect(await readdir(path.join(dir, "run", "screenshots", "p01"))).toHaveLength(5);
  await remove();
  expect((await readdir(path.join(dir, "run", "screenshots", "p01"))).sort()).toEqual([
    "turn-01.webp",
    "turn-02.png",
    "turn-03.webp",
  ]);
});

it("keeps a frame the worker did not take as PNG", async () => {
  const root = await prepareSelectedOutputDirectory(dir, "run");
  const frames = participantFrames(
    root,
    { screenshotDir: "" },
    { blurred: false, transcoder: { transcode: () => undefined } },
  );
  await frames.write("turn-01.png", png());
  const trace = { items: [shot("a", "screenshots/turn-01.png")] } as ActorTrace;
  await (
    await frames.finish(trace)
  )();
  expect(trace.items[0]!.screenshotRef?.path).toBe("screenshots/turn-01.png");
  expect(await readdir(path.join(dir, "run", "screenshots"))).toEqual(["turn-01.png"]);
});

it("keeps a frame still encoding when the session ends as PNG, and never writes its late WebP", async () => {
  const root = await prepareSelectedOutputDirectory(dir, "run");
  const { transcoder, pending } = controlled();
  const frames = participantFrames(
    root,
    { screenshotDir: "" },
    { blurred: false, transcoder, finishWaitMs: 10 },
  );
  await frames.write("turn-01.png", png());
  const trace = { items: [shot("a", "screenshots/turn-01.png")] } as ActorTrace;
  await (
    await frames.finish(trace)
  )();
  pending[0]!.resolve(Buffer.from("late"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(trace.items[0]!.screenshotRef?.path).toBe("screenshots/turn-01.png");
  expect(await readdir(path.join(dir, "run", "screenshots"))).toEqual(["turn-01.png"]);
});

it("keeps every frame of a study that blurs its screenshots as PNG", async () => {
  const root = await prepareSelectedOutputDirectory(dir, "run");
  const { transcoder, pending } = controlled();
  const frames = participantFrames(root, { screenshotDir: "" }, { blurred: true, transcoder });
  await frames.write("turn-01.png", png());
  expect(pending).toHaveLength(0);
  const trace = { items: [shot("a", "screenshots/turn-01.png")] } as ActorTrace;
  await (
    await frames.finish(trace)
  )();
  expect(trace.items[0]!.screenshotRef?.path).toBe("screenshots/turn-01.png");
});
