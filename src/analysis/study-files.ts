import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { isPathInside, validatePreparedRunRootIdentity } from "../run/paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  type PreparedOutputRoot,
} from "../run/selected-output-paths.js";

// Reading a file from a retained run directory for analysis: the path must be a plain relative path
// inside the run, the file a single-link regular file that stays inside it, and the read bounded.
// Evidence capture, analysis jobs, the analysis store, cost reading and export all read through here.

/**
 * Analysis inputs are retained local artifacts, never URLs or caller-selected outputs. The path is
 * percent-decoded up to five times, and each round must still be a plain relative path, so an
 * encoded `..` or separator cannot survive into a later decode.
 */
export function isStudyEvidencePath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  try {
    encodeURIComponent(value);
  } catch {
    return false;
  }
  let checked = value;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (
      /[\\:\x00-\x1f\x7f]/.test(checked) ||
      checked.startsWith("/") ||
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
      const final = await lstat(candidate, { bigint: true });
      if (
        !final.isFile() ||
        final.isSymbolicLink() ||
        final.nlink !== 1n ||
        final.dev !== before.dev ||
        final.ino !== before.ino ||
        final.size !== before.size ||
        final.mtimeNs !== before.mtimeNs ||
        final.ctimeNs !== before.ctimeNs
      )
        return unavailable;
      return { state: "limit", size: before.size };
    }
    // O_NONBLOCK avoids hanging if a regular leaf is raced into a special file.
    const handle = await open(
      candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat({ bigint: true });
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.mtimeNs !== before.mtimeNs
      )
        return unavailable;
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
      const after = await handle.stat({ bigint: true });
      if (
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        after.nlink !== 1n ||
        total !== Number(before.size)
      )
        return unavailable;
      if ((await validateRoot()) !== physicalRoot) return unavailable;
      await validateParents();
      const final = await lstat(candidate, { bigint: true });
      if (
        !final.isFile() ||
        final.isSymbolicLink() ||
        final.dev !== before.dev ||
        final.ino !== before.ino ||
        final.nlink !== 1n ||
        final.size !== before.size ||
        final.mtimeNs !== before.mtimeNs
      )
        return unavailable;
      return { state: "read", bytes: Buffer.concat(chunks, total) };
    } finally {
      await handle.close();
    }
  } catch {
    return unavailable;
  }
}
