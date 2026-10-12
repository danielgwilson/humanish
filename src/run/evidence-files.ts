import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { isPathInside, validatePreparedRunRootIdentity } from "./paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  isSafeRelativeFilePath,
  readOpenedAtMost,
  type PreparedOutputRoot,
} from "./contained-output.js";
import { isNodeError } from "./type-guards.js";

// Reading a file from a retained run directory for analysis: the path must be a plain relative path
// inside the run, the file a single-link regular file that stays inside it, and the read bounded.
// Evidence capture, analysis jobs, the analysis store, cost reading, verify and export all read
// through here.

/**
 * Analysis inputs are retained local artifacts, never URLs or caller-selected outputs. The path is
 * percent-decoded up to five times, and each round must still be a plain relative path, so an
 * encoded `..` or separator cannot survive into a later decode.
 */
export function isEvidencePath(value: string): boolean {
  return decodesToPlainRelativePath(value, 1024, /[\\:\x00-\x1f\x7f]|^\//);
}

/**
 * True when `value` (at most `maxLength` characters) stays a plain relative path through up to five
 * rounds of percent-decoding: no round may match `unsafe`, have an empty, `.` or `..` segment, or
 * change the segment count. A value that stops decoding is accepted once it has no escapes left.
 */
export function decodesToPlainRelativePath(
  value: string,
  maxLength: number,
  unsafe: RegExp,
): boolean {
  if (!value || value.length > maxLength) return false;
  try {
    encodeURIComponent(value);
  } catch {
    return false;
  }
  let checked = value;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (
      unsafe.test(checked) ||
      checked.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      return false;
    let decoded: string;
    try {
      decoded = decodeURIComponent(checked);
    } catch {
      return !/%[0-9a-f]{2}/i.test(checked);
    }
    if (decoded === checked) return true;
    if (decoded.split("/").length !== checked.split("/").length) return false;
    checked = decoded;
  }
  return false;
}

/**
 * Bounded companion to readContainedRegularFile. A growing or swapped file must
 * not turn an analysis budget into an unbounded read. No returned bytes have
 * authority to select another file or initiate a network request.
 */
export async function readBoundedFile(
  root: PreparedOutputRoot,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const result = await readBoundedFileResult(root, relativePath, maxBytes);
  return result.state === "read" ? result.bytes : null;
}

/** The fields of a file's lstat that sameFile compares: which file it is, its size and times. */
export type FileStamp = Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">;

/**
 * Still the same single-link regular file, unchanged since `before`. Every recheck uses this one
 * field set; ctime catches a chmod or link change that leaves size and mtime alone.
 */
function sameFile(before: FileStamp, current: BigIntStats): boolean {
  return (
    current.isFile() &&
    !current.isSymbolicLink() &&
    current.nlink === 1n &&
    current.dev === before.dev &&
    current.ino === before.ino &&
    current.size === before.size &&
    current.mtimeNs === before.mtimeNs &&
    current.ctimeNs === before.ctimeNs
  );
}

/**
 * After a bounded read returned nothing: true when the file is absent, false when something is
 * there that could not be read. Errors other than ENOENT propagate.
 */
export async function pathMissing(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return false;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
}

export type BoundedFileResult =
  | { state: "read"; bytes: Buffer; stamp: FileStamp }
  | { state: "limit"; size: bigint }
  | { state: "unavailable" };
const unavailable = { state: "unavailable" } as const;

/** readUnchangedFile for an analysis input, whose path must also be an evidence path. */
export async function readBoundedFileResult(
  root: PreparedOutputRoot,
  relativePath: string,
  maxBytes: number,
): Promise<BoundedFileResult> {
  return isEvidencePath(relativePath)
    ? readUnchangedFile(root, relativePath, maxBytes)
    : unavailable;
}

/**
 * At most `maxBytes` of a contained single-link regular file that stays the same file, with the
 * same size and times, from the first check to the last. Size refusals are distinguished only after
 * the same checks. `relativePath` uses `/`, and any name a contained read accepts
 * (isSafeRelativeFilePath) is read: verify and export read the names they always did. A read
 * returns the stamp it held the file to.
 */
export async function readUnchangedFile(
  root: PreparedOutputRoot,
  relativePath: string,
  maxBytes: number,
): Promise<BoundedFileResult> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return unavailable;
  try {
    const located = await locateContainedFile(root, relativePath);
    if (located === null) return unavailable;
    const { candidate, before, stillSameFile } = located;
    if (before.size > BigInt(maxBytes)) {
      if (!(await stillSameFile(before))) return unavailable;
      return { state: "limit", size: before.size };
    }
    // O_NONBLOCK avoids hanging if a regular leaf is raced into a special file.
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) return unavailable;
      const bytes = await readOpenedAtMost(handle, maxBytes);
      if (
        bytes === null ||
        !sameFile(before, await handle.stat({ bigint: true })) ||
        bytes.length !== Number(before.size)
      )
        return unavailable;
      if (!(await stillSameFile(before))) return unavailable;
      const { dev, ino, size, mtimeNs, ctimeNs } = before;
      return { state: "read", bytes, stamp: { dev, ino, size, mtimeNs, ctimeNs } };
    } finally {
      await handle.close();
    }
  } catch {
    return unavailable;
  }
}

/**
 * True when the file readUnchangedFile would read at `relativePath` is still the file `stamp`
 * describes: it passes the same root, parent and leaf checks, before and after its lstat matches
 * the stamp. Opens nothing.
 */
export async function isUnchangedFile(
  root: PreparedOutputRoot,
  relativePath: string,
  stamp: FileStamp,
): Promise<boolean> {
  try {
    const located = await locateContainedFile(root, relativePath);
    return (
      located !== null && sameFile(stamp, located.before) && (await located.stillSameFile(stamp))
    );
  } catch {
    return false;
  }
}

/**
 * The contained single-link regular file at `relativePath`: its path, its lstat, and a recheck that
 * the root, its parents and the leaf are unchanged since. Null for a path or leaf a read refuses;
 * a root or parent that fails its check throws.
 */
async function locateContainedFile(
  root: PreparedOutputRoot,
  relativePath: string,
): Promise<{
  candidate: string;
  before: BigIntStats;
  stillSameFile: (stamp: FileStamp) => Promise<boolean>;
} | null> {
  if (!isSafeRelativeFilePath(relativePath) || relativePath.includes("\\")) return null;
  const validateRoot = async (): Promise<string> => {
    if ("physicalRunRoot" in root) {
      await validatePreparedRunRootIdentity(root);
      return root.physicalRunRoot;
    }
    await assertPreparedSelectedOutputDirectory(root);
    return root.physicalPath;
  };
  const physicalRoot = await validateRoot();
  const candidate = path.join(physicalRoot, relativePath);
  if (!isPathInside(physicalRoot, candidate) || candidate === physicalRoot) return null;
  const validateParents = async (): Promise<void> => {
    let current = physicalRoot;
    for (const segment of relativePath.split("/").slice(0, -1)) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Unsafe analysis input directory.");
    }
  };
  await validateParents();
  const before = await lstat(candidate, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) return null;
  if ((await realpath(candidate)) !== candidate) return null;
  return {
    candidate,
    before,
    stillSameFile: async (stamp) => {
      if ((await validateRoot()) !== physicalRoot) return false;
      await validateParents();
      return sameFile(stamp, await lstat(candidate, { bigint: true }));
    },
  };
}
