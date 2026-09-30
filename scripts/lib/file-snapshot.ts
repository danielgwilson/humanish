// Recursive file snapshots for `pnpm codex:qualify`: each probe snapshots its private work directory
// (HOME, CODEX_HOME, the project and TMPDIR) before the app-server starts and after it exits.
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";

export interface SnapshotEntry {
  type: "file" | "dir" | "link" | "other";
  size: number;
}
export type Snapshot = Record<string, SnapshotEntry>;

/** Every entry under `root`, keyed by its path relative to `root`; symlinks are not followed. */
export function snapshot(root: string): Snapshot {
  const entries: Snapshot = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(path.join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(path.join(root, child));
      const type = stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "dir"
          : stat.isSymbolicLink()
            ? "link"
            : "other";
      entries[child] = { type, size: type === "dir" ? 0 : stat.size };
      if (type === "dir") walk(child);
    }
  };
  walk("");
  return entries;
}

export interface SnapshotDiff {
  /** `path type` for each entry that appeared. */
  added: string[];
  /** `path type` for each entry that disappeared. */
  removed: string[];
  /** `path before->after` for each entry whose type changed. */
  retyped: string[];
  /** `path before->after` for each file whose size changed (for review). */
  resized: string[];
}
export function snapshotDiff(before: Snapshot, after: Snapshot): SnapshotDiff {
  const diff: SnapshotDiff = { added: [], removed: [], retyped: [], resized: [] };
  for (const [name, entry] of Object.entries(after)) {
    const old = before[name];
    if (!old) diff.added.push(`${name} ${entry.type}`);
    else if (old.type !== entry.type) diff.retyped.push(`${name} ${old.type}->${entry.type}`);
    else if (old.size !== entry.size) diff.resized.push(`${name} ${old.size}->${entry.size}`);
  }
  for (const [name, entry] of Object.entries(before))
    if (!after[name]) diff.removed.push(`${name} ${entry.type}`);
  return diff;
}
