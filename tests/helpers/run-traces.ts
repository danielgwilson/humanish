import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RunBundle } from "../../src/run/bundle.js";
import { joinStreamTrace, splitStreamTraces } from "../../src/run/stream-trace.js";

/**
 * run.json from a run folder with each stream's trace file joined by the production loader, so a
 * test reads the items and screenshot entries a v1 run.json held inline.
 */
export async function readRunWithTraces(runDir: string): Promise<RunBundle> {
  const stored = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
  const streams: RunBundle["streams"] = [];
  for (const stream of stored.streams)
    streams.push(
      stream.trace === undefined
        ? stream
        : joinStreamTrace(stream, await readFile(path.join(runDir, stream.trace.path))),
    );
  return { ...stored, streams };
}

/**
 * Write a bundle into a run folder as the run writer does: each trace file through the
 * production splitter, then run.json v2.
 */
export async function writeRunBundle(runDir: string, bundle: RunBundle): Promise<RunBundle> {
  const split = splitStreamTraces(bundle);
  for (const file of split.files) {
    await mkdir(path.dirname(path.join(runDir, file.path)), { recursive: true });
    await writeFile(path.join(runDir, file.path), file.bytes);
  }
  await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(split.bundle, null, 2)}\n`);
  return split.bundle;
}
