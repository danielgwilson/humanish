// `humanish reclaim` (#358 salvage tier): kill an interrupted run's sandboxes by the EXACT ids the
// run journaled at create time (sandbox-receipts.ndjson), and say honestly what happened to each.
// The lane loop lives in the operator's local process, so a sleeping laptop or a crash orphans
// every sandbox with the ids trapped in dead memory; before this command the only remedies were
// the server-side create-time TTL (slow, spend keeps burning) or account enumeration (which this
// codebase never does — an account-wide operation once destroyed unrelated infrastructure). This
// reads one file inside the managed run dir, kills by id, and never lists anything.
import { loadE2BDesktopModule, type E2BDesktopModule } from "./e2b-desktop-launch.js";
import { readContainedRegularFile, writeContainedOutputFile } from "./selected-output-paths.js";
import { resolveRunPath } from "./run.js";
import { parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "./sandbox-receipts.js";
import path from "node:path";

import { toErrorMessage } from "./command-failure.js";
import { redactText } from "./redaction.js";

export const RECLAIM_RESULT_SCHEMA = "humanish.reclaim-result.v1";
export const RECLAIM_RECEIPT_ARTIFACT = "reclaim-receipt.json";

export interface ReclaimOutcome {
  sandboxId: string;
  laneId: string;
  /** killed = kill(id) confirmed; already-gone = the server no longer knows the id (TTL or a
   *  prior cleanup got it); kill-failed = the attempt errored (the TTL backstop still applies). */
  state: "killed" | "already-gone" | "kill-failed";
  detail?: string;
}

export interface ReclaimResult {
  schema: typeof RECLAIM_RESULT_SCHEMA;
  ok: boolean;
  cwd: string;
  runId: string;
  /** Receipts found in the run's journal (0 = nothing was created, or the run predates receipts). */
  receiptCount: number;
  outcomes: ReclaimOutcome[];
  warnings: string[];
  error?: { code: "HUMANISH_RECLAIM_RUN_NOT_FOUND" | "HUMANISH_RECLAIM_MODULE_UNAVAILABLE"; message: string };
}

export interface ReclaimHooks {
  /** Tests inject a fake @e2b/desktop module; default loads the real one. */
  loadModule?: () => Promise<E2BDesktopModule>;
  requestTimeoutMs?: number;
}

export async function reclaimRunSandboxes(
  cwd: string,
  runInput: string,
  hooks: ReclaimHooks = {}
): Promise<ReclaimResult> {
  const warnings: string[] = [];
  const base = { schema: RECLAIM_RESULT_SCHEMA, cwd, runId: runInput, receiptCount: 0, outcomes: [] as ReclaimOutcome[], warnings } as const;

  const runPaths = await resolveRunPath(cwd, runInput);
  if (!runPaths) {
    return {
      ...base,
      ok: false,
      error: { code: "HUMANISH_RECLAIM_RUN_NOT_FOUND", message: `No run found for "${runInput}" (use \`humanish runs\` to list runs).` }
    };
  }
  const runId = path.basename(runPaths.absoluteRunRoot);

  const bytes = await readContainedRegularFile(runPaths, SANDBOX_RECEIPTS_ARTIFACT);
  if (bytes === null) {
    // Honest empty: nothing journaled means either no sandbox was ever created (cheap interrupt —
    // nothing to reclaim) or the run predates receipts (0.35.x and earlier — the create-time TTL
    // is the only backstop for those). Either way there is no id to act on, and saying so beats
    // pretending a scan happened.
    warnings.push("No sandbox-receipts.ndjson in this run dir: either no sandbox was created before the interrupt, or the run predates create-time receipts. Nothing to reclaim by id; server-side kill-on-timeout covers anything that did exist.");
    return { ...base, runId, ok: true };
  }

  const receipts = parseSandboxReceipts(bytes.toString("utf8"));
  let sandboxModule: E2BDesktopModule;
  try {
    sandboxModule = await (hooks.loadModule ?? loadE2BDesktopModule)();
  } catch (error) {
    return {
      ...base,
      runId,
      receiptCount: receipts.length,
      ok: false,
      error: { code: "HUMANISH_RECLAIM_MODULE_UNAVAILABLE", message: `Cannot load @e2b/desktop to kill by id: ${redactText(toErrorMessage(error))}` }
    };
  }

  const requestTimeoutMs = hooks.requestTimeoutMs ?? 60_000;
  const kill = sandboxModule.Sandbox.kill;
  const outcomes: ReclaimOutcome[] = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    if (seen.has(receipt.sandboxId)) continue; // one attempt per id, however many receipts raced
    seen.add(receipt.sandboxId);
    if (typeof kill !== "function") {
      outcomes.push({ sandboxId: receipt.sandboxId, laneId: receipt.laneId, state: "kill-failed", detail: "installed @e2b/desktop SDK does not expose Sandbox.kill; server-side kill-on-timeout will reclaim the sandbox" });
      continue;
    }
    try {
      const killed = (await kill.call(sandboxModule.Sandbox, receipt.sandboxId, { requestTimeoutMs })) === true;
      outcomes.push({ sandboxId: receipt.sandboxId, laneId: receipt.laneId, state: killed ? "killed" : "already-gone" });
    } catch (error) {
      const detail = redactText(toErrorMessage(error));
      const gone = /not.?found|does not exist|404/i.test(detail);
      outcomes.push({
        sandboxId: receipt.sandboxId,
        laneId: receipt.laneId,
        state: gone ? "already-gone" : "kill-failed",
        ...(gone ? {} : { detail })
      });
    }
  }

  const ok = outcomes.every((outcome) => outcome.state !== "kill-failed");
  const result: ReclaimResult = { ...base, runId, receiptCount: receipts.length, outcomes, ok };
  // Keep the reclaim record next to the run it cleaned: what was attempted, what happened, when.
  try {
    await writeContainedOutputFile(
      runPaths,
      RECLAIM_RECEIPT_ARTIFACT,
      `${JSON.stringify({ schema: RECLAIM_RESULT_SCHEMA, at: new Date().toISOString(), runId, receiptCount: receipts.length, outcomes }, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    warnings.push(`Reclaim ran but its receipt could not be written: ${redactText(toErrorMessage(error))}`);
  }
  return result;
}
