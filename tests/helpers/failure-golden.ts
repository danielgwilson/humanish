import path from "node:path";
import { expect } from "vitest";
import { runDirSnapshot, type RunDirSnapshotOptions } from "./run-golden.js";

const FAILURES = path.resolve(import.meta.dirname, "../golden/failures");

/**
 * Pin the run directory a failed execution left behind, under `tests/golden/failures/<name>.json`.
 * Names group by route (`terminal/product-install-fails`), so one folder shows a route's failures.
 */
export async function expectFailureGolden(
  name: string,
  runDir: string,
  options: RunDirSnapshotOptions,
): Promise<void> {
  const snapshot = await runDirSnapshot(runDir, options);
  await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
    path.join(FAILURES, `${name}.json`),
  );
}
