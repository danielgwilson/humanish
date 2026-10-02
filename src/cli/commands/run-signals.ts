// The run command's signal handling outside post-run analysis. The first interrupt, terminate or
// hangup signal marks each unfinished run in this process interrupted, kills the E2B sandboxes
// its create-time receipts name, runs the registered shutdown cleanups (watch's Observer server
// and tunnel) and exits 128+n, all within one deadline; a second signal exits at once. Routes
// take no abort signal, so the bundle is not finished, but the record ends at once and no
// journaled sandbox waits for its timeout. Analysis has its own cancel handlers
// (analysis-signals.ts) and takes over when it starts.
import path from "node:path";

import { activeRuns, type ActiveRun } from "../../run/active-runs.js";
import { LATEST_RUN_ALIAS } from "../../run/locate.js";
import {
  reclaimPinnedRunSandboxes,
  type ReclaimHooks,
  type ReclaimResult,
} from "../../run/reclaim.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "../../run/sandbox-receipts.js";
import type { RunInterruptSignal } from "../../run/status.js";
import type { CliIo } from "../io.js";
import { exitCodeForSignal } from "../observer-follow.js";

/** How long the handler waits for interrupt, reclaim and cleanups before it exits anyway. */
const INTERRUPT_RECLAIM_DEADLINE_MS = 10_000;
/** Each kill's own request timeout, inside the deadline. */
const KILL_REQUEST_TIMEOUT_MS = 8_000;
const SIGNALS: readonly RunInterruptSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

interface RunSignalTarget {
  on(event: RunInterruptSignal, listener: () => void): unknown;
  removeListener(event: RunInterruptSignal, listener: () => void): unknown;
}

/** Seams for tests; the CLI passes none. */
export interface RunSignalOptions {
  signalTarget?: RunSignalTarget;
  exit?: (code: number) => void;
  reclaim?: ReclaimHooks;
  deadlineMs?: number;
}

let current: { end(): void; release(): void } | undefined;
const shutdownCleanups = new Set<() => Promise<void>>();

/**
 * Register work a committed shutdown finishes before it exits, such as closing watch's Observer
 * server and tunnel. It runs within the same deadline as reclaim. The returned function removes it.
 */
export function onRunShutdown(cleanup: () => Promise<void>): () => void {
  shutdownCleanups.add(cleanup);
  return () => {
    shutdownCleanups.delete(cleanup);
  };
}

/**
 * Install the run's signal handling. `end` removes it. `release` removes it unless a shutdown has
 * begun, which keeps its handlers so a second signal still exits at once.
 */
export function beginRunSignalPhase(
  io: Pick<CliIo, "writeErr">,
  options: RunSignalOptions = {},
): { end(): void; release(): void } {
  const target = options.signalTarget ?? process;
  const exit =
    options.exit ??
    ((code: number) => {
      process.exit(code);
    });
  const handlers = new Map<RunInterruptSignal, () => void>();
  let stopping = false;
  const end = (): void => {
    for (const [signal, handler] of handlers) target.removeListener(signal, handler);
    handlers.clear();
    if (current?.end === end) current = undefined;
  };
  const release = (): void => {
    if (!stopping) end();
  };
  const onSignal = (signal: RunInterruptSignal): void => {
    if (stopping) {
      exit(exitCodeForSignal(signal));
      return;
    }
    stopping = true;
    void stopActiveRuns(io, signal, options)
      .catch(() => undefined)
      .finally(() => exit(exitCodeForSignal(signal)));
  };
  current?.end();
  for (const signal of SIGNALS) {
    const handler = (): void => onSignal(signal);
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
  current = { end, release };
  return { end, release };
}

/** Analysis is starting, and its own cancel handlers take the signals from here. */
export function handOverRunSignals(): void {
  current?.release();
}

/**
 * Interrupt, reclaim and the registered cleanups all run inside one deadline that starts before
 * the first status write is awaited, so a stalled write or kill still ends in a bounded exit.
 */
async function stopActiveRuns(
  io: Pick<CliIo, "writeErr">,
  signal: RunInterruptSignal,
  options: RunSignalOptions,
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? INTERRUPT_RECLAIM_DEADLINE_MS;
  const runs = activeRuns();
  // Absent: still pending at the deadline. Null: the run had finished, so there is nothing to say.
  const reports = new Map<ActiveRun, string | null>();
  const work = Promise.all([
    ...runs.map(async (run) => {
      // False when the run had already finished: its route released what it held.
      if (!(await run.status.interrupt(signal))) {
        reports.set(run, null);
        return;
      }
      const reclaimed = await reclaimPinnedRunSandboxes(run.cwd, run.paths, {
        requestTimeoutMs: KILL_REQUEST_TIMEOUT_MS,
        ...options.reclaim,
      }).catch(() => undefined);
      reports.set(run, reclaimSummary(run, reclaimed));
    }),
    ...[...shutdownCleanups].map((cleanup) => cleanup().catch(() => undefined)),
  ]);
  const finished = await withDeadline(work, deadlineMs);
  for (const run of runs) {
    const report = reports.get(run);
    if (report === null) continue;
    const text =
      report ??
      (finished === "deadline"
        ? `stopping did not finish within ${deadlineMs / 1000} s; ${recovery(run)}.`
        : `reclaim failed; ${recovery(run)}.`);
    try {
      io.writeErr(`humanish: ${signal}: run ${run.runId} marked interrupted; ${text}\n`);
    } catch {
      // A hung-up terminal cannot take the line; the status record and reclaim receipt hold it.
    }
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | "deadline"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * How to finish what the handler could not. A run whose id is the alias `latest` cannot be named
 * to reclaim, which would resolve the newest run instead, so it gets its receipts path.
 */
function recovery(run: ActiveRun): string {
  return run.runId === LATEST_RUN_ALIAS
    ? `its id is \`${LATEST_RUN_ALIAS}\`, which \`humanish reclaim --run\` reads as the newest run, so kill the ids in ${path.join(run.paths.relativeRunRoot, SANDBOX_RECEIPTS_ARTIFACT)} by hand`
    : `run \`humanish reclaim --run ${run.runId}\``;
}

function reclaimSummary(run: ActiveRun, reclaimed: ReclaimResult | undefined): string {
  if (reclaimed === undefined) return `reclaim failed; ${recovery(run)}.`;
  if (reclaimed.error !== undefined) return reclaimed.error.message;
  if (reclaimed.outcomes.length === 0) return "no sandbox receipts to reclaim.";
  const counts = new Map<string, number>();
  for (const outcome of reclaimed.outcomes)
    counts.set(outcome.state, (counts.get(outcome.state) ?? 0) + 1);
  const tally = [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
  return reclaimed.ok ? `sandboxes: ${tally}.` : `sandboxes: ${tally}; ${recovery(run)} to retry.`;
}
