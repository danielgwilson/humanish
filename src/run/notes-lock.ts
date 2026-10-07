// The lock one notes.json writer holds while it reads and rewrites the file. The CLI and an Observer
// server can add notes to the same run at once, and each rewrites the whole file, so a writer that
// lost the lock without knowing would overwrite a note another writer saved.
//
// The lock is the directory .notes-lock, which only one process can create, holding owner.json:
// the writer's pid, a digest of its host name and an id for this hold. It is held until its writer
// removes it, or until a writer on the same host finds that pid gone. Age never frees it. Removing
// a gone writer's lock happens under a second directory, .notes-lock-reclaim, after the owner is
// read again, so a reclaimer cannot remove a lock another writer has just taken.

import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

import { validatePreparedRunRootIdentity, type PreparedRunArtifactPaths } from "./paths.js";
import { isNodeError, isRecord } from "./type-guards.js";

const LOCK_DIR = ".notes-lock";
const RECLAIM_DIR = ".notes-lock-reclaim";
const OWNER_FILE = "owner.json";
/** The owner record, relative to the run directory. It names a process, so it stays local. */
export const NOTES_LOCK_OWNER = `${LOCK_DIR}/${OWNER_FILE}`;
/** How long a writer waits for the lock, counting every retry and reclaim. */
const LOCK_WAIT_MS = 3000;
const FIRST_RETRY_MS = 10;
const LONGEST_RETRY_MS = 200;

/** Internal fault-injection seam for tests. */
export interface NotesLockHooks {
  /** Runs after a writer found the lock's owner gone and before it tries to remove the lock. */
  beforeReclaim?: () => Promise<void>;
}

interface LockOwner {
  id: string;
  pid: number;
  host: string;
}

interface HeldLock {
  owner: LockOwner;
  ino: bigint;
}

/** The host name as a digest: owner.json can identify this machine without naming it. */
function hostDigest(): string {
  return createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
}

function isLockOwner(value: unknown): value is LockOwner {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 64 &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.host === "string" &&
    value.host.length <= 64
  );
}

/**
 * The lock's owner and the lock directory's inode, "absent" when there is no lock, or "unknown"
 * when the lock is there without exactly one readable owner record: a writer between creating the
 * directory and recording itself, or something else. An unknown owner is never removed.
 */
async function readHeldLock(lockDir: string): Promise<HeldLock | "absent" | "unknown"> {
  let before;
  try {
    before = await lstat(lockDir, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "absent";
    return "unknown";
  }
  if (!before.isDirectory() || before.isSymbolicLink()) return "unknown";
  let handle;
  try {
    const entries = await readdir(lockDir);
    if (entries.length !== 1 || entries[0] !== OWNER_FILE) return "unknown";
    handle = await open(
      path.join(lockDir, OWNER_FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 1024) return "unknown";
    const buffer = Buffer.alloc(stats.size);
    await handle.read(buffer, 0, stats.size, 0);
    const owner: unknown = JSON.parse(buffer.toString("utf8"));
    const after = await lstat(lockDir, { bigint: true });
    return isLockOwner(owner) && after.ino === before.ino ? { owner, ino: before.ino } : "unknown";
  } catch {
    return "unknown";
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * True only when the owner ran on this host and its pid is gone. A pid on another host cannot be
 * checked, and a pid another user runs answers EPERM: both count as alive.
 */
function ownerGone(owner: LockOwner): boolean {
  if (owner.host !== hostDigest() || owner.pid === process.pid) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

/** Creates the lock and records this process as its owner, or returns null when it exists. */
async function tryCreateLock(lockDir: string): Promise<{ id: string; ino: bigint } | null> {
  try {
    await mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") return null;
    throw error;
  }
  const id = randomUUID();
  try {
    const { ino } = await lstat(lockDir, { bigint: true });
    await writeFile(
      path.join(lockDir, OWNER_FILE),
      JSON.stringify({ id, pid: process.pid, host: hostDigest() }),
      { flag: "wx", mode: 0o600 },
    );
    return { id, ino };
  } catch (error) {
    // The lock could not record its owner, so nobody could ever reclaim it: give it up now.
    await rmdir(lockDir).catch(() => undefined);
    throw error;
  }
}

/**
 * Removes the lock when it is still `seen` and its owner is still gone, holding the reclaim
 * directory so that no other reclaimer is between its own check and its removal. Removes the owner
 * record and the then-empty directory, never anything else; a lock that holds more stays.
 */
async function reclaimGoneLock(runRoot: string, lockDir: string, seen: HeldLock): Promise<boolean> {
  const reclaimDir = path.join(runRoot, RECLAIM_DIR);
  try {
    await mkdir(reclaimDir, { mode: 0o700 });
  } catch {
    return false;
  }
  try {
    const now = await readHeldLock(lockDir);
    if (
      now === "absent" ||
      now === "unknown" ||
      now.ino !== seen.ino ||
      now.owner.id !== seen.owner.id ||
      !ownerGone(now.owner)
    )
      return false;
    await unlink(path.join(lockDir, OWNER_FILE));
    await rmdir(lockDir);
    return true;
  } catch {
    return false;
  } finally {
    await rmdir(reclaimDir).catch(() => undefined);
  }
}

/** Removes the lock only while owner.json still names this hold. */
async function releaseLock(lockDir: string, held: { id: string; ino: bigint }): Promise<void> {
  const now = await readHeldLock(lockDir);
  if (now === "absent" || now === "unknown" || now.owner.id !== held.id || now.ino !== held.ino)
    return;
  await unlink(path.join(lockDir, OWNER_FILE)).catch(() => undefined);
  await rmdir(lockDir).catch(() => undefined);
}

/**
 * Runs `action` holding the run's notes lock, or returns "busy" when the lock stays held for
 * LOCK_WAIT_MS. Each failed attempt, a failed reclaim included, waits longer than the one before.
 */
export async function withNotesLock<T>(
  prepared: PreparedRunArtifactPaths,
  action: () => Promise<T>,
  hooks: NotesLockHooks = {},
): Promise<T | "busy"> {
  const lockDir = path.join(prepared.physicalRunRoot, LOCK_DIR);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let wait = FIRST_RETRY_MS;
  let held: { id: string; ino: bigint } | null = null;
  while (held === null) {
    await validatePreparedRunRootIdentity(prepared);
    held = await tryCreateLock(lockDir);
    if (held !== null) break;
    const seen = await readHeldLock(lockDir);
    if (seen !== "absent" && seen !== "unknown" && ownerGone(seen.owner)) {
      await hooks.beforeReclaim?.();
      const reclaimed = await reclaimGoneLock(prepared.physicalRunRoot, lockDir, seen);
      if (reclaimed && Date.now() < deadline) continue;
    }
    if (Date.now() >= deadline) return "busy";
    await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(wait * 2, LONGEST_RETRY_MS);
  }
  try {
    return await action();
  } finally {
    await releaseLock(lockDir, held);
  }
}
