// Removing old runs from a project. Nothing else in humanish deletes a run, so `.humanish/runs` only
// grows until someone asks for this.
import { access, lstat, rm } from "node:fs/promises";
import path from "node:path";

import { RUN_BUNDLE_FILE } from "./bundle.js";
import { bindExistingRunArtifactPaths, validatePreparedRunArtifactPaths } from "./paths.js";
import type { PreparedRunArtifactPaths } from "./paths.js";
import { bindExistingManagedHumanishOutputDirectory } from "./contained-output.js";
import { readLatest, readRunJsonIfExists, runJsonValue } from "./locate.js";
import { RECLAIM_RECEIPT_ARTIFACT } from "./reclaim-outcomes.js";
import { redactText } from "../evidence/redaction.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "./sandbox-receipts.js";
import { RUN_STATUS_FILE } from "./status.js";
import { isRecord } from "./type-guards.js";
import { listRuns } from "./stored-runs.js";

const HOUR_MS = 3_600_000;
/** A heartbeat this recent means the run's process is alive. */
const RUNNING_WITHIN_MS = 5 * 60_000;
/** Longer than any provider lets a sandbox live, so an older run has nothing left to stop. */
const SANDBOX_GONE_AFTER_MS = 7 * 24 * HOUR_MS;

/** `30d` or `12h` in milliseconds; null for anything under an hour, which could catch a live run. */
export function parseRunAge(text: string): number | null {
  const match = /^([0-9]+)(d|h)$/.exec(text.trim());
  if (match === null) return null;
  const ms = Number(match[1]) * (match[2] === "d" ? 24 * HOUR_MS : HOUR_MS);
  return ms >= HOUR_MS ? ms : null;
}

/** Past this, the end of a run says how much its project's runs hold. */
const NOTICE_BYTES = 5 * 1024 ** 3;

/** One line about the disk a project's runs take, once that is worth a person's attention. */
export function runStorageNotice(totalBytes: number, runs: number): string | undefined {
  if (totalBytes < NOTICE_BYTES) return undefined;
  return `This project's ${runs} runs hold ${(totalBytes / 1024 ** 3).toFixed(1)} GB in .humanish/runs. To free disk, preview a cleanup with: humanish runs prune --older-than 30d`;
}

export type KeptReason = "latest" | "running" | "not-copied-back" | "sandboxes-unconfirmed";

export interface PruneResult {
  schema: "humanish.runs-prune-result.v1";
  ok: boolean;
  cwd: string;
  applied: boolean;
  /** Removed when `applied`, and what would be otherwise. */
  removable: Array<{ runId: string; bytes: number; createdAt: string }>;
  /** Runs old enough to remove that were left alone, and why. */
  kept: Array<{ runId: string; reason: KeptReason }>;
  /** Runs that could not be removed. Those listed in `removable` before them are gone. */
  failed: Array<{ runId: string; message: string }>;
  freedBytes: number;
  error?: { code: "HUMANISH_RUNS_UNAVAILABLE"; message: string };
}

interface PruneOptions {
  olderThanMs: number;
  apply: boolean;
  nowMs?: number;
}

export async function pruneRuns(cwdInput: string, options: PruneOptions): Promise<PruneResult> {
  const cwd = path.resolve(cwdInput);
  const nowMs = options.nowMs ?? Date.now();
  const result: PruneResult = {
    schema: "humanish.runs-prune-result.v1",
    ok: true,
    cwd,
    applied: options.apply,
    removable: [],
    kept: [],
    failed: [],
    freedBytes: 0,
  };
  const listed = await listRuns(cwd, { sizes: true });
  if (!listed.ok)
    return {
      ...result,
      ok: false,
      applied: false,
      ...(listed.error ? { error: listed.error } : {}),
    };
  for (const run of listed.runs) {
    try {
      const paths = await bindExistingRunArtifactPaths(cwd, run.runId);
      const startedMs = await runStartedMs(paths, run.createdAt);
      if (nowMs - startedMs < options.olderThanMs) continue;
      const reason = await reasonToKeep(cwd, paths, run.runId, nowMs, nowMs - startedMs);
      if (reason !== undefined) {
        result.kept.push({ runId: run.runId, reason });
        continue;
      }
      if (options.apply) {
        await validatePreparedRunArtifactPaths(paths);
        await rm(paths.physicalRunRoot, { recursive: true, force: true });
      }
      const bytes = run.bytes ?? 0;
      result.removable.push({
        runId: run.runId,
        bytes,
        createdAt: new Date(startedMs).toISOString(),
      });
      result.freedBytes += bytes;
    } catch (error) {
      result.ok = false;
      result.failed.push({
        runId: run.runId,
        message: redactText(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return result;
}

async function runStartedMs(
  paths: PreparedRunArtifactPaths,
  createdAt: string | null,
): Promise<number> {
  const parsed = createdAt === null ? Number.NaN : Date.parse(createdAt);
  return Number.isNaN(parsed) ? (await lstat(paths.physicalRunRoot)).mtimeMs : parsed;
}

async function reasonToKeep(
  cwd: string,
  paths: PreparedRunArtifactPaths,
  runId: string,
  nowMs: number,
  ageMs: number,
): Promise<KeptReason | undefined> {
  // Read here, one run at a time, so a run that became latest during this prune is kept.
  const runsRoot = await bindExistingManagedHumanishOutputDirectory(cwd, "runs");
  const pointer = runsRoot === null ? null : await readLatest(runsRoot);
  if (runId === pointer?.runId) return "latest";
  const read = async (name: string) => runJsonValue(await readRunJsonIfExists(paths, name));
  const exists = (name: string) =>
    access(path.join(paths.physicalRunRoot, name)).then(
      () => true,
      () => false,
    );
  const status = await read(RUN_STATUS_FILE);
  if (isRecord(status) && runIsLive(status, nowMs)) return "running";
  const remote = await read("remote.json");
  if (isRecord(remote) && (remote.copyPending === true || !(await exists(RUN_BUNDLE_FILE))))
    return "not-copied-back";
  // Deleting the journal would lose the only way to stop those sandboxes by id.
  if (ageMs < SANDBOX_GONE_AFTER_MS && (await exists(SANDBOX_RECEIPTS_ARTIFACT))) {
    const receipt = await read(RECLAIM_RECEIPT_ARTIFACT);
    if (!isRecord(receipt) || receipt.state !== "clean") return "sandboxes-unconfirmed";
  }
  return undefined;
}

/** A recent heartbeat, which automatic analysis keeps up after `finished`, or a live owner. */
function runIsLive(status: Record<string, unknown>, nowMs: number): boolean {
  const updatedMs = typeof status.updatedAt === "string" ? Date.parse(status.updatedAt) : NaN;
  if (nowMs - updatedMs < RUNNING_WITHIN_MS) return true;
  return status.state === "running" && typeof status.pid === "number" && pidIsAlive(status.pid);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
