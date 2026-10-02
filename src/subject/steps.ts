// What every subject provisioner shares: where the subject lives on the machine, the step
// budgets, and the started/completed phase events each step reports.

export const SUBJECT_DIR = "/home/user/subject";

/** Budget for putting the subject's source on the machine: a clone, or an archive extract. */
export const SOURCE_TIMEOUT_MS = 5 * 60_000;

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

/** Default phase-boundary sink (stderr): one line per event, prefixed with the participant id
 *  only when the run has more than one participant. A single participant still gets every line:
 *  a silent clone, install, build and ready boot is the bug this event stream exists to close.
 *  Overridable via LabDeps.subjectPhaseSink so deterministic tests capture instead of writing to
 *  the real stderr. */
export function defaultSubjectPhaseSink(
  event: SubjectPhaseEvent,
  participant: { readonly id: string; readonly count: number },
): void {
  const durationSuffix = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
  const prefix =
    participant.count > 1 ? `humanish computer-use [${participant.id}]` : "humanish computer-use";
  process.stderr.write(`${prefix}: ${event.message}${durationSuffix}\n`);
}

/** The shared-world subject's phase line: one shared plane, so no participant prefix. */
export function defaultSharedWorldPhaseSink(event: SubjectPhaseEvent): void {
  const durationSuffix = event.durationMs === undefined ? "" : ` (${event.durationMs}ms)`;
  process.stderr.write(`humanish shared-world (concurrent): ${event.message}${durationSuffix}\n`);
}
