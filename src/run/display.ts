// How a run reads wherever a surface says whether it passed: the TUI, the Observer and its run
// library, `humanish runs`, `humanish stats` and review.md. Each of them calls runDisplay with the
// same facts, so a run whose own ok is false shows as a pass on none of them, and two surfaces
// cannot disagree about one run.

import type { RunOutcome } from "./bundle.js";
import type { ExecutionFailure } from "./judge.js";
import { classifyRunStatus, isRunStatusRecord, type RunLiveness } from "./status.js";

/** The states a run is shown in. */
export type RunDisplayState =
  | "running"
  | "interrupted"
  | "passed"
  | "failed"
  | "blocked"
  | "timed_out"
  | "no_verdict"
  | "dry_run"
  | "unknown";

/** A run as a surface shows it. */
export interface RunDisplay {
  state: RunDisplayState;
  /** The state in words: "passed", "timed out", "no verdict". */
  label: string;
  /** How a surface colors it: `pass` only for `passed`, `fail` only for `failed`. */
  tone: "pass" | "fail" | "warn" | "live" | "neutral";
  /** The first execution failure that failed the run, as `kind: message`. */
  reason?: string;
}

/** What runDisplay reads: whether the run is alive, what its participants experienced, and its ok. */
export interface RunDisplayFacts {
  liveness: RunLiveness;
  mode?: string | null | undefined;
  /** `review.verdict`. */
  verdict?: string | undefined;
  /** The run's own ok from run.json's outcome; absent when the run recorded none. */
  ok?: boolean | undefined;
  /** The first execution failure that failed the run. */
  failure?: ExecutionFailure | undefined;
}

const LABELS: Record<RunDisplayState, string> = {
  running: "running",
  interrupted: "interrupted",
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
  timed_out: "timed out",
  no_verdict: "no verdict",
  dry_run: "dry run",
  unknown: "unknown",
};

const TONES: Record<RunDisplayState, RunDisplay["tone"]> = {
  running: "live",
  interrupted: "warn",
  passed: "pass",
  failed: "fail",
  blocked: "warn",
  timed_out: "warn",
  no_verdict: "warn",
  dry_run: "neutral",
  unknown: "neutral",
};

function shown(state: RunDisplayState, reason?: string): RunDisplay {
  return {
    state,
    label: LABELS[state],
    tone: TONES[state],
    ...(reason === undefined ? {} : { reason }),
  };
}

/**
 * A run's state. A live or interrupted run is that, whatever its last flush said. A finished run
 * shows its participants' blocked, timed-out or failed verdict; otherwise a run whose ok is false
 * is failed, even with a pass verdict, because its execution failed. Only then does a pass verdict
 * show as passed.
 */
export function runDisplay(facts: RunDisplayFacts): RunDisplay {
  if (facts.liveness === "running") return shown("running");
  if (facts.liveness === "interrupted") return shown("interrupted");
  const reason =
    facts.ok === false && facts.failure !== undefined
      ? `${facts.failure.kind}: ${facts.failure.message}`
      : undefined;
  if (facts.verdict === "blocked") return shown("blocked", reason);
  if (facts.verdict === "timed_out") return shown("timed_out", reason);
  if (facts.verdict === "fail" || facts.ok === false) return shown("failed", reason);
  if (facts.verdict === "pass") return shown("passed");
  if (facts.verdict === "contract_proof_only")
    return shown(facts.mode === "dry-run" ? "dry_run" : "no_verdict");
  return shown("unknown");
}

/** A state in words: "passed", "timed out", "no verdict". */
export function runDisplayLabel(state: RunDisplayState): string {
  return LABELS[state];
}

/** A display as one line of text: the label, then why the run failed when it says. */
function runDisplayLine(display: RunDisplay): string {
  return display.reason === undefined ? display.label : `${display.label}: ${display.reason}`;
}

/** What bundleDisplayFacts reads from run.json; a listing reads it from an unchecked file. */
export interface DisplayedBundle {
  runId: string;
  mode?: string | undefined;
  review?: { verdict?: string | undefined } | undefined;
  simulations?: ReadonlyArray<{ status?: string | undefined } | undefined> | undefined;
  outcome?: RunOutcome | undefined;
}

/**
 * The facts for a run from its bundle. run.json's `outcome` decides when it has one. A bundle
 * without one is in progress, or was recorded before the field existed: its status record, when
 * given and naming the run, then says whether the run is alive and, for the older run, holds its ok.
 * With no record, a bundle whose simulations are still running is live.
 */
export function bundleDisplayFacts(
  bundle: DisplayedBundle,
  status?: unknown,
  nowMs: number = Date.now(),
): RunDisplayFacts {
  const base = { mode: bundle.mode, verdict: bundle.review?.verdict };
  const outcome = bundle.outcome;
  if (outcome?.state === "interrupted") return { ...base, liveness: "interrupted" };
  if (outcome?.state === "finished")
    return {
      ...base,
      liveness: "finished",
      ok: outcome.ok,
      failure: outcome.execution.failures[0],
    };
  if (isRunStatusRecord(status) && status.runId === bundle.runId)
    return {
      ...base,
      liveness: classifyRunStatus(status, nowMs),
      ...(typeof status.outcome?.ok === "boolean" ? { ok: status.outcome.ok } : {}),
      ...(status.outcome?.execution?.failures[0] === undefined
        ? {}
        : { failure: status.outcome.execution.failures[0] }),
    };
  const inProgress = (bundle.simulations ?? []).some(
    (simulation) => simulation?.status === "running",
  );
  return { ...base, liveness: inProgress ? "running" : "finished" };
}

/**
 * How review.md says the run ended: the display of the bundle it is rendered from, so a run whose
 * execution failed never reads as a pass beside its participants' verdict.
 */
export function reviewOutcome(bundle: DisplayedBundle): string {
  return runDisplayLine(runDisplay(bundleDisplayFacts(bundle)));
}
