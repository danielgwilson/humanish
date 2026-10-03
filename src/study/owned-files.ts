// File operations for humanish migrate that never replace or delete a file the run did not create.
// A new name is taken with an exclusive create or link(), which fail when the name is in use. A
// file is removed by renaming it to a random name first and checking it there, so a file saved over
// the name in the meantime keeps it.

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { isNodeError } from "../run/type-guards.js";

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly sha256: string;
}

export interface DirectoryIdentity {
  readonly physicalPath: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface Inode {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * A file this run creates. `inode` is set the moment the exclusive create succeeds, so a name that
 * was already taken is never treated as this run's. `identity` is set once the bytes are written
 * and read back through the same descriptor.
 */
export interface OwnedFile {
  readonly path: string;
  inode?: Inode | undefined;
  identity?: FileIdentity | undefined;
}

export type LinkFile = (from: string, to: string) => Promise<void>;

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A source must be a single-link regular file. A file this run wrote may briefly have two links
// while a move is committed, so `ours` relaxes that.
export async function fileIdentity(absolutePath: string, ours = false): Promise<FileIdentity> {
  const stats = await lstat(absolutePath, { bigint: true });
  if (!stats.isFile() || (!ours && stats.nlink !== 1n))
    throw new Error("not a single-link regular file");
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    sha256: sha256(await readFile(absolutePath)),
  };
}

export function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.sha256 === right.sha256
  );
}

// Walk a directory below the project root one segment at a time, refusing a symbolic link or a
// non-directory. `create` makes missing segments and records each one it made.
export async function bindDirectory(
  root: string,
  relativeDir: string,
  created?: string[],
): Promise<DirectoryIdentity | undefined> {
  let current = root;
  for (const segment of relativeDir.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (!(isNodeError(error) && error.code === "ENOENT") || created === undefined) {
        if (isNodeError(error) && error.code === "ENOENT") return undefined;
        throw error;
      }
      await mkdir(current, { mode: 0o755 });
      created.push(current);
      stats = await lstat(current, { bigint: true });
    }
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error(`${path.relative(root, current)} is not a plain directory`);
  }
  const stats = await lstat(current, { bigint: true });
  return { physicalPath: current, dev: stats.dev, ino: stats.ino };
}

export async function assertDirectory(directory: DirectoryIdentity, root: string): Promise<void> {
  const again = await bindDirectory(root, path.relative(root, directory.physicalPath));
  if (again === undefined || again.dev !== directory.dev || again.ino !== directory.ino)
    throw new Error(`${path.relative(root, directory.physicalPath)} changed`);
}

export async function exists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    return true;
  }
}

// Create a file exclusively and write it. Its inode is recorded the moment the create succeeds, so
// a failed write is still known to be this run's and a taken name never is. The bytes are read back
// through the same descriptor, so the identity recorded is this file's, whatever holds the name.
export async function writeOwned(
  owned: OwnedFile,
  bytes: Buffer | string,
  mode: number,
): Promise<void> {
  const data = Buffer.from(bytes);
  const handle = await open(
    owned.path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    mode,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    owned.inode = { dev: opened.dev, ino: opened.ino };
    await handle.writeFile(data);
    await handle.sync();
    const stats = await handle.stat({ bigint: true });
    const back = Buffer.alloc(Number(stats.size));
    await handle.read(back, 0, back.length, 0);
    owned.identity = { dev: stats.dev, ino: stats.ino, size: stats.size, sha256: sha256(back) };
  } finally {
    await handle.close();
  }
  if (owned.identity.sha256 !== sha256(data))
    throw new Error(`${path.basename(owned.path)} did not read back as written`);
}

// Remove the file at `file` only if `matches` says it is the expected one. The name is first renamed
// to a random one and the file checked there, so a file saved over the name in between is never
// deleted: it gets its name back, or keeps the random one. Returns the path kept, or undefined once
// the file is removed or was already gone.
export async function removeChecked(
  file: string,
  matches: (current: FileIdentity) => boolean,
  linkFile: LinkFile,
): Promise<string | undefined> {
  const aside = `${file}.migrate-${randomUUID()}.del`;
  try {
    await rename(file, aside);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  const current = await fileIdentity(aside, true).catch(() => undefined);
  if (current !== undefined && matches(current)) {
    await unlink(aside);
    return undefined;
  }
  return (await restoreName(aside, file, linkFile)) ? file : aside;
}

// Remove a file this run created if it still holds this run's bytes, or was cut short while being
// written. Returns the path kept, if any.
export async function removeOwned(
  owned: OwnedFile,
  linkFile: LinkFile,
): Promise<string | undefined> {
  const inode = owned.inode;
  if (inode === undefined) return undefined;
  return removeChecked(
    owned.path,
    (current) =>
      current.dev === inode.dev &&
      current.ino === inode.ino &&
      (owned.identity === undefined || sameFile(current, owned.identity)),
    linkFile,
  );
}

// Hard links need filesystem support. Without it a file is created exclusively and read back.
export const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV"]);

// Give the file at `from` the name `to` without replacing anything there: link() fails on a taken
// name, and so does the exclusive create a filesystem without hard links gets instead. True once
// `to` holds the file and `from` is gone. False when `to` was taken, or was replaced before `from`
// could go, which leaves `from` as the file's only name.
export async function restoreName(from: string, to: string, linkFile: LinkFile): Promise<boolean> {
  let placed: Inode;
  let copied: FileIdentity | undefined;
  let owned: OwnedFile | undefined;
  try {
    await linkFile(from, to);
    const stats = await lstat(from, { bigint: true });
    placed = { dev: stats.dev, ino: stats.ino };
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return false;
    if (!(isNodeError(error) && NO_HARD_LINKS.has(error.code ?? ""))) throw error;
    // Without hard links the file is copied. What was copied is recorded, so an edit made to
    // `from` during the copy keeps `from`.
    const stats = await lstat(from, { bigint: true });
    // Only a regular file is copied; anything else keeps the name it has.
    if (!stats.isFile()) return false;
    const bytes = await readFile(from);
    copied = { dev: stats.dev, ino: stats.ino, size: BigInt(bytes.length), sha256: sha256(bytes) };
    const copy: OwnedFile = { path: to };
    try {
      await writeOwned(copy, bytes, Number(stats.mode & 0o777n));
    } catch (copyError) {
      if (copy.inode === undefined && isNodeError(copyError) && copyError.code === "EEXIST")
        return false;
      if (copy.inode !== undefined) await removeOwned(copy, linkFile).catch(() => undefined);
      throw copyError;
    }
    placed = copy.inode!;
    owned = copy;
  }
  const now = await lstat(to, { bigint: true }).catch(() => undefined);
  if (now === undefined || now.dev !== placed.dev || now.ino !== placed.ino) return false;
  if (copied === undefined) {
    await unlink(from);
    return true;
  }
  const expected = copied;
  if ((await removeChecked(from, (current) => sameFile(current, expected), linkFile)) === undefined)
    return true;
  // `from` changed during the copy: it stays, and the stale copy goes.
  await removeOwned(owned!, linkFile).catch(() => undefined);
  return false;
}
