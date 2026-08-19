// Run identity + liveness on disk (#455/#475): one small record per run that says WHICH LAB the
// run belongs to and WHETHER IT IS STILL ALIVE, written by every backend.
//
// Why it exists. Two questions could not be answered from the filesystem before this:
//   1. "which lab produced this run?" — the bundle carried no lab field; attribution rode a string
//      convention (`persona.source = "lab:<id>"`) that is not universal.
//   2. "is this run still going?" — the mid-run bundle flush is gated on an interactive-observer
//      callback, so a run launched by an agent (`lab run --json`) or detached wrote nothing at all
//      until it completed. Anything watching the directory could not tell running from abandoned.
//
// EVIDENCE VS INDEX (the honesty rule that makes this safe). `run.json` remains the
// evidence-of-record; this file is a DERIVED INDEX + LIVENESS RECORD. `verify` never gates on it,
// nothing here is a claim about what a participant did, and when the two disagree `run.json` wins
// and this file is rebuildable from it. It exists so a reader can list and classify runs without
// parsing every bundle (a 25-run tree measured 152ms warm that way), and so a live run is
// recognizable while it is live.
//
// PUBLIC-SAFETY. Only public-safe fields: the run id, the lab id/path/origin (author-chosen names,
// the same strings `humanish lab list` already prints), the mode, a local pid, and timestamps.
// Deliberately NOT the hostname or any user/path identity — this file sits inside a run directory
// that an operator may share, so it must carry nothing a share-safety gate would have to strip.

import { hrtime } from "node:process";

import { writeContainedOutputFile, type PreparedOutputRoot } from "./selected-output-paths.js";

export const RUN_STATUS_SCHEMA = "humanish.run-status.v1";

/** The file, relative to the run directory. */
export const RUN_STATUS_FILE = "status.json";

/** How often a live run touches `updatedAt`. */
export const RUN_STATUS_TOUCH_MS = 5_000;

/**
 * A `running` record whose `updatedAt` is older than this is INTERRUPTED, not alive: the process
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

export type RunStatusState = "running" | "finished";

/** The outcome summary a finalized record carries. Derived from the bundle; never authoritative. */
export interface RunStatusOutcome {
  /** `review.verdict` verbatim. */
  verdict?: string;
  /** True when the run's own envelope reported success. */
  ok?: boolean;
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

export interface RunStatusRecord {
  schema: typeof RUN_STATUS_SCHEMA;
  runId: string;
  state: RunStatusState;
  mode: "dry-run" | "live";
  /** Absent when the run did not come from a lab manifest (a library caller, a bare `run`). */
  lab?: RunLabProvenance;
  /** The pid that owns the run, for local liveness and (later) cancellation. */
  pid: number;
  startedAt: string;
  /** Refreshed on a fixed cadence while the run is alive; the staleness signal. */
  updatedAt: string;
  completedAt?: string;
  outcome?: RunStatusOutcome;
}

export interface RunStatusHandle {
  /** Resolves once the initial record has landed on disk. The write itself is fire-and-forget —
   *  starting a run must never block on its own index — but a caller that needs the record to
   *  exist before proceeding (a test, or a launcher that hands the run id to another process)
   *  can await this instead of polling. */
  readonly started: Promise<void>;
  /** Write `updatedAt` now. Called by the internal cadence; exposed for tests and for backends
   *  that want to mark a phase boundary. Never throws. */
  touch(): Promise<void>;
  /** Finalize: state `finished`, `completedAt`, and the derived outcome. Stops the cadence.
   *  Idempotent — a second call is a no-op, so a backend with several exit paths is safe. */
  finish(outcome?: RunStatusOutcome): Promise<void>;
  /** Stop the cadence WITHOUT claiming an outcome. For a path that is abandoning the run: the
   *  record stays `running` and goes stale, which is the honest reading. */
  stop(): void;
}

export interface BeginRunStatusOptions {
  runId: string;
  mode: "dry-run" | "live";
  lab?: RunLabProvenance;
  /** Injectable clock (tests freeze it; the repo's `now()` convention). */
  now?: () => number;
  /** Injectable pid so a test never depends on the real process id. */
  pid?: number;
  /** Cadence override; 0 disables the interval entirely (tests drive `touch()` themselves). */
  touchMs?: number;
}

/** A no-op handle, so a caller that cannot write status still has a uniform interface. */
export function inertRunStatus(): RunStatusHandle {
  return { started: Promise.resolve(), touch: async () => {}, finish: async () => {}, stop: () => {} };
}

/**
 * Start a run's status record and keep it fresh. Fire-and-forget by design: a status write that
 * fails must never fail the run it describes, so every write swallows its error. The interval is
 * `unref`'d — this file can never be the reason a process stays alive.
 */
export function beginRunStatus(runPaths: PreparedOutputRoot, options: BeginRunStatusOptions): RunStatusHandle {
  const now = options.now ?? (() => Date.now());
  const iso = (): string => new Date(now()).toISOString();
  const startedAt = iso();
  const base: RunStatusRecord = {
    schema: RUN_STATUS_SCHEMA,
    runId: options.runId,
    state: "running",
    mode: options.mode,
    ...(options.lab === undefined ? {} : { lab: options.lab }),
    pid: options.pid ?? process.pid,
    startedAt,
    updatedAt: startedAt
  };

  let finished = false;
  let writing: Promise<void> = Promise.resolve();
  const write = (record: RunStatusRecord): Promise<void> => {
    // Serialized: two overlapping atomic writes of the same path would be a coin flip over which
    // record survives, and a `running` record landing after a `finished` one would resurrect it.
    writing = writing
      .then(() => writeContainedOutputFile(runPaths, RUN_STATUS_FILE, `${JSON.stringify(record, null, 2)}\n`, "utf8"))
      .catch(() => {
        // Deliberately swallowed: the index is a convenience, the bundle is the evidence.
      });
    return writing;
  };

  const started = write(base);

  const touchMs = options.touchMs ?? RUN_STATUS_TOUCH_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  if (touchMs > 0) {
    timer = setInterval(() => {
      if (finished) return;
      void write({ ...base, updatedAt: iso() });
    }, touchMs);
    timer.unref?.();
  }
  const stop = (): void => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  return {
    started,
    async touch() {
      if (finished) return;
      await write({ ...base, updatedAt: iso() });
    },
    async finish(outcome?: RunStatusOutcome) {
      if (finished) return;
      finished = true;
      stop();
      const completedAt = iso();
      await write({
        ...base,
        state: "finished",
        updatedAt: completedAt,
        completedAt,
        ...(outcome === undefined ? {} : { outcome })
      });
    },
    stop
  };
}

/** The three ways a run reads from disk. `interrupted` is a `running` record gone stale. */
export type RunLiveness = "running" | "interrupted" | "finished";

/**
 * Classify a status record. Pure, so the TUI, the CLI and tests share one definition of "alive".
 * `nowMs` is passed in rather than read, so a classification is reproducible.
 */
export function classifyRunStatus(
  record: Pick<RunStatusRecord, "state" | "updatedAt">,
  nowMs: number,
  staleMs: number = RUN_STATUS_STALE_MS
): RunLiveness {
  if (record.state === "finished") return "finished";
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
  if (record.state !== "running" && record.state !== "finished") return false;
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
 * The legacy bridge: infer a lab id for a bundle written BEFORE this contract, where the only
 * attribution was the `lab:<id>` convention on persona/scenario source strings. Deliberately
 * conservative — it reads the convention and nothing else, and a `lab:` prefix with an empty
 * remainder is not an id. Ids may contain colons (`oss:meta`), so only the FIRST segment is
 * stripped. Returns undefined when the bundle carries no such marker.
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

/** A monotonic elapsed-ms helper for callers that need a duration without trusting wall clocks. */
export function elapsedMsSince(startNs: bigint): number {
  return Number((hrtime.bigint() - startNs) / 1_000_000n);
}
