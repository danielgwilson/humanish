// `humanish verify`'s RUN_NOT_FINISHED warning and the unfinished-run facts its one-line output
// leads with. Verify checks the integrity of what a run wrote, and a run killed mid-way leaves an
// in-progress bundle that passes those checks. The warning says what verify saw on disk, so
// `ok: true` is not read as "the run finished" or "its sandboxes stopped". It never flips `ok`.

import { sandboxIdDigest } from "../evidence/redaction.js";
import path from "node:path";

import type { RunBundle } from "../run/bundle.js";
import { readRunJsonIfExists, readRunTextIfExists } from "../run/locate.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { isRecord } from "../run/type-guards.js";
import { RECLAIM_RECEIPT_ARTIFACT } from "../run/reclaim.js";
import { runLiveness } from "../run/run-index.js";
import { parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "../run/sandbox-receipts.js";
import { RUN_STATUS_FILE } from "../run/status.js";
import { plural } from "../run/text.js";

/** The stable code every RUN_NOT_FINISHED warning starts with. */
const RUN_NOT_FINISHED = "RUN_NOT_FINISHED";

const GONE_STATES = new Set(["killed", "already-gone"]);

/** What verify can say about a run that is not finished. */
export interface UnfinishedRun {
  liveness: "running" | "interrupted";
  /**
   * clean: the run's reclaim receipt records every sandbox gone and a finished search of E2B by
   * the run's tags. unconfirmed: it records a sandbox not confirmed gone, or the run journaled one
   * it does not cover. unknown: there is no reclaim receipt, or it records no finished tag search
   * (written by humanish 0.110 or earlier, or by a reclaim that did not finish), so a sandbox whose
   * id never reached a receipt could still run.
   */
  sandboxes: "clean" | "unconfirmed" | "unknown";
}

/**
 * One warning, and the unfinished-run facts, when the run is not finished, by the run index's
 * rule: its status record when it has a usable one, else a participant still `running` in its
 * bundle's `simulations[]`. Nothing for a finished run.
 */
export async function runNotFinished(
  runPaths: PreparedRunArtifactPaths,
  bundle: RunBundle,
  nowMs: number = Date.now(),
): Promise<{ warnings: string[]; unfinished?: UnfinishedRun }> {
  const runId = path.basename(runPaths.absoluteRunRoot);
  const status = await readRunJsonIfExists(runPaths, RUN_STATUS_FILE);
  const { liveness, record } = runLiveness(runId, status, bundle, nowMs);
  if (liveness === "finished") return { warnings: [] };

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
  } else if (record.state === "interrupted") {
    seen.push(
      `${RUN_STATUS_FILE} state is interrupted${record.signal === undefined ? "" : ` by ${record.signal}`} at ${record.updatedAt}`,
    );
  } else {
    seen.push(
      `${RUN_STATUS_FILE} state is ${record.state} and its owner stopped updating it at ${record.updatedAt}`,
    );
  }
  const runningStreams = bundle.streams.filter((stream) => stream.status === "running").length;
  seen.push(`${runningStreams} of ${bundle.streams.length} streams are still running`);

  const reclaim = await reclaimState(runPaths, runId);
  return {
    warnings: [
      `${RUN_NOT_FINISHED}: ${seen.join("; ")}. ${reclaim.text} Verify ok covers the integrity of what was written; it does not mean the run finished.`,
    ],
    unfinished: { liveness, sandboxes: reclaim.sandboxes },
  };
}

/** What the reclaim receipt says about this run's sandboxes, and what to run. */
async function reclaimState(
  runPaths: PreparedRunArtifactPaths,
  runId: string,
): Promise<{ sandboxes: UnfinishedRun["sandboxes"]; text: string }> {
  const journal = await readRunTextIfExists(runPaths, SANDBOX_RECEIPTS_ARTIFACT);
  // Matched by digest: a reclaim receipt names each sandbox by digest, and one written before it
  // did holds the raw id, which is digested here.
  const journaled = new Set(
    (journal === null ? [] : parseSandboxReceipts(journal)).map((receipt) =>
      sandboxIdDigest(receipt.sandboxId),
    ),
  );
  const command = `\`humanish reclaim --run ${runId}\``;
  const receipt = reclaimReceipt(
    await readRunJsonIfExists(runPaths, RECLAIM_RECEIPT_ARTIFACT),
    runId,
  );
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
