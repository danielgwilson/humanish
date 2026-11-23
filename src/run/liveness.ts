import type { RunOutcome } from "./bundle.js";
import { IN_PROGRESS_SIMULATION_STATUSES } from "./streams.js";
import {
  isRunStatusRecord,
  readRunStatus,
  type RunLiveness,
  type RunStatusBasis,
  type RunStatusRecord,
} from "./status.js";

interface LivenessBundle {
  simulations?: ReadonlyArray<{ status?: string | undefined } | undefined> | undefined;
  outcome?: RunOutcome | undefined;
}

/**
 * The bundle-only reading, for a run with no usable status record. A bundle on disk usually means
 * the run reached its final write. But a live run flushes an in-progress bundle as it goes (so
 * anything asking what a participant is doing has something to read), and that bundle holds each
 * participant that has not ended as queued, preparing or running. With no status record there is
 * no freshness to judge, and the reading of "it started, and nothing here says it finished" is
 * interrupted, not finished.
 */
function bundleLiveness(bundle: LivenessBundle): RunLiveness {
  const inProgress = (bundle.simulations ?? []).some(
    (simulation) =>
      simulation?.status !== undefined && IN_PROGRESS_SIMULATION_STATUSES.has(simulation.status),
  );
  return inProgress ? "interrupted" : "finished";
}

/**
 * Why a run reads as it does. `outcome`: run.json records how the run ended. `bundle`: no status
 * record names the run, so run.json's participants decide. The rest are a status record's own
 * bases (RunStatusBasis).
 */
export type RunLivenessBasis = "outcome" | RunStatusBasis | "bundle";

/** A run's liveness, why it reads so, and the status record the reading came from, if one did. */
export interface RunLivenessReading {
  liveness: RunLiveness;
  basis: RunLivenessBasis;
  record?: RunStatusRecord;
}

/**
 * One run's liveness: the bundle outcome, then a status record that names the run, then the
 * bundle's participants. Every surface that says whether a run is alive reads it here, and maps
 * the basis to its own words when it has to say more than the liveness.
 */
export function runLiveness(
  runId: string,
  status: unknown,
  bundle: LivenessBundle,
  nowMs: number,
): RunLivenessReading {
  if (bundle.outcome !== undefined) return { liveness: bundle.outcome.state, basis: "outcome" };
  return isRunStatusRecord(status) && status.runId === runId
    ? { ...readRunStatus(status, nowMs), record: status }
    : { liveness: bundleLiveness(bundle), basis: "bundle" };
}
