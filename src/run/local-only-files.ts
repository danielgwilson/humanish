// Run files that mean something only on the machine that recorded the run. sandbox-receipts.ndjson
// holds the raw sandbox ids reclaim kills by, and status.json holds the recording process's pid.
// Bundle export leaves both out of a shared copy, and the Observer servers never hand them out.

import { SANDBOX_RECEIPTS_ARTIFACT } from "./sandbox-receipts.js";
import { RUN_STATUS_FILE } from "./status.js";

/** Each local-only file, relative to the run directory, with why a shared copy omits it. */
export const LOCAL_ONLY_RUN_FILES: ReadonlyMap<string, string> = new Map([
  [RUN_STATUS_FILE, "local process status is not a new attempt"],
  [SANDBOX_RECEIPTS_ARTIFACT, "operational journal does not confer a derivative resource lease"],
]);

/**
 * Whether a run-relative posix path names a local-only file. Case is ignored, so a request that
 * spells the name differently cannot reach the file on a case-insensitive filesystem.
 */
export function isLocalOnlyRunFile(relativePath: string): boolean {
  return LOCAL_ONLY_RUN_FILES.has(relativePath.toLowerCase());
}
