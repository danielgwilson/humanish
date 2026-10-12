import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RunBundle } from "../../src/run/bundle.js";
import { joinStreamTrace } from "../../src/run/stream-trace.js";

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
