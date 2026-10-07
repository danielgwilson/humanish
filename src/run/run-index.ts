// The run index caches listing facts by both source files. run.json's outcome wins over status,
// including when a process stopped between publishing its bundle and finalizing its heartbeat.
// A status record supplies freshness only when the bundle has no outcome.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runLiveness } from "./liveness.js";
import { AnalysisCostCache, readIndexedAnalysisCost } from "./run-index-analysis.js";
import type { RunAnalysisCost } from "./run-cost.js";

import {
  RUN_STATUS_FILE,
  classifyRunStatus,
  isRunStatusRecord,
  type RunLiveness,
  type RunStatusRecord,
} from "./status.js";
import { studyProvenanceOf, type RunStudyProvenance } from "./study-provenance.js";
import { RUN_BUNDLE_FILE } from "./bundle.js";
import { isRunOutcome } from "./bundle-shape.js";
import type { ExecutionFailure } from "./judge.js";

const RUN_INDEX_SCHEMA = "humanish.run-index.v1";

export interface RunIndexEntry {
  runId: string;
  /** Where the entry's facts came from: the status record, the bundle, or the directory alone. */
  derivedFrom: "status" | "bundle" | "directory";
  liveness: RunLiveness;
  mode?: "dry-run" | "live";
  /**
   * The pid that owns a run, when it recorded one. This is how a surface identifies the run it just
   * started without minting an id or guessing at a new directory: it spawned a process, and exactly
   * one run's record carries that pid.
   */
  pid?: number;
  study?: RunStudyProvenance;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  verdict?: string;
  /**
   * The run's own ok, from run.json's outcome as status.json copies it, or from the status record
   * alone for a run recorded before run.json carried one. Absent when the run recorded none.
   * runDisplay (src/run/display.ts) reads it with `verdict` and `liveness`.
   */
  ok?: boolean;
  /** The first execution failure that failed the run, beside `ok`. */
  failure?: ExecutionFailure;
  participants?: { total: number; reachedGoal: number; reportedFriction?: number };
  /** Participants and desktops only; analysis bills separately and is in `analysisCost`. */
  estimatedCostUsd?: number | null;
  /** False when that figure is a lower bound; absent when unknown (a status record before 0.109). */
  estimatedCostComplete?: boolean;
  /** The run's analysis requests, every attempt counted once; absent when it sent none. */
  analysisCost?: RunAnalysisCost;
  /** Wall-clock span when both ends are known; used for per-study medians. */
  durationMs?: number;
}

export interface RunIndexResult {
  schema: typeof RUN_INDEX_SCHEMA;
  cwd: string;
  /** Newest first, by the best timestamp each entry has. */
  runs: RunIndexEntry[];
  /** Directories that could not be read at all, by name: surfaced, never silently dropped. */
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
  key: string;
  entry: RunIndexEntry;
}

/**
 * A process-lifetime cache. Deliberately explicit rather than module-global state: a caller that
 * refreshes on a cadence keeps one and passes it back, and a caller that wants a cold read passes
 * nothing. Nothing here is authoritative, so a stale slot can only ever cost a re-read.
 */
export class RunIndexCache {
  private readonly slots = new Map<string, CacheSlot>();
  /** Analysis costs, keyed on their own fingerprint: analysis lands after the status record. */
  readonly analysis = new AnalysisCostCache();

  get(runId: string, key: string): RunIndexEntry | undefined {
    const slot = this.slots.get(runId);
    if (slot === undefined) return undefined;
    return slot.key === key ? slot.entry : undefined;
  }

  set(runId: string, key: string, entry: RunIndexEntry): void {
    this.slots.set(runId, { key, entry });
  }

  /** Drop entries for runs that no longer exist, so a long-lived surface cannot leak. */
  retain(runIds: Iterable<string>): void {
    const keep = new Set(runIds);
    for (const runId of this.slots.keys()) {
      if (!keep.has(runId)) this.slots.delete(runId);
    }
    this.analysis.retain(keep);
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

async function readJson(file: string): Promise<unknown> {
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
    liveness: runLiveness(record.runId, record, {}, nowMs).liveness,
    mode: record.mode,
    ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
    ...studyEntry(studyProvenanceOf(record)),
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.outcome?.verdict === undefined ? {} : { verdict: record.outcome.verdict }),
    ...(typeof record.outcome?.ok === "boolean" ? { ok: record.outcome.ok } : {}),
    ...(record.outcome?.execution?.failures[0] === undefined
      ? {}
      : { failure: record.outcome.execution.failures[0] }),
    ...(record.outcome?.participants === undefined
      ? {}
      : { participants: record.outcome.participants }),
    ...(record.outcome?.estimatedCostUsd === undefined
      ? {}
      : { estimatedCostUsd: record.outcome.estimatedCostUsd }),
    ...(typeof record.outcome?.estimatedCostComplete === "boolean"
      ? { estimatedCostComplete: record.outcome.estimatedCostComplete }
      : {}),
    ...(Number.isFinite(started) && Number.isFinite(ended) ? { durationMs: ended - started } : {}),
  };
}

/** The legacy shape this reads out of a bundle. Narrow on purpose: only listing facts. */
interface BundleFacts {
  runId?: string;
  mode?: string;
  createdAt?: string;
  study?: unknown;
  lab?: unknown;
  persona?: { source?: string };
  scenario?: { source?: string };
  simulations?: { status?: string }[];
  review?: {
    verdict?: string;
    participants?: { total: number; reachedGoal: number; reportedFriction?: number };
  };
  cost?: { estimatedTotalUsd?: number | null; fullyEstimated?: unknown };
  outcome?: unknown;
}

/** A status record this run can be classified from: well formed and naming this run. */
function usableStatusRecord(raw: unknown, runId: string): raw is RunStatusRecord {
  return isRunStatusRecord(raw) && raw.runId === runId;
}

function studyEntry(study: RunStudyProvenance | undefined): { study?: RunStudyProvenance } {
  return study === undefined ? {} : { study };
}

function entryFromBundle(runId: string, bundle: BundleFacts): RunIndexEntry {
  const outcome = isRunOutcome(bundle.outcome) ? bundle.outcome : undefined;
  const failure = outcome?.state === "finished" ? outcome.execution.failures[0] : undefined;
  return {
    runId,
    derivedFrom: "bundle",
    liveness: runLiveness(
      runId,
      undefined,
      { simulations: bundle.simulations, outcome },
      Date.now(),
    ).liveness,
    ...(bundle.mode === "dry-run" || bundle.mode === "live" ? { mode: bundle.mode } : {}),
    ...studyEntry(studyProvenanceOf(bundle)),
    ...(bundle.createdAt === undefined ? {} : { startedAt: bundle.createdAt }),
    ...(bundle.review?.verdict === undefined ? {} : { verdict: bundle.review.verdict }),
    ...(outcome === undefined ? {} : { ok: outcome.ok }),
    ...(failure === undefined ? {} : { failure }),
    ...(bundle.review?.participants === undefined
      ? {}
      : { participants: bundle.review.participants }),
    ...(bundle.cost?.estimatedTotalUsd === undefined
      ? {}
      : { estimatedCostUsd: bundle.cost.estimatedTotalUsd }),
    ...(typeof bundle.cost?.fullyEstimated === "boolean"
      ? { estimatedCostComplete: bundle.cost.fullyEstimated }
      : {}),
  };
}

export interface ReadRunIndexOptions {
  /** Reused across refreshes so unchanged runs are not re-read. */
  cache?: RunIndexCache;
  /** Injectable clock, so liveness classification is reproducible in tests. */
  nowMs?: number;
  /** Cap the number of runs returned (newest first). The full directory is still enumerated;
   *  the cap limits reads, and the count reflects what was read. */
  limit?: number;
}

/**
 * Read every run in `.humanish/runs`, from its cached source files. Never throws for a bad run directory;
 * an unreadable one is named in `unreadable`.
 */
export async function readRunIndex(
  cwdInput: string,
  options: ReadRunIndexOptions = {},
): Promise<RunIndexResult> {
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
    const entry = await readEntry(runId, path.join(runsRoot, runId), cache, nowMs);
    if (entry === "unreadable") {
      unreadable.push(runId);
      continue;
    }
    const analysisCost =
      entry.derivedFrom === "directory"
        ? undefined
        : await readIndexedAnalysisCost(cwd, runId, cache?.analysis);
    runs.push(analysisCost === undefined ? entry : { ...entry, analysisCost });
  }

  cache?.retain(runIds);
  runs.sort((left, right) => sortKey(right) - sortKey(left));
  return {
    schema: RUN_INDEX_SCHEMA,
    cwd,
    runs: options.limit === undefined ? runs : runs.slice(0, Math.max(0, options.limit)),
    unreadable,
  };
}

/** One run's entry, from its cached source files, or "unreadable" when its bundle cannot be parsed. */
async function readEntry(
  runId: string,
  runDir: string,
  cache: RunIndexCache | undefined,
  nowMs: number,
): Promise<RunIndexEntry | "unreadable"> {
  const statusFile = path.join(runDir, RUN_STATUS_FILE);
  const bundleFile = path.join(runDir, RUN_BUNDLE_FILE);

  const [statusKey, bundleKey] = await Promise.all([statKey(statusFile), statKey(bundleFile)]);
  const key = JSON.stringify([statusKey, bundleKey]);
  const cached = cache?.get(runId, key);
  if (cached !== undefined) {
    return cached.derivedFrom === "status" &&
      cached.updatedAt !== undefined &&
      cached.completedAt === undefined
      ? {
          ...cached,
          liveness: classifyRunStatus({ state: "running", updatedAt: cached.updatedAt }, nowMs),
        }
      : cached;
  }
  const [status, raw] = await Promise.all([
    statusKey === null ? undefined : readJson(statusFile),
    bundleKey === null ? undefined : readJson(bundleFile),
  ]);
  const record = usableStatusRecord(status, runId) ? status : undefined;
  const bundle = raw !== null && typeof raw === "object" ? (raw as BundleFacts) : undefined;
  let entry: RunIndexEntry;
  if (bundle !== undefined && isRunOutcome(bundle.outcome)) {
    const metadata = record === undefined ? undefined : entryFromStatus(record, nowMs);
    entry = {
      ...(metadata === undefined
        ? {}
        : {
            pid: metadata.pid,
            startedAt: metadata.startedAt,
            updatedAt: metadata.updatedAt,
            ...(metadata.completedAt === undefined ? {} : { completedAt: metadata.completedAt }),
            ...(metadata.durationMs === undefined ? {} : { durationMs: metadata.durationMs }),
            ...studyEntry(metadata.study),
          }),
      ...entryFromBundle(runId, bundle),
    };
  } else if (record !== undefined) {
    entry = entryFromStatus(record, nowMs);
  } else if (bundle !== undefined) {
    entry = entryFromBundle(runId, bundle);
  } else if (bundleKey !== null) {
    return "unreadable";
  } else {
    return { runId, derivedFrom: "directory", liveness: "interrupted" };
  }
  cache?.set(runId, key, entry);
  return entry;
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
