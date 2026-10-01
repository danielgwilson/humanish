// The files a share-safety verdict covers. Serve's --safe mode walks and hashes a run before and
// after verifying it, and serves a file only while its stat identity and its bytes match.

import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { sha256OfOpenedFile, type PinnedDirectory } from "./pinned-files.js";

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
 * The sha256 of each regular file in the inventory. Null when a file cannot be read or no longer
 * has its inventoried identity.
 */
export async function hashRunInventory(
  runDirectory: string,
  inventory: RunInventory,
): Promise<ReadonlyMap<string, string> | null> {
  const hashes = new Map<string, string>();
  for (const [key, identity] of inventory.entries) {
    if (!identity.startsWith("file:")) continue;
    let handle: FileHandle | undefined;
    try {
      // O_NONBLOCK keeps a FIFO swapped in after the walk from blocking the open.
      handle = await open(
        path.join(runDirectory, key),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
      );
      if (entryIdentity(await handle.stat({ bigint: true })) !== identity) return null;
      hashes.set(key, await sha256OfOpenedFile(handle));
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return hashes;
}

/** internal: consumed by src/observer/serve.ts */
export interface AdmittedRun {
  readonly inventory: RunInventory;
  /** The sha256 of each regular file, equal before and after verify read the run. */
  readonly hashes: ReadonlyMap<string, string>;
  /** Drops the cached admission, so the next request verifies the run again. */
  readonly forget: () => void;
}

/**
 * The served run root, narrowed to the admitted run: a file opens only when its path is in the
 * inventory with the same identity, and its bytes are served only when their sha256 matches.
 * A store through a shared mmap changes the bytes without changing any stat field, so a hash
 * mismatch also drops the admission. Null when the pinned directory is not the one walked.
 */
export function inventoryRoot(
  pinned: PinnedDirectory,
  admitted: AdmittedRun,
): PinnedDirectory | null {
  const { inventory, hashes } = admitted;
  if (`${pinned.dev}:${pinned.ino}:${pinned.birthtimeNs}` !== inventory.root) return null;
  return Object.freeze({
    ...pinned,
    admitsFile: (relativePath: string, stats: BigIntStats) =>
      stats.isFile() && inventory.entries.get(relativePath) === entryIdentity(stats),
    admitsContent: (relativePath: string, sha256: string) => {
      if (hashes.get(relativePath) === sha256) return true;
      admitted.forget();
      return false;
    },
  });
}

// A write changes size, mtime or ctime; a rename or replacement changes the inode or ctime.
function entryIdentity(stats: BigIntStats): string {
  const kind = stats.isFile() ? "file" : stats.isDirectory() ? "dir" : "other";
  return `${kind}:${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
}
