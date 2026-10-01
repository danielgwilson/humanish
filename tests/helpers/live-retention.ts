import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Copy a live test project's run bundles to a retained directory, then remove the temp project.
 * A live run is the only proof of live behavior and costs real spend, so its bundle outlives the
 * test. The default root is the repo's gitignored `.humanish/live-test-runs/`;
 * `HUMANISH_LIVE_RETAIN_DIR` overrides it. A project with no runs directory is only removed.
 *
 * The project is removed only after the copy succeeds. When the copy fails (a full disk, a
 * permission error), the project is the only copy of the bundles: it is kept, its path is printed
 * and the error is rethrown.
 */
export async function retainLiveRuns(cwd: string, label: string): Promise<string | undefined> {
  const runs = path.join(cwd, ".humanish", "runs");
  const entry = await stat(runs).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!entry?.isDirectory()) {
    await rm(cwd, { recursive: true, force: true });
    return undefined;
  }
  const root =
    process.env.HUMANISH_LIVE_RETAIN_DIR ?? path.join(REPO_ROOT, ".humanish", "live-test-runs");
  const target = path.join(root, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await cp(runs, target, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `live test bundles were not retained (${reason}); the project is kept at ${cwd}\n`,
    );
    throw error;
  }
  process.stderr.write(`live test bundles retained at ${target}\n`);
  await rm(cwd, { recursive: true, force: true });
  return target;
}
