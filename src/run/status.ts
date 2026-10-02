// Run identity and liveness on disk: one small record per run, written by every backend, that says
// which lab the run belongs to and whether it is still alive. A reader can list and classify runs
// from it without parsing every bundle, and can tell a live run from an abandoned one.
//
// run.json remains the evidence of record. This file is a derived index and liveness record:
// `verify` never gates on it, nothing here is a claim about what a participant did, and when the
// two disagree run.json wins and this file can be rebuilt from it.
//
// Public safety: it holds only the run id, the lab id/path/origin (the strings `humanish lab list`
// prints), the mode, a local pid and timestamps. It holds no hostname or user/path identity: an
// operator may share the run directory, so a share-safety gate must have nothing to strip here.

import type { RunBundle } from "./bundle.js";
import { writeContainedOutputFile, type PreparedOutputRoot } from "./contained-output.js";
import type { ExecutionFailure, ExecutionOutcome } from "./judge.js";
import { redactText } from "../evidence/redaction.js";

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

/** Which manifest a run came from, when it came from one. */
export interface RunLabProvenance {
  /** The lab id as declared in its manifest (`config.id`). */
  id: string;
  /** Repo-relative manifest path, when the run came from a file on disk. */
  path?: string;
  /** `committed` = humanish/labs, `ignored` = a local overlay, `explicit` = a path the operator passed. */
  origin?: "committed" | "ignored" | "explicit";
}

type RunStatusState = "running" | "finished" | "interrupted";

/** The signals the CLI's run handler records when it stops a run. */
export type RunInterruptSignal = "SIGINT" | "SIGTERM" | "SIGHUP";
const RUN_INTERRUPT_SIGNALS: readonly string[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The outcome summary a finalized record carries. Derived from the bundle; never authoritative. */
interface RunStatusOutcome {
  /** `review.verdict` verbatim. */
  verdict?: string;
  /** True when the run's own envelope reported success: the result's ok, recorded after finish. */
  ok?: boolean;
  /** Whether the run worked as an execution, apart from its verdict; recorded after finish. */
  execution?: ExecutionOutcome;
  /** `review.participants` counts, when the run recorded any. */
  participants?: {
    total: number;
    reachedGoal: number;
    reportedFriction?: number;
  };
  /** The run-level estimate, `null` when declared absent (never coerced to 0). */
  estimatedCostUsd?: number | null;
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
  };
}

export interface RunStatusRecord {
  schema: typeof RUN_STATUS_SCHEMA;
  runId: string;
  state: RunStatusState;
  mode: "dry-run" | "live";
  /** Absent when the run did not come from a lab manifest (a library caller, a bare `run`). */
  lab?: RunLabProvenance;
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
   *  Idempotent — a second call is a no-op, so a backend with several exit paths is safe. */
  finish(outcome?: RunStatusOutcome): Promise<void>;
  /** After finish, add the result's ok and execution outcome to the finished record, so status.json
   *  and the result agree. Before finish it does nothing. */
  settle(result: { ok: boolean; execution: ExecutionOutcome }): Promise<void>;
  /** The process is being stopped by `signal`: state `interrupted`, `completedAt` and the signal.
   *  It stops the cadence and makes a later finish or settle a no-op, so the route cannot write
   *  `running` or `finished` over it. When the run had finished it writes nothing, waits for the
   *  writes already queued and resolves false. */
  interrupt(signal: RunInterruptSignal): Promise<boolean>;
}

export interface BeginRunStatusOptions {
  runId: string;
  mode: "dry-run" | "live";
  lab?: RunLabProvenance | undefined;
}

/**
 * Start a run's status record and keep it fresh. Fire-and-forget by design: a status write that
 * fails must never fail the run it describes, so every write swallows its error. The interval is
 * `unref`'d — this file can never be the reason a process stays alive.
 */
export function beginRunStatus(
  runPaths: PreparedOutputRoot,
  options: BeginRunStatusOptions,
): RunStatusHandle {
  const iso = (): string => new Date().toISOString();
  const startedAt = iso();
  const base: RunStatusRecord = {
    schema: RUN_STATUS_SCHEMA,
    runId: options.runId,
    state: "running",
    mode: options.mode,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
  };

  let finished = false;
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

  const timer = setInterval(() => {
    if (finished) return;
    void write({ ...base, updatedAt: iso() });
  }, RUN_STATUS_TOUCH_MS);
  timer.unref?.();

  const handle: RunStatusHandle = {
    started,
    async finish(outcome?: RunStatusOutcome) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
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
    async settle(result) {
      if (finishedRecord === undefined) return;
      // The record is public-safe by construction, so each message passes the shape redaction
      // again even though the routes scrubbed it.
      const redacted = (failure: ExecutionFailure): ExecutionFailure => ({
        kind: failure.kind,
        message: redactText(failure.message),
      });
      const execution: ExecutionOutcome = {
        succeeded: result.execution.succeeded,
        failures: result.execution.failures.map(redacted),
        ...(result.execution.warnings === undefined
          ? {}
          : { warnings: result.execution.warnings.map(redacted) }),
      };
      finishedRecord = {
        ...finishedRecord,
        outcome: { ...finishedRecord.outcome, ok: result.ok, execution },
      };
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
      clearInterval(timer);
      const completedAt = iso();
      await write({ ...base, state: "interrupted", updatedAt: completedAt, completedAt, signal });
      return true;
    },
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
  if (record.lab !== undefined) {
    if (record.lab === null || typeof record.lab !== "object") return false;
    if (typeof (record.lab as Record<string, unknown>).id !== "string") return false;
  }
  return true;
}

/**
 * The legacy bridge: infer a lab id for a bundle written before this contract, where the only
 * attribution was the `lab:<id>` convention on persona/scenario source strings. Deliberately
 * conservative — it reads the convention and nothing else, and a `lab:` prefix with an empty
 * remainder is not an id. Ids may contain colons (the removed meta-lab wrote `oss:meta`), so
 * only the first segment is stripped. Returns undefined when the bundle carries no such marker.
 */
export function inferLegacyLabId(bundle: {
  persona?: { source?: string };
  scenario?: { source?: string };
}): string | undefined {
  for (const source of [bundle.persona?.source, bundle.scenario?.source]) {
    if (typeof source !== "string") continue;
    if (!source.startsWith("lab:")) continue;
    const id = source.slice("lab:".length).trim();
    if (id !== "") return id;
  }
  return undefined;
}
