// Run files that mean something only on the machine that recorded the run. sandbox-receipts.ndjson
// holds the raw sandbox ids reclaim kills by, status.json holds the recording process's pid, and a
// notes lock's owner.json holds the pid of the process adding a note.
// Bundle export leaves both out of a shared copy, and the Observer servers never hand them out.

import { lstat } from "node:fs/promises";
import path from "node:path";

import { NOTES_LOCK_OWNER } from "./notes-lock.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "./sandbox-receipts.js";
import { RUN_STATUS_FILE } from "./status.js";

/** Each local-only file, relative to the run directory, with why a shared copy omits it. */
export const LOCAL_ONLY_RUN_FILES: ReadonlyMap<string, string> = new Map([
  [RUN_STATUS_FILE, "local process status is not a new attempt"],
  [SANDBOX_RECEIPTS_ARTIFACT, "operational journal does not confer a derivative resource lease"],
  [NOTES_LOCK_OWNER, "a notes writer's lock names a process on this machine"],
]);

/**
 * Whether a run-relative posix path names a local-only file. Case is ignored, so a request that
 * spells the name differently cannot reach the file on a case-insensitive filesystem.
 */
export function isLocalOnlyRunFile(relativePath: string): boolean {
  return LOCAL_ONLY_RUN_FILES.has(relativePath.toLowerCase());
}

/**
 * Whether `filePath` is one of the local-only files of the run at `runRoot` under another
 * spelling: the same device and inode. A case-insensitive filesystem also folds Unicode, so a name
 * check alone cannot rule every spelling out.
 */
export async function isLocalOnlyRunFileIdentity(
  runRoot: string,
  filePath: string,
): Promise<boolean> {
  const requested = await lstat(filePath, { bigint: true }).catch(() => null);
  if (requested === null) return false;
  for (const name of LOCAL_ONLY_RUN_FILES.keys()) {
    const local = await lstat(path.join(runRoot, name), { bigint: true }).catch(() => null);
    if (local !== null && local.dev === requested.dev && local.ino === requested.ino) return true;
  }
  return false;
}
