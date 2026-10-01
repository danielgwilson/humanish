// Reads files under a pinned directory. pinDirectory records the directory's device, inode and
// birth time; each read rechecks them, refuses a symlink anywhere on the path and accepts only a
// single-link regular file, so a swapped or linked path cannot redirect the read.

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isPathInside, isSafeRunIdSegment } from "../run/paths.js";

/** internal: consumed by src/observer/serve.ts */
export interface PinnedDirectory {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly physicalPath: string;
  /**
   * When set, a file opens only if this accepts its root-relative path and the opened file's own
   * stats, so a file added or changed after a check of the directory cannot be read.
   */
  readonly admitsFile?: (relativePath: string, stats: BigIntStats) => boolean;
  /** When set, a file's bytes are served only if this accepts their sha256. */
  readonly admitsContent?: (relativePath: string, sha256: string) => boolean;
}

interface PinnedFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export async function readContainedFile(
  root: PinnedDirectory,
  filePathInput: string,
): Promise<Buffer | null> {
  const opened = await openContainedFile(root, filePathInput);
  if (!opened) return null;
  try {
    const body = await opened.handle.readFile();
    // A write that landed during the read changed the file's mtime and ctime.
    if (
      root.admitsFile !== undefined &&
      !root.admitsFile(
        relativeToRoot(root, filePathInput),
        await opened.handle.stat({ bigint: true }),
      )
    ) {
      return null;
    }
    if (
      root.admitsContent !== undefined &&
      !root.admitsContent(
        relativeToRoot(root, filePathInput),
        createHash("sha256").update(body).digest("hex"),
      )
    ) {
      return null;
    }
    await assertPinnedDirectory(root);
    return body;
  } catch {
    return null;
  } finally {
    await opened.handle.close();
  }
}

export async function openContainedFile(
  root: PinnedDirectory,
  filePathInput: string,
): Promise<{ handle: FileHandle; size: number } | null> {
  const filePath = path.resolve(filePathInput);
  if (!isPathInside(root.physicalPath, filePath)) return null;
  let handle: FileHandle | null = null;
  try {
    await assertPinnedDirectory(root);
    const expectedStats = await inspectContainedRegularFile(root, filePath);
    if (!expectedStats) return null;
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedStats = await handle.stat({ bigint: true });
    if (
      !openedStats.isFile() ||
      openedStats.nlink !== 1n ||
      openedStats.dev !== expectedStats.dev ||
      openedStats.ino !== expectedStats.ino ||
      (root.admitsFile !== undefined &&
        !root.admitsFile(relativeToRoot(root, filePath), openedStats))
    ) {
      await handle.close();
      return null;
    }
    const recheckedStats = await inspectContainedRegularFile(root, filePath);
    if (
      !recheckedStats ||
      recheckedStats.dev !== expectedStats.dev ||
      recheckedStats.ino !== expectedStats.ino
    ) {
      await handle.close();
      return null;
    }
    await assertPinnedDirectory(root);
    return { handle, size: Number(openedStats.size) };
  } catch {
    if (handle) await handle.close().catch(() => undefined);
    return null;
  }
}

/** The sha256 of an opened file, read by position so the handle's own offset is untouched. */
export async function sha256OfOpenedFile(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1 << 20);
  for (let position = 0; ;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return hash.digest("hex");
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
}

/** internal: consumed by src/observer/run-routes.ts */
export function relativeToRoot(root: PinnedDirectory, filePathInput: string): string {
  return path.relative(root.physicalPath, path.resolve(filePathInput)).split(path.sep).join("/");
}

async function inspectContainedRegularFile(
  root: PinnedDirectory,
  filePath: string,
): Promise<PinnedFileIdentity | null> {
  const relative = path.relative(root.physicalPath, filePath);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = root.physicalPath;
  let fileIdentity: PinnedFileIdentity | null = null;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stats = await lstat(current, { bigint: true });
    if (stats.isSymbolicLink()) return null;
    if (index < segments.length - 1) {
      if (!stats.isDirectory()) return null;
    } else {
      if (!stats.isFile() || stats.nlink !== 1n) return null;
      fileIdentity = { dev: stats.dev, ino: stats.ino };
    }
  }

  if ((await realpath(filePath)) !== filePath) return null;
  return fileIdentity;
}

/** internal: consumed by src/observer/serve.ts */
export async function pinDirectory(directoryInput: string): Promise<PinnedDirectory> {
  const physicalPath = await realpath(path.resolve(directoryInput));
  const stats = await lstat(physicalPath, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Observer roots must be physical directories.");
  }
  return Object.freeze({
    birthtimeNs: stats.birthtimeNs,
    dev: stats.dev,
    ino: stats.ino,
    physicalPath,
  });
}

/** internal: consumed by src/observer/serve.ts */
export async function pinDirectChildDirectory(
  root: PinnedDirectory,
  name: string,
): Promise<PinnedDirectory | null> {
  if (!isSafeRunIdSegment(name)) return null;
  try {
    await assertPinnedDirectory(root);
    const candidate = path.join(root.physicalPath, name);
    const pinned = await pinDirectory(candidate);
    if (
      pinned.physicalPath !== candidate ||
      path.dirname(pinned.physicalPath) !== root.physicalPath
    ) {
      return null;
    }
    await assertPinnedDirectory(root);
    return pinned;
  } catch {
    return null;
  }
}

export async function assertPinnedDirectory(root: PinnedDirectory): Promise<void> {
  const stats = await lstat(root.physicalPath, { bigint: true });
  if (
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    stats.birthtimeNs !== root.birthtimeNs ||
    stats.dev !== root.dev ||
    stats.ino !== root.ino ||
    (await realpath(root.physicalPath)) !== root.physicalPath
  ) {
    throw new Error("Observer root identity changed.");
  }
}
