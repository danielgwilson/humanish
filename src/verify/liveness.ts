// `humanish verify`'s RUN_NOT_FINISHED warning and the unfinished-run facts its one-line output
// leads with. Verify checks the integrity of what a run wrote, and a run killed mid-way leaves an
// in-progress bundle that passes those checks. The warning says what verify saw on disk, so
// `ok: true` is not read as "the run finished" or "its sandboxes stopped". It never flips `ok`.

import { sandboxIdDigest } from "../evidence/redaction.js";
import path from "node:path";

import type { RunBundle } from "../run/bundle.js";
import { refusalText } from "../run/contained-output.js";
import { readRunJsonIfExists, readRunTextIfExists, runJsonValue } from "../run/locate.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { isRecord } from "../run/type-guards.js";
import { RECLAIM_RECEIPT_ARTIFACT } from "../run/reclaim.js";
import { runLiveness, type RunLivenessBasis, type RunLivenessReading } from "../run/liveness.js";
import { parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "../run/sandbox-receipts.js";
import { RUN_STATUS_FILE } from "../run/status.js";
import { simulationInProgress } from "../run/streams.js";
import { plural } from "../run/text.js";
import { cli } from "../cli/invocation.js";

/** The stable code every RUN_NOT_FINISHED warning starts with. */
const RUN_NOT_FINISHED = "RUN_NOT_FINISHED";

const GONE_STATES = new Set(["killed", "already-gone"]);

/** What verify can say about a run that is not finished. */
export interface UnfinishedRun {
  liveness: "running" | "interrupted";
  /** Why it reads so (runLiveness): a recorded state, a fresh or stopped heartbeat, or the bundle. */
  basis: RunLivenessBasis;
  /**
   * clean: the run's reclaim receipt records every sandbox gone and a finished search of E2B by
   * the run's tags. unconfirmed: it records a sandbox not confirmed gone, or the run journaled one
   * it does not cover. unknown: there is no reclaim receipt, or it records no finished tag search
   * (written by humanish 0.110.0 or earlier, or by a reclaim that did not finish), so a sandbox whose
   * id never reached a receipt could still run.
   */
  sandboxes: "clean" | "unconfirmed" | "unknown";
}

/**
 * One warning, and the unfinished-run facts, when the run is not finished, by the run index's
 * rule: its bundle outcome first, then usable status, then the bundle's simulations. Nothing
 * for a finished run.
 */
export async function runNotFinished(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
  nowMs: number = Date.now(),
): Promise<{ warnings: string[]; unfinished?: UnfinishedRun }> {
  const runId = path.basename(runPaths.absoluteRunRoot);
  // A status.json it refuses is no usable status, as a missing one is: the bundle decides.
  const status = runJsonValue(await readRunJsonIfExists(runPaths, RUN_STATUS_FILE));
  const reading = runLiveness(runId, status, bundle, nowMs);
  if (reading.liveness === "finished") return { warnings: [] };

  // Counted the way review and analyze count them, so the three name the same number for a run.
  const unended = bundle.streams.filter((stream) => simulationInProgress(stream.status)).length;
  const seen = [
    whatTheFilesSay(reading, bundle),
    `${unended} of ${bundle.streams.length} streams have not ended`,
  ];

  const reclaim = await reclaimState(runPaths, runId);
  return {
    warnings: [
      `${RUN_NOT_FINISHED}: ${seen.join("; ")}. ${reclaim.text} Verify ok covers the integrity of what was written; it does not mean the run finished.`,
    ],
    unfinished: { liveness: reading.liveness, basis: reading.basis, sandboxes: reclaim.sandboxes },
  };
}

/** What verify saw on disk that makes the run read as running or interrupted, by its basis. */
function whatTheFilesSay(
  reading: Exclude<RunLivenessReading, { liveness: "finished" }>,
  bundle: RunBundle,
): string {
  switch (reading.basis) {
    case "outcome":
      return `run.json records interruption by ${reading.outcome.signal} at ${reading.outcome.at}`;
    case "status":
      return `${RUN_STATUS_FILE} state is interrupted${reading.record.signal === undefined ? "" : ` by ${reading.record.signal}`} at ${reading.record.updatedAt}`;
    case "heartbeat":
      return `${RUN_STATUS_FILE} state is running and its owner updated it at ${reading.record.updatedAt}, so the run may still be writing`;
    case "stale-heartbeat":
      return `${RUN_STATUS_FILE} state is running and its owner stopped updating it at ${reading.record.updatedAt}`;
    case "bundle": {
      const unended = bundle.simulations.filter((simulation) =>
        simulationInProgress(simulation.status),
      ).length;
      return `the run has no usable ${RUN_STATUS_FILE} and ${unended} of ${bundle.simulations.length} simulations have not ended`;
    }
  }
}

/** What the reclaim receipt says about this run's sandboxes, and what to run. */
async function reclaimState(
  runPaths: PreparedRunArtifactPaths,
  runId: string,
): Promise<{ sandboxes: UnfinishedRun["sandboxes"]; text: string }> {
  const journal = await readRunTextIfExists(runPaths, SANDBOX_RECEIPTS_ARTIFACT);
  const command = `\`${cli(`reclaim --run ${runId}`)}\``;
  // A journal it cannot read hides which sandboxes the run made, so no receipt can cover them.
  if (journal.status === "refused")
    return {
      sandboxes: "unconfirmed",
      text: `Sandboxes unconfirmed: ${refusalText(SANDBOX_RECEIPTS_ARTIFACT, journal)}, so the sandboxes it journaled are not known; check the file, then run ${command}.`,
    };
  // Matched by digest: a reclaim receipt names each sandbox by digest, and one written before it
  // did holds the raw id, which is digested here.
  const journaled = new Set(
    (journal.status === "missing" ? [] : parseSandboxReceipts(journal.text)).map((receipt) =>
      sandboxIdDigest(receipt.sandboxId),
    ),
  );
  const receiptRead = await readRunJsonIfExists(runPaths, RECLAIM_RECEIPT_ARTIFACT);
  if (receiptRead.status === "refused")
    return {
      sandboxes: "unknown",
      text: `Sandboxes unknown: ${refusalText(RECLAIM_RECEIPT_ARTIFACT, receiptRead)}, and the run journaled ${plural(journaled.size, "sandbox", "sandboxes")}; check the file, then run ${command}.`,
    };
  const receipt = reclaimReceipt(runJsonValue(receiptRead), runId);
  if (receipt === undefined)
    return {
      sandboxes: "unknown",
      text: `Sandboxes unknown: it has no ${RECLAIM_RECEIPT_ARTIFACT} and journaled ${plural(journaled.size, "sandbox", "sandboxes")}; ${command} stops those and searches E2B by this run's tags for any whose id never reached a receipt.`,
    };
  const { outcomes } = receipt;
  const gone = outcomes.filter((outcome) => GONE_STATES.has(outcome.state)).length;
  const reclaimed = new Set(outcomes.map((outcome) => outcome.digest));
  const missing = [...journaled].filter((id) => !reclaimed.has(id)).length;
  const recorded = `${RECLAIM_RECEIPT_ARTIFACT} records ${gone} of ${outcomes.length} sandboxes gone${
    missing === 0 ? "" : `, and ${missing} journaled sandboxes are not in it`
  }`;
  if (gone < outcomes.length || missing > 0)
    return {
      sandboxes: "unconfirmed",
      text: `Sandboxes unconfirmed: ${recorded}; ${command} retries.`,
    };
  if (receipt.state === "clean")
    return {
      sandboxes: "clean",
      text: `Sandboxes clean: ${recorded}, and E2B listed none still tagged with this run.`,
    };
  return {
    sandboxes: "unknown",
    text: `Sandboxes unknown: ${recorded}, but it records no finished search of E2B by this run's tags; ${command} searches.`,
  };
}

/** A reclaim receipt written for this run, or undefined when there is none. */
function reclaimReceipt(
  receipt: unknown,
  runId: string,
): { state?: string; outcomes: { digest: string; state: string }[] } | undefined {
  if (!isRecord(receipt) || receipt.runId !== runId || !Array.isArray(receipt.outcomes))
    return undefined;
  const outcomes: { digest: string; state: string }[] = [];
  for (const outcome of receipt.outcomes as unknown[]) {
    if (!isRecord(outcome)) return undefined;
    const { sandboxId, sandboxIdDigest: recorded, state } = outcome;
    if (typeof sandboxId !== "string" || typeof state !== "string") return undefined;
    const digest = typeof recorded === "string" ? recorded : sandboxIdDigest(sandboxId);
    outcomes.push({ digest, state });
  }
  return typeof receipt.state === "string" ? { state: receipt.state, outcomes } : { outcomes };
}
