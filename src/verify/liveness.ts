// `humanish verify`'s RUN_NOT_FINISHED warning. Verify checks the integrity of what a run wrote,
// and a run killed mid-way leaves an in-progress bundle that passes those checks. The warning says
// what verify saw on disk, so `ok: true` is not read as "the run finished". It never flips `ok`.

import path from "node:path";

import type { RunBundle } from "../run/bundle.js";
import { readRunJsonIfExists, readRunTextIfExists } from "../run/locate.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { isRecord } from "../run/primitives.js";
import { RECLAIM_RECEIPT_ARTIFACT } from "../run/reclaim.js";
import { runLiveness } from "../run/run-index.js";
import { parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "../run/sandbox-receipts.js";
import { RUN_STATUS_FILE } from "../run/status.js";

/** The stable code every RUN_NOT_FINISHED warning starts with. */
const RUN_NOT_FINISHED = "RUN_NOT_FINISHED";

const GONE_STATES = new Set(["killed", "already-gone"]);

/**
 * One warning when the run is not finished, by the run index's rule: its status record when it
 * has a usable one, else a simulation still `running` in its bundle. Empty for a finished run.
 */
export async function runNotFinishedWarnings(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const runId = path.basename(runPaths.absoluteRunRoot);
  const status = await readRunJsonIfExists(runPaths, RUN_STATUS_FILE);
  const { liveness, record } = runLiveness(runId, status, bundle, nowMs);
  if (liveness === "finished") return [];

  const seen: string[] = [];
  if (record === undefined) {
    const running = bundle.simulations.filter((simulation) => simulation.status === "running");
    seen.push(
      `the run has no usable ${RUN_STATUS_FILE} and ${running.length} of ${bundle.simulations.length} simulations are still running`,
    );
  } else if (liveness === "running") {
    seen.push(
      `${RUN_STATUS_FILE} state is ${record.state} and its owner updated it at ${record.updatedAt}, so the run may still be writing`,
    );
  } else {
    seen.push(
      `${RUN_STATUS_FILE} state is ${record.state} and its owner stopped updating it at ${record.updatedAt}`,
    );
  }
  const runningStreams = bundle.streams.filter((stream) => stream.status === "running").length;
  seen.push(`${runningStreams} of ${bundle.streams.length} streams are still running`);

  const reclaim = await reclaimState(runPaths, runId);
  return [
    `${RUN_NOT_FINISHED}: ${seen.join("; ")}.${reclaim === "" ? "" : ` ${reclaim}`} Verify ok covers the integrity of what was written; it does not mean the run finished.`,
  ];
}

/** What the reclaim receipt says about the sandboxes this run journaled, or what to run. */
async function reclaimState(runPaths: PreparedRunArtifactPaths, runId: string): Promise<string> {
  const journal = await readRunTextIfExists(runPaths, SANDBOX_RECEIPTS_ARTIFACT);
  const journaled = new Set(
    (journal === null ? [] : parseSandboxReceipts(journal)).map((receipt) => receipt.sandboxId),
  );
  const receipt = await readRunJsonIfExists(runPaths, RECLAIM_RECEIPT_ARTIFACT);
  const outcomes = reclaimOutcomes(receipt, runId);
  if (outcomes !== undefined) {
    const gone = outcomes.filter((outcome) => GONE_STATES.has(outcome.state)).length;
    const reclaimed = new Set(outcomes.map((outcome) => outcome.sandboxId));
    const missing = [...journaled].filter((id) => !reclaimed.has(id)).length;
    return `${RECLAIM_RECEIPT_ARTIFACT} records ${gone} of ${outcomes.length} sandboxes gone${
      missing === 0 ? "" : `, and ${missing} journaled sandboxes are not in it`
    }.`;
  }
  if (journaled.size === 0) return "";
  return `It has no ${RECLAIM_RECEIPT_ARTIFACT}; \`humanish reclaim --run ${runId}\` stops the ${journaled.size} sandboxes it journaled.`;
}

/** The outcomes of a reclaim receipt written for this run, or undefined when there is none. */
function reclaimOutcomes(
  receipt: unknown,
  runId: string,
): { sandboxId: string; state: string }[] | undefined {
  if (!isRecord(receipt) || receipt.runId !== runId || !Array.isArray(receipt.outcomes))
    return undefined;
  const outcomes: { sandboxId: string; state: string }[] = [];
  for (const outcome of receipt.outcomes as unknown[]) {
    if (!isRecord(outcome)) return undefined;
    const { sandboxId, state } = outcome;
    if (typeof sandboxId !== "string" || typeof state !== "string") return undefined;
    outcomes.push({ sandboxId, state });
  }
  return outcomes;
}
