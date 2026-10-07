import type { RunOutcome } from "./bundle.js";
import {
  classifyRunStatus,
  isRunStatusRecord,
  type RunLiveness,
  type RunStatusRecord,
} from "./status.js";

interface LivenessBundle {
  simulations?: ReadonlyArray<{ status?: string | undefined } | undefined> | undefined;
  outcome?: RunOutcome | undefined;
}

/**
 * The bundle-only reading, for a run with no usable status record. A bundle on disk usually means
 * the run reached its final write. But a live run now flushes an in-progress bundle as it goes (so
 * anything asking what a participant is doing has something to read), and that bundle marks its
 * simulations `running`. With no status record there is no freshness to judge, and the
 * reading of "it started, and nothing here says it finished" is interrupted, not finished.
 */
function bundleLiveness(bundle: LivenessBundle): RunLiveness {
  const inProgress = (bundle.simulations ?? []).some(
    (simulation) => simulation?.status === "running",
  );
  return inProgress ? "interrupted" : "finished";
}

/**
 * One run's liveness: the bundle outcome, then usable status, then bundle-only evidence.
 * `readRunIndex` reads in the same order; `humanish verify` calls this with both in hand. `record`
 * is the status record the liveness came from, when there was one.
 */
export function runLiveness(
  runId: string,
  status: unknown,
  bundle: LivenessBundle,
  nowMs: number,
): { liveness: RunLiveness; record?: RunStatusRecord } {
  if (bundle.outcome !== undefined) return { liveness: bundle.outcome.state };
  return isRunStatusRecord(status) && status.runId === runId
    ? { liveness: classifyRunStatus(status, nowMs), record: status }
    : { liveness: bundleLiveness(bundle) };
}
