import type { RunOutcome } from "./bundle.js";
import type { RunOnRunner } from "./remote-record.js";
import { simulationInProgress } from "./streams.js";
import { isRunStatusRecord, readRunStatus, type RunStatusRecord } from "./status.js";

interface LivenessBundle {
  simulations?: ReadonlyArray<{ status?: string | undefined } | undefined> | undefined;
  outcome?: RunOutcome | undefined;
}

/**
 * A run's liveness and the basis for it, with the fact the reading rests on. `outcome`: run.json
 * records how the run ended. `remote`: no run.json is here and the run's remote record says its
 * evidence is still on its runner. `status`, `heartbeat` and `stale-heartbeat`: a status record that
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
  | {
      basis: "remote";
      liveness: "running" | "interrupted";
      remote: RunOnRunner["record"];
    }
  | { basis: "status"; liveness: "finished" | "interrupted"; record: RunStatusRecord }
  | { basis: "heartbeat"; liveness: "running"; record: RunStatusRecord }
  | { basis: "stale-heartbeat"; liveness: "interrupted"; record: RunStatusRecord }
  | { basis: "bundle"; liveness: "finished" | "interrupted" };

/** Why a run reads as running, interrupted or finished. */
export type RunLivenessBasis = RunLivenessReading["basis"];

/**
 * One run's liveness: the bundle outcome, then a status record that names the run and records its
 * end, then a remote record that says the run is on its runner, then a running status record,
 * then the bundle's participants. A caller that says more than the liveness switches on the basis.
 *
 * `remote` is for a run with no run.json here, as readRunOnRunner reads its directory; a caller
 * that found run.json passes none, since the bundle says more. Such a run reads running until its
 * runner's deadline, since a runner past its time limit is gone, and interrupted once a reclaim
 * here recorded the runner gone. Both are presumed from this machine's clock and files; only the
 * runner can say whether the run still goes. The record decides over a `running` status record,
 * which a copy brought from the runner with the runner's pid and a heartbeat that stopped when it
 * was copied. A `finished` or `interrupted` one is the runner's own record of the end, so it
 * decides first.
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
  remote?: RunOnRunner,
): RunLivenessReading {
  const { outcome } = bundle;
  if (outcome?.state === "finished") return { basis: "outcome", liveness: "finished", outcome };
  if (outcome?.state === "interrupted")
    return { basis: "outcome", liveness: "interrupted", outcome };
  const record = isRunStatusRecord(status) && status.runId === runId ? status : undefined;
  if (record !== undefined && record.state !== "running")
    return { ...readRunStatus(record, nowMs), record };
  if (remote !== undefined) {
    const deadline = remote.record.deadline;
    const pastDeadline = deadline !== undefined && nowMs >= Date.parse(deadline);
    return {
      basis: "remote",
      liveness: remote.reclaimed || pastDeadline ? "interrupted" : "running",
      remote: remote.record,
    };
  }
  if (record !== undefined) return { ...readRunStatus(record, nowMs), record };
  const inProgress = (bundle.simulations ?? []).some((simulation) =>
    simulationInProgress(simulation?.status),
  );
  return { basis: "bundle", liveness: inProgress ? "interrupted" : "finished" };
}
