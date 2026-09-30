import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { isPathInside, validatePreparedRunRootIdentity } from "./paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  type PreparedOutputRoot,
} from "./selected-output-paths.js";
import { isNodeError } from "./primitives.js";

// Reading a file from a retained run directory for analysis: the path must be a plain relative path
// inside the run, the file a single-link regular file that stays inside it, and the read bounded.
// Evidence capture, analysis jobs, the analysis store, cost reading and export all read through here.

/**
 * Analysis inputs are retained local artifacts, never URLs or caller-selected outputs. The path is
 * percent-decoded up to five times, and each round must still be a plain relative path, so an
 * encoded `..` or separator cannot survive into a later decode.
 */
export function isStudyEvidencePath(value: string): boolean {
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
export async function readBoundedStudyFile(
  root: PreparedOutputRoot,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const result = await readBoundedStudyFileResult(root, relativePath, maxBytes);
  return result.state === "read" ? result.bytes : null;
}

/**
 * Still the same single-link regular file, unchanged since `before`. Every recheck uses this one
 * field set; ctime catches a chmod or link change that leaves size and mtime alone.
 */
function sameFile(before: BigIntStats, current: BigIntStats): boolean {
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

export type BoundedStudyFileResult =
  | { state: "read"; bytes: Buffer }
  | { state: "limit"; size: bigint }
  | { state: "unavailable" };
const unavailable = { state: "unavailable" } as const;

/** Size refusals are distinguished only after the same contained regular-file checks. */
export async function readBoundedStudyFileResult(
  root: PreparedOutputRoot,
  relativePath: string,
  maxBytes: number,
): Promise<BoundedStudyFileResult> {
  if (!isStudyEvidencePath(relativePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    return unavailable;
  const validateRoot = async (): Promise<string> => {
    if ("physicalRunRoot" in root) {
      await validatePreparedRunRootIdentity(root);
      return root.physicalRunRoot;
    }
    await assertPreparedSelectedOutputDirectory(root);
    return root.physicalPath;
  };
  try {
    const physicalRoot = await validateRoot();
    const candidate = path.join(physicalRoot, relativePath);
    if (!isPathInside(physicalRoot, candidate) || candidate === physicalRoot) return unavailable;
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
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) return unavailable;
    if ((await realpath(candidate)) !== candidate) return unavailable;
    if (before.size > BigInt(maxBytes)) {
      if ((await validateRoot()) !== physicalRoot) return unavailable;
      await validateParents();
      if (!sameFile(before, await lstat(candidate, { bigint: true }))) return unavailable;
      return { state: "limit", size: before.size };
    }
    // O_NONBLOCK avoids hanging if a regular leaf is raced into a special file.
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!sameFile(before, await handle.stat({ bigint: true }))) return unavailable;
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= maxBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) return unavailable;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (!sameFile(before, await handle.stat({ bigint: true })) || total !== Number(before.size))
        return unavailable;
      if ((await validateRoot()) !== physicalRoot) return unavailable;
      await validateParents();
      if (!sameFile(before, await lstat(candidate, { bigint: true }))) return unavailable;
      return { state: "read", bytes: Buffer.concat(chunks, total) };
    } finally {
      await handle.close();
    }
  } catch {
    return unavailable;
  }
}
