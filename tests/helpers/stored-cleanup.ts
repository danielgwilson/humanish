// A cleanup.json as `humanish cleanup` wrote it through 0.110.0. The command is gone, and verify and
// export still read the file a run kept, so tests write one directly.
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { PUBLIC_TARGET_CWD } from "../../src/run/bundle.js";
import {
  CLEANUP_SCHEMA,
  type StoredCleanupResourceResult,
  type StoredCleanupResult,
} from "../../src/run/results.js";

/** One e2b-desktop sandbox line, recorded as stopped, named by `id`. */
export function storedCleanupSandbox(id: string): StoredCleanupResourceResult {
  return {
    provider: "e2b-desktop",
    kind: "sandbox",
    id,
    status: "already_clean",
    message: "resource was already recorded as killed",
  };
}

/** Write `runDir/cleanup.json` for `runId` with these resource lines. */
export async function writeStoredCleanup(
  runDir: string,
  runId: string,
  resources: StoredCleanupResourceResult[] = [],
): Promise<string> {
  const file = path.join(runDir, "cleanup.json");
  const failed = resources.filter((resource) => resource.status === "failed").length;
  const result: StoredCleanupResult = {
    schema: CLEANUP_SCHEMA,
    ok: failed === 0,
    cwd: PUBLIC_TARGET_CWD,
    run: runId,
    runId,
    checkedAt: "2026-10-03T00:00:00.000Z",
    summary: {
      resources: resources.length,
      killed: 0,
      alreadyClean: resources.filter((resource) => resource.status === "already_clean").length,
      failed,
      skipped: resources.filter((resource) => resource.status === "skipped").length,
    },
    resources,
    adapterResults: [],
    warnings: [],
  };
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return file;
}
