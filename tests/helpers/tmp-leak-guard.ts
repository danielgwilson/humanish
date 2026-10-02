// A vitest globalSetup. It points TMPDIR at a new empty dir for the run, and the teardown fails the
// run when a test left a humanish-* entry there. Workers start after setup and inherit TMPDIR, so every
// os.tmpdir() call in a test lands in this dir. Counting the shared temp dir instead would count
// entries from other runs on the same machine.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The prefix a test passed to mkdtemp: the name without mkdtemp's six-character suffix. */
function prefixOf(name: string): string {
  return /^(.*-)[A-Za-z0-9]{6}$/.exec(name)?.[1] ?? name;
}

/** The humanish-* entries in `dir`, counted by prefix, most first. */
export function leakedPrefixes(dir: string): [string, number][] {
  const counts = new Map<string, number>();
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("humanish-")) continue;
    const prefix = prefixOf(name);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

export default function setup(): () => void {
  const previous = process.env.TMPDIR;
  const dir = mkdtempSync(path.join(tmpdir(), "vitest-humanish-"));
  process.env.TMPDIR = dir;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    const leaked = leakedPrefixes(dir);
    rmSync(dir, { recursive: true, force: true });
    const total = leaked.reduce((sum, [, count]) => sum + count, 0);
    if (total > 0) {
      const list = leaked.map(([prefix, count]) => `${prefix}* ${count}`).join(", ");
      throw new Error(
        `Tests left ${total} humanish-* entries in the temp dir: ${list}. Remove each temp dir a test creates, for example with makeTestTempDir from tests/helpers/temp-dir.ts.`,
      );
    }
  };
}
