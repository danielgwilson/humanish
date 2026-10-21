// One analysis or correction writer per run: a `.analysis-lock` directory in the run, holding an
// owner record that names the process that took it (src/run/process-owner.ts). A lock whose owner
// is still running, or cannot be shown to be gone, refuses the next writer with ANALYSIS_BUSY. A
// lock whose owner is gone, as a killed analysis leaves one, passes to the next writer, which says so.

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { BigIntStats } from "node:fs";
import { readContainedRegularFile, writeContainedOutputFile } from "../run/contained-output.js";
import { validatePreparedRunRootIdentity, type PreparedRunArtifactPaths } from "../run/paths.js";
import {
  currentProcessOwner,
  processOwnerGone,
  processOwnerOf,
  type ProcessOwner,
} from "../run/process-owner.js";

const LOCK = ".analysis-lock";
const OWNER_FILE = "owner.json";
const OWNER_SCHEMA = "humanish.analysis-lock-owner.v1";
const MAX_OWNER_BYTES = 4096;

/**
 * Run `action` holding the run's analysis lock. A lock left by a process that is gone is taken
 * over, and `warn` receives a sentence saying whose it was. Throws ANALYSIS_BUSY when another live
 * owner, or an owner this process cannot check, holds it, and ANALYSIS_UNAVAILABLE when the lock
 * cannot be made.
 */
export async function withAnalysisLock<T>(
  prepared: PreparedRunArtifactPaths,
  action: () => Promise<T>,
  warn?: (message: string) => void,
): Promise<T> {
  await validatePreparedRunRootIdentity(prepared);
  const target = path.join(prepared.physicalRunRoot, LOCK);
  const identity = await acquire(prepared, target, warn);
  try {
    await validatePreparedRunRootIdentity(prepared);
    return await action();
  } finally {
    // Only remove our own unchanged directory, and only the files the lock writes into it.
    try {
      await validatePreparedRunRootIdentity(prepared);
      if (sameDirectory(await lstat(target, { bigint: true }), identity)) await removeLock(target);
    } catch {
      /* Leave ambiguous storage in place for explicit operator inspection. */
    }
  }
}

async function acquire(
  prepared: PreparedRunArtifactPaths,
  target: string,
  warn: ((message: string) => void) | undefined,
): Promise<BigIntStats> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(target, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw new Error("ANALYSIS_UNAVAILABLE");
      // One takeover per call: a second EEXIST means another writer took the lock meanwhile.
      if (attempt === 0 && (await takeOverStale(prepared, target, warn))) continue;
      throw new Error("ANALYSIS_BUSY");
    }
    const identity = await lstat(target, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink())
      throw new Error("ANALYSIS_UNAVAILABLE");
    const owner = {
      schema: OWNER_SCHEMA,
      ...currentProcessOwner(),
      createdAt: new Date().toISOString(),
    };
    try {
      await writeContainedOutputFile(
        prepared,
        `${LOCK}/${OWNER_FILE}`,
        `${JSON.stringify(owner)}\n`,
        "utf8",
      );
    } catch {
      await removeLock(target).catch(() => undefined);
      throw new Error("ANALYSIS_UNAVAILABLE");
    }
    return identity;
  }
}

/** The lock's owner, or undefined when its record is missing, refused or malformed. */
async function readOwner(prepared: PreparedRunArtifactPaths): Promise<ProcessOwner | undefined> {
  try {
    const read = await readContainedRegularFile(prepared, `${LOCK}/${OWNER_FILE}`, MAX_OWNER_BYTES);
    if (read.status !== "read") return undefined;
    const value = JSON.parse(read.bytes.toString("utf8")) as Record<string, unknown>;
    return value.schema === OWNER_SCHEMA ? processOwnerOf(value) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Move a lock whose owner is gone out of the way, so the next mkdir can take it. A lock with no
 * readable owner, as humanish 0.139.1 and earlier left one and as a lock looks between its mkdir
 * and its owner write, is never taken. The rename is atomic, so of two writers that both judged
 * the lock stale only one moves it. True when this call moved it.
 */
async function takeOverStale(
  prepared: PreparedRunArtifactPaths,
  target: string,
  warn: ((message: string) => void) | undefined,
): Promise<boolean> {
  const before = await lstat(target, { bigint: true }).catch(() => null);
  if (before === null || !before.isDirectory() || before.isSymbolicLink()) return false;
  const owner = await readOwner(prepared);
  if (owner === undefined || !processOwnerGone(owner).gone) return false;
  const aside = path.join(prepared.physicalRunRoot, `${LOCK}-stale-${randomUUID()}`);
  try {
    await rename(target, aside);
  } catch {
    return false;
  }
  if (!sameDirectory(await lstat(aside, { bigint: true }), before)) {
    // Another writer replaced the stale lock between the check and the rename, so this moved a
    // live one: put it back. If that fails, its owner finds its lock gone and leaves the moved one.
    await rename(aside, target).catch(() => undefined);
    return false;
  }
  await removeLock(aside).catch(() => undefined);
  warn?.(
    `This run's analysis lock belonged to process ${owner.pid}, which is no longer running, so this analysis took it over.`,
  );
  return true;
}

function sameDirectory(current: BigIntStats, identity: BigIntStats): boolean {
  return (
    current.isDirectory() &&
    !current.isSymbolicLink() &&
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    current.birthtimeNs === identity.birthtimeNs
  );
}

/** Remove the owner record and any write the lock's owner left half done, then the directory. */
async function removeLock(directory: string): Promise<void> {
  for (const entry of await readdir(directory)) {
    if (entry === OWNER_FILE || entry.startsWith(".humanish-write-"))
      await unlink(path.join(directory, entry));
  }
  await rmdir(directory);
}
