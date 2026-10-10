// Run identity and liveness on disk: one small record per run, written by every backend, that says
// which study the run belongs to and whether it is still alive. A reader can list and classify runs
// from it without parsing every bundle, and can tell a live run from an abandoned one.
//
// run.json remains the evidence of record. This file is a derived index and liveness record:
// `verify` never gates on it, nothing here is a claim about what a participant did, and when the
// two disagree run.json wins. A finished record copies run.json's outcome, so it can be rebuilt
// from it; a record written before run.json carried an outcome holds the only copy of the run's ok.
//
// Public safety: it holds only the run id, the study id/path/origin (the strings `humanish study list`
// prints), the mode, a local pid and timestamps. It holds no hostname or user/path identity: an
// operator may share the run directory, so a share-safety gate must have nothing to strip here.

import type { RunBundle } from "./bundle.js";
import { isProvenanceField, studyFields, type RunStudyProvenance } from "./study-provenance.js";
import { writeContainedOutputFile, type PreparedOutputRoot } from "./contained-output.js";
import type { ExecutionOutcome } from "./judge.js";
import {
  startHeartbeat,
  systemHostClock,
  type HostClock,
  type HostSuspension,
} from "./host-suspension.js";

export const RUN_STATUS_SCHEMA = "humanish.run-status.v1";

/** The file, relative to the run directory. */
export const RUN_STATUS_FILE = "status.json";

/** How often a live run touches `updatedAt`. */
export const RUN_STATUS_TOUCH_MS = 5_000;

/**
 * A `running` record whose `updatedAt` is older than this is interrupted, not alive: the process
 * died without finalizing (a dropped SSH, a killed terminal, a crash). Three touch intervals of
 * slack so an ordinary scheduling hiccup or a slow disk never mislabels a healthy run.
 */
export const RUN_STATUS_STALE_MS = RUN_STATUS_TOUCH_MS * 3;

type RunStatusState = "running" | "finished" | "interrupted";

/** The signals the CLI's run handler records when it stops a run. */
export type RunInterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
const RUN_INTERRUPT_SIGNALS: readonly string[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The outcome summary a finalized record carries. Derived from the bundle; never authoritative. */
interface RunStatusOutcome {
  /** `review.verdict` verbatim. */
  verdict?: string;
  /** run.json's `outcome.ok`: the route result's ok. */
  ok?: boolean;
  /** run.json's `outcome.execution`: whether the run worked as an execution, apart from its verdict. */
  execution?: ExecutionOutcome;
  /** `review.participants` counts, when the run recorded any. */
  participants?: {
    total: number;
    reachedGoal: number;
    reportedFriction?: number;
  };
  /** The run-level estimate, `null` when declared absent (never coerced to 0). */
  estimatedCostUsd?: number | null;
  /**
   * `cost.fullyEstimated`: false when some participant or desktop usage has no price, so the
   * estimate is a lower bound. Absent means unknown, as in every record written before 0.109.
   */
  estimatedCostComplete?: boolean;
  durationMs?: number;
}

/** The outcome a finalized status record carries, read from the bundle that was just written. */
export function runStatusOutcome(bundle: RunBundle): RunStatusOutcome {
  return {
    ...(bundle.review?.verdict === undefined ? {} : { verdict: bundle.review.verdict }),
    ...(bundle.review?.participants === undefined
      ? {}
      : {
          participants: {
            total: bundle.review.participants.total,
            reachedGoal: bundle.review.participants.reachedGoal,
            ...(bundle.review.participants.reportedFriction === undefined
              ? {}
              : { reportedFriction: bundle.review.participants.reportedFriction }),
          },
        }),
    ...(bundle.cost?.estimatedTotalUsd === undefined
      ? {}
      : { estimatedCostUsd: bundle.cost.estimatedTotalUsd }),
    ...(typeof bundle.cost?.fullyEstimated === "boolean"
      ? { estimatedCostComplete: bundle.cost.fullyEstimated }
      : {}),
    ...(bundle.outcome?.state === "finished"
      ? { ok: bundle.outcome.ok, execution: bundle.outcome.execution }
      : {}),
  };
}

export interface RunStatusRecord {
  schema: typeof RUN_STATUS_SCHEMA;
  runId: string;
  state: RunStatusState;
  mode: "dry-run" | "live";
  /** Absent when the run did not come from a study file (a library caller, a bare `run`). */
  study?: RunStudyProvenance;
  /**
   * `study`'s value, as runs saved by 0.108 and earlier wrote it. humanish no longer writes it.
   * Read either through studyProvenanceOf.
   */
  lab?: RunStudyProvenance;
  /**
   * `none` when the route recorded at start that this run creates no sandbox, as a scripted run
   * against an app-url subject does. Absent when the run may create one. Reclaim reads it.
   */
  sandboxes?: "none";
  /** The pid that owns the run, for local liveness checks. */
  pid: number;
  startedAt: string;
  /** Refreshed on a fixed cadence while the run is alive; the staleness signal. */
  updatedAt: string;
  completedAt?: string;
  /** The signal that stopped the run, on an `interrupted` record. */
  signal?: RunInterruptSignal;
  outcome?: RunStatusOutcome;
}

export interface RunStatusHandle {
  /** Resolves once the initial record has landed on disk, and never rejects: a failed write is
   *  swallowed, so a run is never failed by its own index. `startRun` (`src/run/run.ts`) awaits
   *  it before a route can acquire a sandbox, so a run killed after its sandbox receipt lands
   *  still has a record to classify. */
  readonly started: Promise<void>;
  /** Finalize: state `finished`, `completedAt`, and the derived outcome. Stops the cadence.
   *  Idempotent: a second call is a no-op, so a route with several exit paths is safe. */
  finish(outcome?: RunStatusOutcome): Promise<void>;
  /** After finish, replace the finished record's outcome with one read from a rewritten run.json,
   *  so the two agree. Before finish, and after an interrupt, it does nothing. */
  restate(outcome: RunStatusOutcome): Promise<void>;
  /** The process is being stopped by `signal`: state `interrupted`, `completedAt` and the signal.
   *  It stops the cadence and makes a later finish or restate a no-op, so the route cannot write
   *  `running` or `finished` over it. When the run had finished it writes nothing, waits for the
   *  writes already queued and resolves false. */
  interrupt(signal: RunInterruptSignal): Promise<boolean>;
  /** True from the moment `interrupt` accepts a signal, before its write lands. */
  readonly interrupted: boolean;
  /** The host suspensions the cadence saw until now, or until it stopped. */
  suspensions(): readonly HostSuspension[];
}

export interface BeginRunStatusOptions {
  runId: string;
  mode: "dry-run" | "live";
  study?: RunStudyProvenance | undefined;
  sandboxes?: "none" | undefined;
  /** The clock its timestamps and cadence read. Defaults to systemHostClock. */
  clock?: HostClock | undefined;
}

/**
 * Start a run's status record and keep it fresh. Fire-and-forget by design: a status write that
 * fails must never fail the run it describes, so every write swallows its error. The cadence is
 * the run's heartbeat, which also records each host suspension, and its timer never keeps the
 * process alive.
 */
export function beginRunStatus(
  runPaths: PreparedOutputRoot,
  options: BeginRunStatusOptions,
): RunStatusHandle {
  const clock = options.clock ?? systemHostClock;
  const iso = (): string => new Date(clock.now()).toISOString();
  const startedAt = iso();
  const base: RunStatusRecord = {
    schema: RUN_STATUS_SCHEMA,
    runId: options.runId,
    state: "running",
    mode: options.mode,
    ...studyFields(options.study),
    ...(options.sandboxes === undefined ? {} : { sandboxes: options.sandboxes }),
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
  };

  let finished = false;
  let interrupted = false;
  let finishedRecord: RunStatusRecord | undefined;
  let writing: Promise<void> = Promise.resolve();
  const write = (record: RunStatusRecord): Promise<void> => {
    // Serialized: two overlapping atomic writes of the same path would be a coin flip over which
    // record survives, and a `running` record landing after a `finished` one would resurrect it.
    writing = writing
      .then(() =>
        writeContainedOutputFile(
          runPaths,
          RUN_STATUS_FILE,
          `${JSON.stringify(record, null, 2)}\n`,
          "utf8",
        ),
      )
      .catch(() => {
        // Deliberately swallowed: the index is a convenience, the bundle is the evidence.
      });
    return writing;
  };

  const started = write(base);

  const heartbeat = startHeartbeat(clock, RUN_STATUS_TOUCH_MS, () => {
    if (finished) return;
    void write({ ...base, updatedAt: iso() });
  });

  const handle: RunStatusHandle = {
    started,
    async finish(outcome?: RunStatusOutcome) {
      if (finished) return;
      finished = true;
      heartbeat.stop();
      const completedAt = iso();
      finishedRecord = {
        ...base,
        state: "finished",
        updatedAt: completedAt,
        completedAt,
        ...(outcome === undefined ? {} : { outcome }),
      };
      await write(finishedRecord);
    },
    async restate(outcome) {
      if (finishedRecord === undefined) return;
      finishedRecord = { ...finishedRecord, outcome };
      await write(finishedRecord);
    },
    async interrupt(signal) {
      // A finish that has not landed yet is in the chain: wait for it so the process does not
      // exit with `running` on disk.
      if (finished) {
        await writing;
        return false;
      }
      finished = true;
      interrupted = true;
      heartbeat.stop();
      const completedAt = iso();
      await write({ ...base, state: "interrupted", updatedAt: completedAt, completedAt, signal });
      return true;
    },
    get interrupted() {
      return interrupted;
    },
    suspensions: () => heartbeat.suspensions(),
  };
  return handle;
}

/** The three ways a run reads from disk. `interrupted` is a record its stopped process wrote, or a
 *  `running` record gone stale. */
export type RunLiveness = "running" | "interrupted" | "finished";

/**
 * Classify a status record. Pure, so the TUI, the CLI and tests share one definition of "alive".
 * `nowMs` is passed in rather than read, so a classification is reproducible.
 */
export function classifyRunStatus(
  record: Pick<RunStatusRecord, "state" | "updatedAt">,
  nowMs: number,
  staleMs: number = RUN_STATUS_STALE_MS,
): RunLiveness {
  if (record.state === "finished") return "finished";
  if (record.state === "interrupted") return "interrupted";
  const updated = Date.parse(record.updatedAt);
  if (!Number.isFinite(updated)) return "interrupted";
  return nowMs - updated <= staleMs ? "running" : "interrupted";
}

/** Shape guard for a record read off disk. Unknown extra fields are tolerated (additive contract). */
export function isRunStatusRecord(value: unknown): value is RunStatusRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.schema !== RUN_STATUS_SCHEMA) return false;
  if (typeof record.runId !== "string" || record.runId === "") return false;
  if (record.state !== "running" && record.state !== "finished" && record.state !== "interrupted")
    return false;
  if (
    record.signal !== undefined &&
    (typeof record.signal !== "string" || !RUN_INTERRUPT_SIGNALS.includes(record.signal))
  )
    return false;
  if (record.mode !== "dry-run" && record.mode !== "live") return false;
  if (typeof record.pid !== "number") return false;
  if (typeof record.startedAt !== "string" || typeof record.updatedAt !== "string") return false;
  if (!isProvenanceField(record.study) || !isProvenanceField(record.lab)) return false;
  return true;
}
