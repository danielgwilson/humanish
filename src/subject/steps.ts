// What every subject provisioner shares: where the subject lives on the machine, the step
// budgets, and the started/completed phase events each step reports.

export const SUBJECT_DIR = "/home/user/subject";

export const CLONE_TIMEOUT_MS = 5 * 60_000;

export const INSTALL_TIMEOUT_MS = 10 * 60_000;

/**
 * One phase-boundary event from the shared subject provisioning pipeline (clone or local-tree
 * route): started/completed pairs at each named boundary, never per poll tick (the detached
 * primitive in src/substrates/detached.ts already polls every 1.5-3s internally; only the
 * boundary itself is surfaced here). Message text is public-safe by construction: no URLs beyond
 * the existing publicAppUrl convention, no paths, no command text. Completed events carry `ok`
 * and `durationMs`; started events (and the fire-and-forget `subject.serve.started`) carry
 * neither.
 */
export interface SubjectPhaseEvent {
  at: string;
  type: string;
  ok?: boolean;
  durationMs?: number;
  message: string;
}

/** ISO timestamp from an injectable clock (tests freeze `now` for deterministic durationMs). */
export function isoNow(now: () => number): string {
  return new Date(now()).toISOString();
}

/** Emit a phase-started event (no ok/durationMs: those belong to the matching completed event). */
export function emitPhaseStarted(
  onPhase: ((event: SubjectPhaseEvent) => void) | undefined,
  now: () => number,
  phase: string,
  message: string,
): void {
  onPhase?.({ at: isoNow(now), type: `cua-lab.subject.${phase}.started`, message });
}

/** Emit the matching phase-completed event: always carries ok and durationMs (>= 0). */
export function emitPhaseCompleted(
  onPhase: ((event: SubjectPhaseEvent) => void) | undefined,
  now: () => number,
  startedAt: number,
  phase: string,
  ok: boolean,
  message: string,
): void {
  onPhase?.({
    at: isoNow(now),
    type: `cua-lab.subject.${phase}.completed`,
    ok,
    durationMs: Math.max(0, now() - startedAt),
    message,
  });
}

/** Default phase-boundary sink (stderr): one line per event, prefixed with the lane id ONLY
 *  when laneCount > 1. Single-lane emission is unconditional: total single-lane silence for the
 *  whole clone/install/build/ready boot is the bug this event stream exists to close.
 *  Overridable via CuaActorLabHooks.onPhase so deterministic tests capture instead of writing to
 *  the real stderr. */
export function defaultSubjectPhaseSink(
  event: SubjectPhaseEvent,
  ctx: { laneId: string; laneCount: number },
): void {
  const durationSuffix = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
  const prefix = ctx.laneCount > 1 ? `humanish cua [${ctx.laneId}]` : "humanish cua";
  process.stderr.write(`${prefix}: ${event.message}${durationSuffix}\n`);
}
