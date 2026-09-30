import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Copy a live test project's run bundles to a retained directory, then remove the temp project.
 * A live run is the only proof of live behavior and costs real spend, so its bundle outlives the
 * test. The default root is the repo's gitignored `.humanish/live-test-runs/`;
 * `HUMANISH_LIVE_RETAIN_DIR` overrides it. A project with no runs directory is only removed.
 */
export async function retainLiveRuns(cwd: string, label: string): Promise<string | undefined> {
  const runs = path.join(cwd, ".humanish", "runs");
  try {
    const found = await stat(runs).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    if (!found) return undefined;
    const root =
      process.env.HUMANISH_LIVE_RETAIN_DIR ?? path.join(REPO_ROOT, ".humanish", "live-test-runs");
    const target = path.join(root, `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await cp(runs, target, { recursive: true, errorOnExist: true, force: false });
    process.stderr.write(`live test bundles retained at ${target}\n`);
    return target;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
