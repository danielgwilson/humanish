// The run command's signal handling outside post-run analysis. The first interrupt, terminate or
// hangup signal prints one line saying humanish is stopping, refuses any further sandbox create,
// marks each unfinished run in this process interrupted, reclaims its sandboxes (by receipt, by
// the ids its in-flight creates report, and by its E2B tags), runs the registered shutdown
// cleanups (watch's Observer server and tunnel), sweeps the interrupted runs' files of their raw
// sandbox ids as Run.finish does for a finished run, and exits 128+n, all within one deadline. A
// second signal prints the reclaim command for each run not yet reclaimed and exits at once.
// Routes take no abort signal, so the bundle is not finished, but the record ends at once and no
// sandbox the run created waits for its timeout. Analysis has its own cancel handlers
// (analysis-signals.ts) and takes over when it starts.
import path from "node:path";

import { activeRuns, type ActiveRun } from "../../run/active-runs.js";
import { LATEST_RUN_ALIAS } from "../../run/locate.js";
import {
  reclaimPinnedRunSandboxes,
  type ReclaimHooks,
  type ReclaimResult,
} from "../../run/reclaim.js";
import { stopSandboxCreates, type StoppedSandboxCreates } from "../../run/sandbox-creates.js";
import { scrubRunSandboxIds } from "../../run/sandbox-ids.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "../../run/sandbox-receipts.js";
import type { RunInterruptSignal } from "../../run/status.js";
import { plural } from "../../run/text.js";
import { shellArg } from "../../substrates/shell.js";
import type { CliIo } from "../io.js";
import { exitCodeForSignal } from "../observer-follow.js";
import { cli } from "../invocation.js";

/** How long the handler waits for interrupt, reclaim and cleanups before it exits anyway. */
const INTERRUPT_RECLAIM_DEADLINE_MS = 10_000;
/** Each kill's own request timeout, inside the deadline. Kills run concurrently. */
const KILL_REQUEST_TIMEOUT_MS = 8_000;
/** How long reclaim waits for in-flight creates before it searches E2B by tag anyway. */
const CREATES_WAIT_MS = 6_000;
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
  /** Resolves when the deadline has passed; defaults to a timer of `deadlineMs`. */
  deadline?: (ms: number) => Promise<void>;
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

/** One run the first signal is stopping, and what its stop has reported so far. */
interface Stopping {
  run: ActiveRun;
  creates: StoppedSandboxCreates;
  /** Absent: still working. Null: the run had finished, so there is nothing to say. */
  report?: { text: string; clean: boolean } | null;
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
  let stopping: Stopping[] | undefined;
  const end = (): void => {
    for (const [signal, handler] of handlers) target.removeListener(signal, handler);
    handlers.clear();
    if (current?.end === end) current = undefined;
  };
  const release = (): void => {
    if (stopping === undefined) end();
  };
  const onSignal = (signal: RunInterruptSignal): void => {
    if (stopping !== undefined) {
      const open = stopping.filter((stop) => stop.report !== null && stop.report?.clean !== true);
      for (const stop of open)
        say(
          io,
          `humanish: second ${signal}: exiting before run ${stop.run.runId}'s sandboxes were confirmed stopped; ${recovery(stop.run)} to stop what is left.`,
        );
      if (open.length === 0) say(io, `humanish: second ${signal}: exiting.`);
      exit(exitCodeForSignal(signal));
      return;
    }
    // Synchronous, before anything is awaited: no create can start after this point.
    stopping = activeRuns().map((run) => ({ run, creates: stopSandboxCreates(run.paths) }));
    say(io, stoppingLine(signal, stopping, options.deadlineMs ?? INTERRUPT_RECLAIM_DEADLINE_MS));
    void stopActiveRuns(io, signal, stopping, options)
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

function say(io: Pick<CliIo, "writeErr">, line: string): void {
  try {
    io.writeErr(`${line}\n`);
  } catch {
    // A hung-up terminal cannot take the line; the status record and reclaim receipt hold it.
  }
}

function stoppingLine(signal: RunInterruptSignal, stopping: Stopping[], deadlineMs: number) {
  const again = `a second ${signal} exits without waiting`;
  if (stopping.length === 0) return `humanish: ${signal}: stopping; no run had started.`;
  const runs = stopping.map((stop) => stop.run.runId).join(", ");
  return `humanish: ${signal}: stopping run ${runs} and reclaiming its sandboxes (up to ${deadlineMs / 1000} s); ${again}.`;
}

/**
 * Interrupt, reclaim and the registered cleanups all run inside one deadline that starts before
 * the first status write is awaited, so a stalled write or kill still ends in a bounded exit.
 */
async function stopActiveRuns(
  io: Pick<CliIo, "writeErr">,
  signal: RunInterruptSignal,
  stopping: Stopping[],
  options: RunSignalOptions,
): Promise<void> {
  const deadlineMs = options.deadlineMs ?? INTERRUPT_RECLAIM_DEADLINE_MS;
  const work = Promise.all([
    ...stopping.map(async (stop) => {
      // False when the run had already finished: its route released what it held.
      if (!(await stop.run.status.interrupt(signal))) {
        stop.report = null;
        return;
      }
      const reclaimed = await reclaimPinnedRunSandboxes(stop.run.cwd, stop.run.paths, {
        requestTimeoutMs: KILL_REQUEST_TIMEOUT_MS,
        createsWaitMs: Math.min(CREATES_WAIT_MS, deadlineMs / 2),
        ...options.reclaim,
        creates: stop.creates,
      }).catch(() => undefined);
      stop.report = reclaimSummary(stop.run, reclaimed);
    }),
    ...[...shutdownCleanups].map((cleanup) => cleanup().catch(() => undefined)),
  ]).then(() =>
    // Last, so it also covers what the route recorded while reclaim ran, such as a desktop
    // startup error that quotes the sandbox the kill cut short. A run stopped by the deadline is
    // not swept; verify grades a file that names a receipt's id local_only.
    Promise.all(
      stopping
        .filter((stop) => stop.report !== null)
        .map((stop) => scrubRunSandboxIds(stop.run.paths).catch(() => undefined)),
    ),
  );
  const finished = await withDeadline(work, deadlineMs, options.deadline);
  for (const stop of stopping) {
    if (stop.report === null) continue;
    const text = stop.report?.text ?? deadlineText(stop, finished, deadlineMs);
    say(io, `humanish: ${signal}: run ${stop.run.runId} marked interrupted; ${text}`);
  }
}

function deadlineText(stop: Stopping, finished: unknown, deadlineMs: number): string {
  if (finished !== "deadline") return `reclaim failed; sandboxes unknown; ${recovery(stop.run)}.`;
  const inFlight = stop.creates.inFlight();
  const creates =
    inFlight === 0 ? "" : ` Still waiting on E2B: ${plural(inFlight, "sandbox create")}.`;
  return `stopping did not finish within ${deadlineMs / 1000} s; sandboxes unknown.${creates} ${capitalize(recovery(stop.run))}; it also finds sandboxes by this run's E2B tags.`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  wait: ((ms: number) => Promise<void>) | undefined,
): Promise<T | "deadline"> {
  if (wait !== undefined) return Promise.race([work, wait(ms).then(() => "deadline" as const)]);
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
  if (run.runId === LATEST_RUN_ALIAS)
    return `its id is \`${LATEST_RUN_ALIAS}\`, which \`${cli("reclaim --run")}\` reads as the newest run, so kill the ids in ${path.join(run.paths.relativeRunRoot, SANDBOX_RECEIPTS_ARTIFACT)} by hand`;
  const cwd = path.resolve(run.cwd) === process.cwd() ? "" : ` --cwd ${shellArg(run.cwd)}`;
  return `run \`${cli(`reclaim --run ${shellArg(run.runId)}${cwd}`)}\``;
}

function reclaimSummary(
  run: ActiveRun,
  reclaimed: ReclaimResult | undefined,
): { text: string; clean: boolean } {
  if (reclaimed === undefined)
    return { text: `reclaim failed; sandboxes unknown; ${recovery(run)}.`, clean: false };
  if (reclaimed.error !== undefined)
    return {
      text: `${reclaimed.error.message} Sandboxes unknown; ${recovery(run)}.`,
      clean: false,
    };
  const counts = new Map<string, number>();
  for (const outcome of reclaimed.outcomes)
    counts.set(outcome.state, (counts.get(outcome.state) ?? 0) + 1);
  const tally =
    counts.size === 0
      ? "none created"
      : [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
  switch (reclaimed.state) {
    case "clean":
      return {
        text: `sandboxes clean: ${tally}; E2B lists none still tagged with this run.`,
        clean: true,
      };
    case "unconfirmed":
      return { text: `sandboxes unconfirmed: ${tally}; ${recovery(run)} to retry.`, clean: false };
    default: {
      const why =
        reclaimed.createsInFlight > 0
          ? `${plural(reclaimed.createsInFlight, "sandbox create")} still waiting on E2B`
          : `the E2B tag search ${reclaimed.tagSearch.status}${reclaimed.tagSearch.detail === undefined ? "" : ` (${reclaimed.tagSearch.detail})`}`;
      return {
        text: `sandboxes unknown: ${tally}, but ${why}; ${recovery(run)}.`,
        clean: false,
      };
    }
  }
}
