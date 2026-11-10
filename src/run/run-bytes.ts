import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { mapWithConcurrency } from "./concurrency.js";

// A run can hold tens of thousands of frames, so its files are measured a batch at a time.
const STAT_CONCURRENCY = 32;

/** Bytes of the files under `directory`. A symbolic link counts as itself and is not followed. */
export async function directoryBytes(directory: string): Promise<number> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const sizes = await mapWithConcurrency(names, STAT_CONCURRENCY, async (name) => {
    const entryPath = path.join(directory, name);
    const stats = await lstat(entryPath).catch(() => undefined);
    if (stats === undefined) return 0;
    return stats.isDirectory() ? directoryBytes(entryPath) : stats.size;
  });
  return sizes.reduce((sum, size) => sum + size, 0);
}
