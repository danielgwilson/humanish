// The run command's signal handling outside post-run analysis. The first interrupt, terminate or
// hangup signal marks each unfinished run in this process interrupted, kills the E2B sandboxes its create-time
// receipts name, and exits 128+n; a second signal exits at once. Routes take no abort signal, so
// the bundle is not finished, but the record ends at once and no journaled sandbox waits for its
// timeout. Analysis has its own cancel handlers (analysis-signals.ts) and takes over when it starts.
import { activeRuns, type ActiveRun } from "../../run/active-runs.js";
import {
  reclaimPinnedRunSandboxes,
  type ReclaimHooks,
  type ReclaimResult,
} from "../../run/reclaim.js";
import type { RunInterruptSignal } from "../../run/status.js";
import type { CliIo } from "../io.js";
import { exitCodeForSignal } from "../observer-follow.js";

/** How long the handler waits for reclaim before it exits anyway. */
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

let current: { end(): void; stopping(): boolean } | undefined;

/** Install the run's signal handling until `end`. A new phase replaces the previous one. */
export function beginRunSignalPhase(
  io: Pick<CliIo, "writeErr">,
  options: RunSignalOptions = {},
): { end(): void } {
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
  current = { end, stopping: () => stopping };
  return { end };
}

/**
 * Analysis is starting, and its own cancel handlers take the signals from here. A shutdown that
 * has already begun keeps its handlers, so a second signal still exits at once.
 */
export function handOverRunSignals(): void {
  if (current !== undefined && !current.stopping()) current.end();
}

async function stopActiveRuns(
  io: Pick<CliIo, "writeErr">,
  signal: RunInterruptSignal,
  options: RunSignalOptions,
): Promise<void> {
  const interrupted: ActiveRun[] = [];
  for (const run of activeRuns()) {
    // False when the run had already finished: its route released what it held.
    if (await run.status.interrupt(signal)) interrupted.push(run);
  }
  if (interrupted.length === 0) return;
  const deadlineMs = options.deadlineMs ?? INTERRUPT_RECLAIM_DEADLINE_MS;
  const lines = await Promise.all(
    interrupted.map(async (run) => {
      const reclaimed = await withDeadline(
        reclaimPinnedRunSandboxes(run.cwd, run.paths, {
          requestTimeoutMs: KILL_REQUEST_TIMEOUT_MS,
          ...options.reclaim,
        }).catch(() => undefined),
        deadlineMs,
      );
      return `humanish: ${signal}: run ${run.runId} marked interrupted; ${reclaimSummary(run.runId, reclaimed, deadlineMs)}\n`;
    }),
  );
  for (const line of lines) {
    try {
      io.writeErr(line);
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

function reclaimSummary(
  runId: string,
  reclaimed: ReclaimResult | undefined | "deadline",
  deadlineMs: number,
): string {
  const retry = `run \`humanish reclaim --run ${runId}\``;
  if (reclaimed === "deadline")
    return `reclaim did not finish within ${deadlineMs / 1000} s; ${retry}.`;
  if (reclaimed === undefined) return `reclaim failed; ${retry}.`;
  if (reclaimed.error !== undefined) return `${reclaimed.error.message}`;
  if (reclaimed.outcomes.length === 0) return "no sandbox receipts to reclaim.";
  const counts = new Map<string, number>();
  for (const outcome of reclaimed.outcomes)
    counts.set(outcome.state, (counts.get(outcome.state) ?? 0) + 1);
  const tally = [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
  return reclaimed.ok ? `sandboxes: ${tally}.` : `sandboxes: ${tally}; ${retry} to retry.`;
}
