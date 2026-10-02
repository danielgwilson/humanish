// A dry run relabelled live, for tests of commands that refuse a dry run: feedback drafts and
// analysis. No provider runs; the evidence stays the dry run's synthetic bundle.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runDryRun } from "../../src/run/dry-run.js";

/** Writes a dry-run bundle under `runId`, then sets its mode to live. */
export async function runSyntheticLive(
  options: Parameters<typeof runDryRun>[0] & { runId: string },
): Promise<Awaited<ReturnType<typeof runDryRun>>> {
  const result = await runDryRun(options);
  await markRunLive(options.cwd, options.runId);
  return result;
}

/** Sets an existing run's run.json mode to live. */
export async function markRunLive(cwd: string, runId: string): Promise<void> {
  const file = path.join(cwd, ".humanish", "runs", runId, "run.json");
  const bundle = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  bundle.mode = "live";
  await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
}
