import type { RunOutcome } from "./bundle.js";
import { simulationInProgress } from "./streams.js";
import { isRunStatusRecord, readRunStatus, type RunStatusRecord } from "./status.js";

interface LivenessBundle {
  simulations?: ReadonlyArray<{ status?: string | undefined } | undefined> | undefined;
  outcome?: RunOutcome | undefined;
}

/**
 * A run's liveness and the basis for it, with the fact the reading rests on. `outcome`: run.json
 * records how the run ended. `status`, `heartbeat` and `stale-heartbeat`: a status record that
 * names the run decides, as readRunStatus reads it. `bundle`: no usable status record names the
 * run, so run.json's participants decide.
 */
export type RunLivenessReading =
  | {
      basis: "outcome";
      liveness: "finished";
      outcome: Extract<RunOutcome, { state: "finished" }>;
    }
  | {
      basis: "outcome";
      liveness: "interrupted";
      outcome: Extract<RunOutcome, { state: "interrupted" }>;
    }
  | { basis: "status"; liveness: "finished" | "interrupted"; record: RunStatusRecord }
  | { basis: "heartbeat"; liveness: "running"; record: RunStatusRecord }
  | { basis: "stale-heartbeat"; liveness: "interrupted"; record: RunStatusRecord }
  | { basis: "bundle"; liveness: "finished" | "interrupted" };

/** Why a run reads as running, interrupted or finished. */
export type RunLivenessBasis = RunLivenessReading["basis"];

/**
 * One run's liveness: the bundle outcome, then a status record that names the run, then the
 * bundle's participants. A caller that says more than the liveness switches on the basis.
 *
 * The bundle-only reading is for a run with no usable status record. A bundle on disk usually
 * means the run reached its final write. But a live run flushes an in-progress bundle as it goes
 * (so anything asking what a participant is doing has something to read), and that bundle holds
 * each participant that has not ended as queued, preparing or running. With no status record
 * there is no freshness to judge, and the reading of "it started, and nothing here says it
 * finished" is interrupted.
 */
export function runLiveness(
  runId: string,
  status: unknown,
  bundle: LivenessBundle,
  nowMs: number,
): RunLivenessReading {
  const { outcome } = bundle;
  if (outcome?.state === "finished") return { basis: "outcome", liveness: "finished", outcome };
  if (outcome?.state === "interrupted")
    return { basis: "outcome", liveness: "interrupted", outcome };
  if (isRunStatusRecord(status) && status.runId === runId)
    return { ...readRunStatus(status, nowMs), record: status };
  const inProgress = (bundle.simulations ?? []).some((simulation) =>
    simulationInProgress(simulation?.status),
  );
  return { basis: "bundle", liveness: inProgress ? "interrupted" : "finished" };
}
