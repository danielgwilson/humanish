import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { AUTOMATIC_ANALYSIS_DIRECTORY } from "../analysis/job.js";
import { ANALYSIS_DIRECTORY, ANALYSIS_EXECUTION_DIRECTORY } from "../analysis/store.js";
import { readAnalysisAccounting } from "./costs.js";
import { bindExistingRunArtifactPaths } from "./paths.js";
import { analysisCostOf, type RunAnalysisCost } from "./run-cost.js";

// A run's analysis is written after its status record and bundle are final, so the index keys a
// run's analysis cost on a fingerprint of the analysis directories, not on the status record. A
// receipt lands inside an attempt directory that already exists, which changes that directory's
// mtime and not its parent's, so each attempt directory is part of the fingerprint.

/** Stat signatures of everything an analysis write changes; null when the run has no analysis. */
async function analysisFingerprint(runDir: string): Promise<string | null> {
  const signatures: string[] = [];
  for (const directory of [ANALYSIS_EXECUTION_DIRECTORY, ANALYSIS_DIRECTORY]) {
    const root = path.join(runDir, directory);
    const rootSignature = await signature(root);
    if (rootSignature === null) continue;
    signatures.push(`${directory}:${rootSignature}`);
    const children = await readdir(root).catch(() => []);
    for (const child of children.sort((left, right) => left.localeCompare(right)))
      signatures.push(`${directory}/${child}:${await signature(path.join(root, child))}`);
  }
  const job = await signature(path.join(runDir, AUTOMATIC_ANALYSIS_DIRECTORY, "job.json"));
  if (job !== null) signatures.push(`job:${job}`);
  return signatures.length === 0 ? null : signatures.join("|");
}

async function signature(file: string): Promise<string | null> {
  try {
    const stats = await stat(file);
    return `${Number(stats.ino)}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`;
  } catch {
    return null;
  }
}

/** Per-run analysis costs, keyed on their fingerprint. Nothing here is authoritative. */
export class AnalysisCostCache {
  private readonly slots = new Map<
    string,
    { fingerprint: string; cost: RunAnalysisCost | undefined }
  >();

  get(runId: string, fingerprint: string): { cost: RunAnalysisCost | undefined } | undefined {
    const slot = this.slots.get(runId);
    return slot?.fingerprint === fingerprint ? { cost: slot.cost } : undefined;
  }

  set(runId: string, fingerprint: string, cost: RunAnalysisCost | undefined): void {
    this.slots.set(runId, { fingerprint, cost });
  }

  retain(keep: Set<string>): void {
    for (const runId of this.slots.keys()) if (!keep.has(runId)) this.slots.delete(runId);
  }
}

/**
 * The run's analysis spend for its index entry, read with the same reader stats uses. Undefined
 * when the run sent no analysis request or its run directory cannot be bound.
 */
export async function readIndexedAnalysisCost(
  cwd: string,
  runId: string,
  cache: AnalysisCostCache | undefined,
): Promise<RunAnalysisCost | undefined> {
  const fingerprint = await analysisFingerprint(path.join(cwd, ".humanish", "runs", runId));
  if (fingerprint === null) return undefined;
  const cached = cache?.get(runId, fingerprint);
  if (cached !== undefined) return cached.cost;
  let prepared;
  try {
    prepared = await bindExistingRunArtifactPaths(cwd, runId);
  } catch {
    // Not cached: a directory that cannot be bound now may bind on the next refresh.
    return undefined;
  }
  const cost = analysisCostOf(await readAnalysisAccounting(prepared)) ?? undefined;
  cache?.set(runId, fingerprint, cost);
  return cost;
}
