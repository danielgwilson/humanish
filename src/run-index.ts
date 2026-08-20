// The run index (#455 PR 2): list and classify every run in a project WITHOUT parsing bundles.
//
// The existing `listRuns` walks each run tree — screenshots included — validating symlinks and
// then parses each `run.json`: measured 197ms cold / 152ms warm at 25 runs. That is fine for a
// command that prints once and exits, and much too hot for a surface that refreshes on a cadence
// over SSH. This module reads the small `status.json` record each run now writes (586 bytes beside
// a 92KB bundle) and caches per-run entries keyed on the stat of the file each was derived from.
//
// HONESTY RULES, unchanged from the record itself:
//   - `run.json` is the evidence-of-record. Every field here is a projection for listing and
//     classification; nothing here is a claim about what a participant did.
//   - A run with no status record is NOT assumed finished. It is classified from what is on disk:
//     a bundle means finished, receipts without a bundle mean interrupted. That is the honest
//     reading of a run whose process died — and, before this contract existed, of every run.
//   - One unreadable run directory degrades that run, never the listing.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  RUN_STATUS_FILE,
  classifyRunStatus,
  inferLegacyLabId,
  isRunStatusRecord,
  type RunLabProvenance,
  type RunLiveness,
  type RunStatusRecord
} from "./run-status.js";

export const RUN_INDEX_SCHEMA = "humanish.run-index.v1";

export interface RunIndexEntry {
  runId: string;
  /** Where the entry's facts came from: the status record, the bundle, or the directory alone. */
  derivedFrom: "status" | "bundle" | "directory";
  liveness: RunLiveness;
  mode?: "dry-run" | "live";
  /**
   * The pid that owns a run, when it recorded one. This is how a surface identifies the run IT just
   * started without minting an id or guessing at a new directory: it spawned a process, and exactly
   * one run's record carries that pid.
   */
  pid?: number;
  lab?: RunLabProvenance;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  verdict?: string;
  participants?: { total: number; reachedGoal: number; reportedFriction?: number };
  estimatedCostUsd?: number | null;
  /** Wall-clock span when both ends are known; used for per-lab medians. */
  durationMs?: number;
}

export interface RunIndexResult {
  schema: typeof RUN_INDEX_SCHEMA;
  cwd: string;
  /** Newest first, by the best timestamp each entry has. */
  runs: RunIndexEntry[];
  /** Directories that could not be read at all, by name — surfaced, never silently dropped. */
  unreadable: string[];
}

/** What a cached entry was derived from, so a changed file invalidates exactly that entry. */
interface CacheKey {
  file: string;
  mtimeMs: number;
  size: number;
  ino: number;
}

interface CacheSlot {
  key: CacheKey;
  entry: RunIndexEntry;
}

/**
 * A process-lifetime cache. Deliberately explicit rather than module-global state: a caller that
 * refreshes on a cadence keeps one and passes it back, and a caller that wants a cold read passes
 * nothing. Nothing here is authoritative, so a stale slot can only ever cost a re-read.
 */
export class RunIndexCache {
  private readonly slots = new Map<string, CacheSlot>();

  get(runId: string, key: CacheKey): RunIndexEntry | undefined {
    const slot = this.slots.get(runId);
    if (slot === undefined) return undefined;
    const same =
      slot.key.file === key.file &&
      slot.key.mtimeMs === key.mtimeMs &&
      slot.key.size === key.size &&
      slot.key.ino === key.ino;
    return same ? slot.entry : undefined;
  }

  set(runId: string, key: CacheKey, entry: RunIndexEntry): void {
    this.slots.set(runId, { key, entry });
  }

  /** Drop entries for runs that no longer exist, so a long-lived surface cannot leak. */
  retain(runIds: Iterable<string>): void {
    const keep = new Set(runIds);
    for (const runId of [...this.slots.keys()]) {
      if (!keep.has(runId)) this.slots.delete(runId);
    }
  }

  get size(): number {
    return this.slots.size;
  }
}

async function statKey(file: string): Promise<CacheKey | null> {
  try {
    const stats = await stat(file);
    return { file, mtimeMs: stats.mtimeMs, size: stats.size, ino: Number(stats.ino) };
  } catch {
    return null;
  }
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    // A torn read cannot happen (writes are tmp+rename), so this is a genuinely absent or
    // malformed file: the caller degrades that run rather than the listing.
    return null;
  }
}

function entryFromStatus(record: RunStatusRecord, nowMs: number): RunIndexEntry {
  const started = Date.parse(record.startedAt);
  const ended = record.completedAt === undefined ? Number.NaN : Date.parse(record.completedAt);
  return {
    runId: record.runId,
    derivedFrom: "status",
    liveness: classifyRunStatus(record, nowMs),
    mode: record.mode,
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    ...(record.lab === undefined ? {} : { lab: record.lab }),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.outcome?.verdict === undefined ? {} : { verdict: record.outcome.verdict }),
    ...(record.outcome?.participants === undefined ? {} : { participants: record.outcome.participants }),
    ...(record.outcome?.estimatedCostUsd === undefined ? {} : { estimatedCostUsd: record.outcome.estimatedCostUsd }),
    ...(Number.isFinite(started) && Number.isFinite(ended) ? { durationMs: ended - started } : {})
  };
}

/** The legacy shape this reads out of a bundle. Narrow on purpose: only listing facts. */
interface BundleFacts {
  runId?: string;
  mode?: string;
  createdAt?: string;
  lab?: RunLabProvenance;
  persona?: { source?: string };
  scenario?: { source?: string };
  simulations?: { status?: string }[];
  review?: {
    verdict?: string;
    participants?: { total: number; reachedGoal: number; reportedFriction?: number };
  };
  cost?: { estimatedTotalUsd?: number | null };
}

function entryFromBundle(runId: string, bundle: BundleFacts): RunIndexEntry {
  // A bundle on disk USUALLY means the run reached its final write. But a live run now flushes an
  // IN-PROGRESS bundle as it goes (so anything asking what a participant is doing has something to
  // read), and that bundle marks its simulations `running`. Reaching this branch at all means there
  // was no status record to classify from, so there is no freshness to judge — and the honest
  // reading of "it started, and nothing here says it finished" is interrupted, not finished.
  const inProgress = (bundle.simulations ?? []).some((simulation) => simulation?.status === "running");
  const legacyLabId = bundle.lab === undefined ? inferLegacyLabId(bundle) : undefined;
  return {
    runId: bundle.runId ?? runId,
    derivedFrom: "bundle",
    liveness: inProgress ? "interrupted" : "finished",
    ...(bundle.mode === "dry-run" || bundle.mode === "live" ? { mode: bundle.mode } : {}),
    ...(bundle.lab !== undefined ? { lab: bundle.lab } : legacyLabId === undefined ? {} : { lab: { id: legacyLabId } }),
    ...(bundle.createdAt === undefined ? {} : { startedAt: bundle.createdAt }),
    ...(bundle.review?.verdict === undefined ? {} : { verdict: bundle.review.verdict }),
    ...(bundle.review?.participants === undefined ? {} : { participants: bundle.review.participants }),
    ...(bundle.cost?.estimatedTotalUsd === undefined ? {} : { estimatedCostUsd: bundle.cost.estimatedTotalUsd })
  };
}

export interface ReadRunIndexOptions {
  /** Reused across refreshes so unchanged runs are not re-read. */
  cache?: RunIndexCache;
  /** Injectable clock, so liveness classification is reproducible in tests. */
  nowMs?: number;
  /** Cap the number of runs returned (newest first). The full directory is still enumerated —
   *  a cap on reads, not on truth — and the count reflects what was read. */
  limit?: number;
}

/**
 * Read every run in `.humanish/runs`, cheapest source first. Never throws for a bad run directory;
 * an unreadable one is named in `unreadable`.
 */
export async function readRunIndex(cwdInput: string, options: ReadRunIndexOptions = {}): Promise<RunIndexResult> {
  const cwd = path.resolve(cwdInput);
  const runsRoot = path.join(cwd, ".humanish", "runs");
  const nowMs = options.nowMs ?? Date.now();
  const cache = options.cache;

  let dirents;
  try {
    dirents = await readdir(runsRoot, { withFileTypes: true });
  } catch {
    // No runs directory yet is an ordinary empty state, not a failure.
    return { schema: RUN_INDEX_SCHEMA, cwd, runs: [], unreadable: [] };
  }

  const runIds = dirents.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const runs: RunIndexEntry[] = [];
  const unreadable: string[] = [];

  for (const runId of runIds) {
    const runDir = path.join(runsRoot, runId);
    const statusFile = path.join(runDir, RUN_STATUS_FILE);
    const bundleFile = path.join(runDir, "run.json");

    // Cheapest source first: the status record. Its stat is the cache key, so a live run whose
    // record ticks every 5s re-reads 586 bytes and nothing else.
    const statusKey = await statKey(statusFile);
    if (statusKey !== null) {
      const cached = cache?.get(runId, statusKey);
      if (cached !== undefined) {
        // Liveness is time-dependent, so it is recomputed even on a cache hit — a record that has
        // not changed can still have gone stale since the last read.
        runs.push(
          cached.derivedFrom === "status" && cached.updatedAt !== undefined
            ? { ...cached, liveness: classifyRunStatus({ state: cached.completedAt === undefined ? "running" : "finished", updatedAt: cached.updatedAt }, nowMs) }
            : cached
        );
        continue;
      }
      const raw = await readJson(statusFile);
      if (isRunStatusRecord(raw)) {
        const entry = entryFromStatus(raw, nowMs);
        cache?.set(runId, statusKey, entry);
        runs.push(entry);
        continue;
      }
    }

    // No usable status record: fall back to the bundle. This is every run written before the
    // contract existed, and it is why an old project still lists correctly.
    const bundleKey = await statKey(bundleFile);
    if (bundleKey !== null) {
      const cached = cache?.get(runId, bundleKey);
      if (cached !== undefined) {
        runs.push(cached);
        continue;
      }
      const raw = await readJson(bundleFile);
      if (raw !== null && typeof raw === "object") {
        const entry = entryFromBundle(runId, raw as BundleFacts);
        cache?.set(runId, bundleKey, entry);
        runs.push(entry);
        continue;
      }
      unreadable.push(runId);
      continue;
    }

    // Neither record nor bundle: receipts without an outcome. That is precisely an interrupted
    // run — the shape a dropped connection leaves — and saying so is more useful than hiding it.
    runs.push({ runId, derivedFrom: "directory", liveness: "interrupted" });
  }

  cache?.retain(runIds);
  runs.sort((left, right) => sortKey(right) - sortKey(left));
  return {
    schema: RUN_INDEX_SCHEMA,
    cwd,
    runs: options.limit === undefined ? runs : runs.slice(0, Math.max(0, options.limit)),
    unreadable
  };
}

/** Newest-first ordering: the most recent thing known about a run, else its id's own timestamp. */
function sortKey(entry: RunIndexEntry): number {
  for (const candidate of [entry.completedAt, entry.updatedAt, entry.startedAt]) {
    if (candidate === undefined) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Run ids embed an ISO-ish stamp (`cua-2026-08-19T07-44-13-489Z-…`); recover it when present so
  // a directory-only entry still sorts sensibly instead of sinking to the bottom.
  const match = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(entry.runId);
  if (match) {
    const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}
