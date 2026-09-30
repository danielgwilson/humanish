import { digestText } from "../evidence/redaction.js";
import { failureTail } from "../evidence/redaction.js";
import type { LabStateStepWhen, LabSubjectState } from "../lab/types.js";
import type { RunSubjectStateStepRecord } from "../run/bundle.js";
import { runDetachedStep, type DetachedTimers } from "../substrates/detached.js";
import type { Shell } from "../substrates/shell.js";
import {
  emitPhaseCompleted,
  emitPhaseStarted,
  SUBJECT_DIR,
  type SubjectPhaseEvent,
} from "./steps.js";

// Per-step budget for subject.state seed steps; each step's declared (or default) budget is
// also summed into the default sandbox deadline so seeding never eats the session's room.
export const DEFAULT_STATE_STEP_TIMEOUT_MS = 5 * 60_000;

/** sha256 hex of the exact command string, first 16 chars (the promptDigest convention). */
export function commandDigestOf(command: string): string {
  return digestText(command, 16);
}

/**
 * Run the declared seed steps for one phase of the serve pipeline, as detached steps named
 * `subject-state-<name>` so a step can never collide with a serve step. Each step's record goes
 * to `onStateStep` as it finishes; the first failure throws with its scrubbed log tail.
 */
export async function runStateSteps(
  shell: Shell,
  when: LabStateStepWhen,
  args: {
    state?: LabSubjectState;
    requestTimeoutMs: number;
    /** Literal scrubber for known provisioned values, applied to log tails PRE-truncation. */
    scrub: (text: string) => string;
    onStateStep?: (record: RunSubjectStateStepRecord) => void;
    onPhase?: (event: SubjectPhaseEvent) => void;
    now: () => number;
    timers: DetachedTimers;
  },
): Promise<void> {
  const { now, timers } = args;
  const stateSteps = args.state?.seed ?? [];
  const steps = stateSteps.filter((step) => (step.when ?? "before-start") === when);
  if (steps.length === 0) {
    // No declared steps for this group: no boundary to report (avoids empty-group noise on
    // every run, since before-build/before-start/after-ready are always called).
    return;
  }
  const groupStartedAt = now();
  emitPhaseStarted(
    args.onPhase,
    now,
    `state.${when}`,
    `running subject state seed steps (${when})`,
  );
  for (const step of steps) {
    const stepTimeoutMs = step.timeoutMs ?? DEFAULT_STATE_STEP_TIMEOUT_MS;
    const startedAt = now();
    const result = await runDetachedStep(shell, {
      name: `subject-state-${step.name}`,
      command: step.command,
      cwd: SUBJECT_DIR,
      timeoutMs: stepTimeoutMs,
      requestTimeoutMs: args.requestTimeoutMs,
      ...timers,
    });
    args.onStateStep?.({
      name: step.name,
      when,
      // Digest only (sha256-16): the command text never persists: the lab YAML in the
      // consumer's repo is the plaintext source of truth.
      commandDigest: commandDigestOf(step.command),
      ok: result.ok,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.timedOut ? { timedOut: true } : {}),
      durationMs: Math.max(0, now() - startedAt),
    });
    if (!result.ok) {
      emitPhaseCompleted(
        args.onPhase,
        now,
        groupStartedAt,
        `state.${when}`,
        false,
        `subject state seed steps failed (${when})`,
      );
      // Fail closed with the existing scrub-before-truncate tail chain: literal scrub of
      // every provisioned value PRE-truncation, then pattern redaction + cap in tailOf.
      throw new Error(
        `subject state step "${step.name}" ${result.timedOut ? `timed out after ${stepTimeoutMs}ms` : `failed (exit ${result.exitCode})`}: ${failureTail(args.scrub(result.logTail))}`,
      );
    }
  }
  emitPhaseCompleted(
    args.onPhase,
    now,
    groupStartedAt,
    `state.${when}`,
    true,
    `subject state seed steps complete (${when})`,
  );
}
