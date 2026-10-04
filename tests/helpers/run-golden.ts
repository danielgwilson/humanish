import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { vi } from "vitest";

import { dedupeProjections, inflateProjections } from "./run-golden-projections.js";

// Numeric keys that vary between two runs of the same fixture: wall-clock measurements and the
// writing process id.
const AMBIENT_KEYS = new Set(["durationMs", "elapsedMs", "wallMs", "pid"]);
// `runKey`, an owner tag, digests the run directory's inode, which differs for each temp directory.
const AMBIENT_TEXT_KEYS = new Set(["runKey"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".log", ".yaml", ".yml", ".html", ".csv"]);
// The Observer page embeds the whole app build, which changes with every Observer edit. Its data
// files sit next to it and are snapshotted like any other JSON.
const OBSERVER_PAGE = path.join("observer", "index.html");

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
        (AMBIENT_KEYS.has(key) && typeof entry === "number") ||
        AMBIENT_TEXT_KEYS.has(key) ||
        keys.has(key)
          ? `[${key}]`
          : mask(entry, keys),
      ]),
    );
  }
  return value;
}

export interface RunDirSnapshotOptions {
  /**
   * The value the route returned for this run. The CLI prints it under `--json` after adding the
   * analysis envelope (`runOk`, overall `ok`); the snapshot holds the route's value without it.
   * It is serialized with JSON.stringify and normalized like the bundle files.
   */
  result: unknown;
  /** Literals that differ per run (run id, temp cwd, local URLs) and their placeholders. */
  replace: ReadonlyArray<readonly [string, string]>;
  /** JSON keys whose values the fixture cannot hold fixed; the caller says why. */
  maskKeys?: readonly string[];
  /** NDJSON files appended by parallel work, so their line order is not deterministic. */
  unorderedFiles?: readonly string[];
  /** What the run wrote to stderr, from `captureStderr`; snapshotted under `<stderr>` by line. */
  stderr?: string;
  /** Parallel participants interleave their progress lines, so their stderr order is not
   *  deterministic. */
  unorderedStderr?: boolean;
}

/**
 * Collect what the code under test writes to process.stderr, instead of printing it, until `stop`.
 * Routes report subject phases and warnings there, and the CLI passes it through unchanged.
 */
export function captureStderr(): { stop(): void; text(): string } {
  let text = "";
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
    chunk: string | Uint8Array,
    ...rest: unknown[]
  ) => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    const callback = rest.find((argument) => typeof argument === "function");
    if (callback) (callback as () => void)();
    return true;
  }) as typeof process.stderr.write);
  return { stop: () => spy.mockRestore(), text: () => text };
}

// The test process builds the Observer artifact once, on whichever run needs it first, so the
// notice depends on test order rather than on the run.
const OBSERVER_BUILD_NOTICE = "observer: building the Observer artifact";

/**
 * The route's returned result under `<result>`, its stderr lines under `<stderr>` when given, the
 * runs-root `latest.json` pointer under `../latest.json`, and every file of a run directory, with
 * the values that differ between two runs of the same deterministic fixture replaced: the given
 * literals, ISO timestamps, epoch milliseconds, UUIDs, measured durations and the caller's
 * `maskKeys`. JSON is parsed so the snapshot diffs by field; binary files are pinned by digest.
 * A copy of the bundle that equals its source is pinned as a marker (run-golden-projections.ts).
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
  const normalizeJson = (text: string) => mask(JSON.parse(replace(text)), keys);
  const snapshot: Record<string, unknown> = {
    "<result>": normalizeJson(JSON.stringify(options.result) ?? "null"),
  };
  if (options.stderr !== undefined) {
    // Phase timings print as "(123ms)"; the count is a measurement.
    const lines = replace(options.stderr)
      .replace(/\b\d+ms\b/g, "[ms]")
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith(OBSERVER_BUILD_NOTICE));
    snapshot["<stderr>"] = options.unorderedStderr ? lines.sort() : lines;
  }
  // Every route writes the pointer; a missing one fails the snapshot.
  snapshot["../latest.json"] = normalizeJson(
    await readFile(path.join(path.dirname(runDir), "latest.json"), "utf8"),
  );
  const files = (await readdir(runDir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(runDir, path.join(entry.parentPath, entry.name)))
    .sort();
  for (const file of files) {
    if (file === OBSERVER_PAGE) {
      snapshot[file] = "[observer build]";
      continue;
    }
    const bytes = await readFile(path.join(runDir, file));
    const extension = path.extname(file);
    if (extension === ".json") snapshot[file] = normalizeJson(bytes.toString("utf8"));
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
  const pinned = dedupeProjections(snapshot);
  if (!isDeepStrictEqual(inflateProjections(pinned), snapshot))
    throw new Error(
      "dedupeProjections dropped a value; see tests/helpers/run-golden-projections.ts",
    );
  return pinned;
}
