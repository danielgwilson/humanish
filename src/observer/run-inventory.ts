// The files a share-safety verdict covers. Serve's --safe mode walks a run before and after
// verifying it, and serves a file only while its stat identity matches the walk verify covered.

import type { BigIntStats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import type { PinnedDirectory } from "./pinned-files.js";

/** internal: consumed by src/observer/serve.ts */
export interface RunInventory {
  /** Each entry under the run directory, keyed by its posix path relative to the run. */
  readonly entries: ReadonlyMap<string, string>;
  /** The run directory's own device, inode and birth time. */
  readonly root: string;
  /** Equal for two walks only when every entry and the run directory are unchanged. */
  readonly signature: string;
}

/**
 * Walks the run without following symlinks. Null when the run directory or its run.json is
 * missing, or the walk fails.
 */
export async function readRunInventory(runDirectory: string): Promise<RunInventory | null> {
  try {
    const rootStats = await lstat(runDirectory, { bigint: true });
    if (!rootStats.isDirectory()) return null;
    const entries = new Map<string, string>();
    const pending = [""];
    for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
      const parent = directory;
      const listed = await Promise.all(
        (await readdir(path.join(runDirectory, parent))).map(async (name) => ({
          key: parent === "" ? name : `${parent}/${name}`,
          stats: await lstat(path.join(runDirectory, parent, name), { bigint: true }),
        })),
      );
      for (const { key, stats } of listed) {
        entries.set(key, entryIdentity(stats));
        if (stats.isDirectory()) pending.push(key);
      }
    }
    if (!entries.get("run.json")?.startsWith("file:")) return null;
    const root = `${rootStats.dev}:${rootStats.ino}:${rootStats.birthtimeNs}`;
    // NUL cannot occur in a file name, so the joined form is unambiguous.
    const signature = [
      root,
      ...[...entries.keys()].sort().map((key) => key + "\0" + entries.get(key)),
    ].join("\0");
    return { entries, root, signature };
  } catch {
    return null;
  }
}

/**
 * The served run root, narrowed to the inventory: a file opens only when its path is in the
 * inventory with the same identity. Null when the pinned directory is not the one walked.
 */
export function inventoryRoot(
  pinned: PinnedDirectory,
  inventory: RunInventory,
): PinnedDirectory | null {
  if (`${pinned.dev}:${pinned.ino}:${pinned.birthtimeNs}` !== inventory.root) return null;
  return Object.freeze({
    ...pinned,
    admitsFile: (relativePath: string, stats: BigIntStats) =>
      stats.isFile() && inventory.entries.get(relativePath) === entryIdentity(stats),
  });
}

// A write changes size, mtime or ctime; a rename or replacement changes the inode or ctime.
function entryIdentity(stats: BigIntStats): string {
  const kind = stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other";
  return `${kind}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}
