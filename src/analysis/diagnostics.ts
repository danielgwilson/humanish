import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { decodeEscapes } from "../evidence/encoded-text.js";
import { redactText } from "../evidence/redaction.js";
import {
  assertPreparedSelectedOutputDirectory,
  assertSafeOutputPathSegment,
  bindExistingManagedHumanishOutputDirectory,
  prepareManagedHumanishOutputDirectory,
  type PreparedSelectedOutputDirectory,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import {
  scrubTransientCommsText,
  transientCommsEncodedScrub,
} from "../run/transient-comms-secrets.js";
import { ANALYSIS_ID_PATTERN } from "./types.js";

// A rejected analyst response is kept for diagnosis under .humanish/analysis-diagnostics/<run>/,
// outside every run directory. Export, verify and the Observer read run directories only, so the
// file never reaches a bundle, an export or a served page. The analysis artifact itself still
// records only the allowlisted code.
const ANALYSIS_DIAGNOSTICS_DIRECTORY = "analysis-diagnostics";
const ANALYSIS_DIAGNOSTIC_SCHEMA = "humanish.analysis-rejected-output.v1";
/** How many rejected outputs are kept across all runs; older ones are removed on each write. */
export const MAX_ANALYSIS_DIAGNOSTICS = 20;

export interface RejectedAnalysisOutput {
  /** The allowlisted code the analysis artifact records. */
  error: string;
  /** Every failed validation rule, when validation ran. */
  errors: string[];
  /** The response after the narrative scrub when validation ran, else the parsed response. */
  output: unknown;
}

export interface RejectedAnalysisRecord {
  runId: string;
  analysisId: string;
  model: string;
  promptVersion: string;
}

/** Internal fault-injection seam for tests. */
export interface AnalysisDiagnosticsHooks {
  /** Runs after pruning has listed the records and before it removes any. */
  beforeRemove?: () => Promise<void>;
}

const REDACTED = "[REDACTED_SECRET]";
const markers = (text: string): number => text.split(REDACTED).length - 1;

/**
 * Scrub every string, key and scalar in the output. The encoded scrub finds a known value written
 * percent-encoded, escaped or base64-encoded and returns decoded text; a string where it finds
 * nothing keeps its original spelling, so an escape in a rejected quote stays visible, and still
 * gets the literal scrub. A number or boolean equal to a known value becomes the marker.
 */
function scrubber(): (value: unknown) => unknown {
  const encoded = transientCommsEncodedScrub();
  const text = (value: string): string => {
    const found = encoded(value);
    return redactText(
      markers(found) > markers(decodeEscapes(value)) ? found : scrubTransientCommsText(value),
    );
  };
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return text(value);
    if (typeof value === "number" || typeof value === "boolean")
      return text(String(value)) === String(value) ? value : REDACTED;
    if (Array.isArray(value)) return value.map(scrub);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [text(key), scrub(entry)]),
      );
    return value;
  };
  return scrub;
}

/** Write one rejected output and prune to the newest MAX_ANALYSIS_DIAGNOSTICS. Returns its path relative to cwd. */
export async function keepRejectedAnalysisOutput(
  cwd: string,
  record: RejectedAnalysisRecord,
  rejected: RejectedAnalysisOutput,
  hooks: AnalysisDiagnosticsHooks = {},
): Promise<string> {
  assertSafeOutputPathSegment(record.runId, "Run id");
  if (!ANALYSIS_ID_PATTERN.test(record.analysisId)) throw new Error("Unsafe analysis id.");
  const root = await prepareManagedHumanishOutputDirectory(
    cwd,
    ANALYSIS_DIAGNOSTICS_DIRECTORY,
    record.runId,
  );
  const file = `${record.analysisId}.json`;
  const document = {
    schema: ANALYSIS_DIAGNOSTIC_SCHEMA,
    ...record,
    recordedAt: new Date().toISOString(),
    error: rejected.error,
    errors: rejected.errors,
    output: scrubber()(rejected.output),
  };
  await writeContainedOutputFile(root, file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  // A failed prune leaves extra files that the next write removes.
  await pruneAnalysisDiagnostics(cwd, hooks).catch(() => undefined);
  return path.join(".humanish", ANALYSIS_DIAGNOSTICS_DIRECTORY, record.runId, file);
}

/**
 * Remove one record, or with no name one emptied run directory, only while the directory is still
 * the one listed: its path resolves to the same physical directory with the same identity, so a
 * directory swapped for a symlink after listing is refused. The record must be a regular file.
 */
async function removeListed(root: PreparedSelectedOutputDirectory, name?: string): Promise<void> {
  try {
    await assertPreparedSelectedOutputDirectory(root);
    if (name === undefined) {
      await rmdir(root.physicalPath);
      return;
    }
    const file = path.join(root.physicalPath, name);
    if (!(await lstat(file)).isFile()) return;
    await unlink(file);
  } catch {
    // A changed directory, a vanished file or a directory that still holds a file is left alone.
  }
}

async function pruneAnalysisDiagnostics(
  cwd: string,
  hooks: AnalysisDiagnosticsHooks,
): Promise<void> {
  const parent = await bindExistingManagedHumanishOutputDirectory(
    cwd,
    ANALYSIS_DIAGNOSTICS_DIRECTORY,
  );
  if (!parent) return;
  const files: Array<{ root: PreparedSelectedOutputDirectory; name: string; modified: number }> =
    [];
  for (const run of await readdir(parent.physicalPath, { withFileTypes: true })) {
    if (!run.isDirectory()) continue;
    const root = await bindExistingManagedHumanishOutputDirectory(
      cwd,
      ANALYSIS_DIAGNOSTICS_DIRECTORY,
      run.name,
    );
    if (!root) continue;
    for (const entry of await readdir(root.physicalPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const modified = (await lstat(path.join(root.physicalPath, entry.name))).mtimeMs;
      files.push({ root, name: entry.name, modified });
    }
  }
  files.sort(
    (a, b) =>
      b.modified - a.modified ||
      path.join(b.root.physicalPath, b.name).localeCompare(path.join(a.root.physicalPath, a.name)),
  );
  const removed = files.slice(MAX_ANALYSIS_DIAGNOSTICS);
  if (removed.length === 0) return;
  await hooks.beforeRemove?.();
  for (const { root, name } of removed) await removeListed(root, name);
  for (const root of new Set(removed.map((entry) => entry.root))) await removeListed(root);
}
