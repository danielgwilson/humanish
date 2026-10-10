// Host suspensions: when the machine running a study sleeps, every participant loop on it stops,
// and on wake its timers and connections fail together. This module notices the gap and says
// which participant failures it likely caused, so the run names the suspension as their cause.
//
// Detection reads the wall clock across a heartbeat. Date.now counts suspended time on macOS and
// Linux. performance.now and Node's timers run on libuv's clock, which counts sleep on macOS
// (mach_continuous_time), so the tick after a sleep fires at wake, and stops during a Linux
// suspend (CLOCK_MONOTONIC), so the tick fires within one interval of resume. Either way the wall
// clock between two ticks shows the gap.

import type { RunEvent } from "./bundle.js";
import { formatDuration } from "./projection.js";
import { plural } from "./text.js";

/** The run's clock and heartbeat timer. Tests pass one whose wall clock they move. */
export interface HostClock {
  /** Wall-clock time in epoch milliseconds. */
  now(): number;
  /** Call `tick` every `intervalMs` until the returned function runs. Never keeps the process alive. */
  every(intervalMs: number, tick: () => void): () => void;
}

export const systemHostClock: HostClock = {
  now: () => Date.now(),
  every(intervalMs, tick) {
    const timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

/**
 * A wall-clock gap between two heartbeats this long or longer is a suspension. A shorter one is
 * most likely a busy event loop.
 */
const HOST_SUSPENSION_MIN_MS = 30_000;

/** A time the run's heartbeat did not run: from its last tick before the gap to its first after. */
export interface HostSuspension {
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export interface Heartbeat {
  /** The suspensions so far. A read also checks the time since the last tick. */
  suspensions(): readonly HostSuspension[];
  /** Stop the timer. Later reads return the suspensions recorded until then. */
  stop(): void;
}

/** Run `onTick` every `intervalMs` on `clock`, and record each gap of 30 s or more. */
export function startHeartbeat(
  clock: HostClock,
  intervalMs: number,
  onTick: () => void,
): Heartbeat {
  const found: HostSuspension[] = [];
  let lastMs = clock.now();
  let stopped = false;
  const observe = (): void => {
    if (stopped) return;
    const nowMs = clock.now();
    if (nowMs - lastMs >= HOST_SUSPENSION_MIN_MS)
      found.push({
        startedAt: new Date(lastMs).toISOString(),
        endedAt: new Date(nowMs).toISOString(),
        durationMs: nowMs - lastMs,
      });
    lastMs = nowMs;
  };
  const stopTimer = clock.every(intervalMs, () => {
    observe();
    onTick();
  });
  return {
    suspensions() {
      observe();
      return [...found];
    },
    stop() {
      stopped = true;
      stopTimer();
    },
  };
}

/** `6m 5s at +1m`: how long, and how far into the run it started. */
function span(suspension: HostSuspension, runStartMs: number): string {
  const offset = Date.parse(suspension.startedAt) - runStartMs;
  return `${formatDuration(suspension.durationMs)} at +${formatDuration(offset)}`;
}

/** One warn event per suspension, at its start, naming its start, end, length and offset. */
export function hostSuspensionEvents(
  suspensions: readonly HostSuspension[],
  runStartMs: number,
): RunEvent[] {
  return suspensions.map((suspension, index) => ({
    id: `event-host-suspended-${String(index + 1).padStart(3, "0")}`,
    at: suspension.startedAt,
    level: "warn",
    type: "host.suspended",
    message: `The host was suspended for ${formatDuration(suspension.durationMs)}, from ${suspension.startedAt} to ${suspension.endedAt} (+${formatDuration(Date.parse(suspension.startedAt) - runStartMs)} into the run): the run's heartbeat did not run in that time. A process that was stopped, or a clock set forward, reads the same way.`,
  }));
}

/** One participant as the attribution reads it. */
export interface SuspendedParticipant {
  id: string;
  /**
   * How it did not pass, when a suspension can explain that: an error in the harness, its
   * session's time limit, or a skip after another participant's harness error. Absent when it
   * passed or its session ended on its own report.
   */
  failure?: "harness" | "time-limit" | "skipped";
  /** When it started; absent when no record says. */
  startedAtMs?: number;
  /** When its session ended; absent when it has no session record. */
  endedAtMs?: number;
}

/** What a run says about its host suspensions. */
export interface HostSuspensionReading {
  /** One sentence for the run outcome, the CLI and the review. */
  summary: string;
  /** The participants whose failure is likely a suspension's effect, in the order given. */
  participantIds: string[];
  suspensions: HostSuspension[];
}

/** The participant was running at some moment of the suspension. */
function inFlight(participant: SuspendedParticipant, suspension: HostSuspension): boolean {
  return (
    (participant.startedAtMs ?? -Infinity) <= Date.parse(suspension.endedAt) &&
    (participant.endedAtMs ?? Infinity) >= Date.parse(suspension.startedAt)
  );
}

/**
 * Which failures the run's suspensions likely caused, and the sentence that says so; undefined
 * without a suspension. A frozen loop's failures surface at the wake (macOS fires every overdue
 * timer at once) or up to a turn timeout later (Linux timers do not count suspended time), so the
 * rule reads who was in flight across the suspension. A skip follows another participant's
 * harness error (the pipeline gate, fail-fast), so skips count only when the run had harness
 * errors and every one was in flight across a suspension.
 */
export function readHostSuspensions(
  suspensions: readonly HostSuspension[],
  participants: readonly SuspendedParticipant[],
  runStartMs: number,
): HostSuspensionReading | undefined {
  if (suspensions.length === 0) return undefined;
  const explained = new Set(
    participants
      .filter(
        (participant) =>
          (participant.failure === "harness" || participant.failure === "time-limit") &&
          suspensions.some((suspension) => inFlight(participant, suspension)),
      )
      .map((participant) => participant.id),
  );
  const harness = participants.filter((participant) => participant.failure === "harness");
  const skipsFollow =
    harness.length > 0 && harness.every((participant) => explained.has(participant.id));
  const participantIds = participants
    .filter(
      (participant) =>
        explained.has(participant.id) || (participant.failure === "skipped" && skipsFollow),
    )
    .map((participant) => participant.id);
  const one = suspensions.length === 1;
  const what = one
    ? `The host was suspended for ${span(suspensions[0]!, runStartMs)}`
    : `The host was suspended ${suspensions.length} times (${suspensions.map((suspension) => span(suspension, runStartMs)).join(", ")})`;
  const count = participantIds.length;
  const effect =
    count === 0
      ? "no participant failure followed"
      : `the ${plural(count, "participant failure")} after ${one ? "it" : "them"} ${count === 1 ? "is" : "are"} likely ${one ? "its" : "their"} effect`;
  return { summary: `${what}; ${effect}.`, participantIds, suspensions: [...suspensions] };
}
