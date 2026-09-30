import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// Numeric keys that vary between two runs of the same fixture: wall-clock measurements and the
// writing process id.
const AMBIENT_KEYS = new Set(["durationMs", "elapsedMs", "wallMs", "pid"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".log", ".yaml", ".yml", ".html", ".csv"]);

// Integers in this range are epoch milliseconds (2001 to 2286), which only a clock produces.
const isEpochMs = (value: unknown) =>
  Number.isInteger(value) && (value as number) >= 1e12 && (value as number) < 1e13;

function mask(value: unknown, keys: ReadonlySet<string>): unknown {
  if (isEpochMs(value)) return "[epoch-ms]";
  if (Array.isArray(value)) return value.map((entry) => mask(entry, keys));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        (AMBIENT_KEYS.has(key) && typeof entry === "number") || keys.has(key)
          ? `[${key}]`
          : mask(entry, keys),
      ]),
    );
  }
  return value;
}

export interface RunDirSnapshotOptions {
  /** Literals that differ per run (run id, temp cwd, local URLs) and their placeholders. */
  replace: ReadonlyArray<readonly [string, string]>;
  /** JSON keys whose values the fixture cannot hold fixed; the caller says why. */
  maskKeys?: readonly string[];
  /** NDJSON files appended by parallel work, so their line order is not deterministic. */
  unorderedFiles?: readonly string[];
}

/**
 * Every file of a run directory, with the values that differ between two runs of the same
 * deterministic fixture replaced: the given literals, ISO timestamps, epoch milliseconds, UUIDs,
 * measured durations and the caller's `maskKeys`. JSON is parsed so the snapshot diffs by field;
 * binary files are pinned by digest.
 */
export async function runDirSnapshot(
  runDir: string,
  options: RunDirSnapshotOptions,
): Promise<Record<string, unknown>> {
  const replacements = options.replace;
  const keys = new Set(options.maskKeys);
  const unordered = new Set(options.unorderedFiles);
  const replace = (text: string) => {
    let out = text;
    for (const [from, to] of replacements) out = out.split(from).join(to);
    return out
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "[ts]")
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "[uuid]");
  };
  const files = (await readdir(runDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(runDir, path.join(entry.parentPath, entry.name)))
    .sort();
  const snapshot: Record<string, unknown> = {};
  for (const file of files) {
    // The Observer page embeds the whole app build; its data is the bundle already snapshotted.
    if (file.startsWith(`observer${path.sep}`)) {
      snapshot[file] = "[observer build]";
      continue;
    }
    const bytes = await readFile(path.join(runDir, file));
    const extension = path.extname(file);
    if (extension === ".json")
      snapshot[file] = mask(JSON.parse(replace(bytes.toString("utf8"))), keys);
    else if (extension === ".ndjson") {
      const records = replace(bytes.toString("utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => mask(JSON.parse(line), keys));
      snapshot[file] = unordered.has(file)
        ? records.sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))
        : records;
    } else if (TEXT_EXTENSIONS.has(extension)) snapshot[file] = replace(bytes.toString("utf8"));
    else snapshot[file] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  return snapshot;
}
