import { lstat, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

import { redactText } from "../evidence/redaction.js";
import {
  assertSafeOutputPathSegment,
  bindExistingManagedHumanishOutputDirectory,
  prepareManagedHumanishOutputDirectory,
  writeContainedOutputFile,
} from "../run/contained-output.js";
import { scrubTransientCommsText } from "../run/transient-comms-secrets.js";
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

const scrub = (text: string): string => redactText(scrubTransientCommsText(text));

function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [scrub(key), scrubValue(entry)]),
    );
  return value;
}

/** Write one rejected output and prune to the newest MAX_ANALYSIS_DIAGNOSTICS. Returns its path relative to cwd. */
export async function keepRejectedAnalysisOutput(
  cwd: string,
  record: RejectedAnalysisRecord,
  rejected: RejectedAnalysisOutput,
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
    output: scrubValue(rejected.output),
  };
  await writeContainedOutputFile(root, file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  // A failed prune leaves extra files that the next write removes.
  await pruneAnalysisDiagnostics(cwd).catch(() => undefined);
  return path.join(".humanish", ANALYSIS_DIAGNOSTICS_DIRECTORY, record.runId, file);
}

async function pruneAnalysisDiagnostics(cwd: string): Promise<void> {
  const parent = await bindExistingManagedHumanishOutputDirectory(
    cwd,
    ANALYSIS_DIAGNOSTICS_DIRECTORY,
  );
  if (!parent) return;
  const files: Array<{ directory: string; file: string; modified: number }> = [];
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
      const file = path.join(root.physicalPath, entry.name);
      files.push({ directory: root.physicalPath, file, modified: (await lstat(file)).mtimeMs });
    }
  }
  files.sort((a, b) => b.modified - a.modified || b.file.localeCompare(a.file));
  const removed = files.slice(MAX_ANALYSIS_DIAGNOSTICS);
  for (const { file } of removed) await unlink(file).catch(() => undefined);
  // rmdir fails on a directory that still holds a file, which keeps it.
  for (const directory of new Set(removed.map((entry) => entry.directory)))
    await rmdir(directory).catch(() => undefined);
}
