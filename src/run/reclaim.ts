// `humanish reclaim`: kill an interrupted run's sandboxes by the exact ids the run journaled at
// create time (sandbox-receipts.ndjson), and report what happened to each. It reads one file inside
// the managed run dir, kills by id, and never lists the account: an account-wide operation once
// destroyed unrelated infrastructure. Without it, orphaned sandboxes run until the server-side
// create-time TTL.
import {
  E2B_DEBUG_ENV,
  e2bDebugMode,
  loadE2BDesktopModule,
  type E2BDesktopModule,
} from "../substrates/e2b/sdk.js";
import {
  containedPathAbsent,
  readContainedRegularFile,
  writeContainedOutputFile,
  type PreparedOutputRoot,
} from "./contained-output.js";
import {
  discardPreflightJournal,
  listPreflightJournals,
  preflightReclaimDecision,
} from "./preflight-receipts.js";
import { resolveRunPath } from "./locate.js";
import {
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
  type ParsedSandboxReceipt,
} from "./sandbox-receipts.js";

import { destroyE2BSandbox } from "../substrates/e2b/sandbox.js";
import { redactText, toErrorMessage } from "../evidence/redaction.js";
import { runIdOf, type PreparedRunArtifactPaths } from "./paths.js";

const RECLAIM_RESULT_SCHEMA = "humanish.reclaim-result.v1";
export const RECLAIM_RECEIPT_ARTIFACT = "reclaim-receipt.json";

interface ReclaimOutcome {
  sandboxId: string;
  laneId: string;
  /** killed = kill(id) confirmed; already-gone = the server no longer knows the id (TTL or a
   *  prior cleanup got it); kill-failed = the attempt errored (the TTL backstop still applies);
   *  unsupported-provider = the receipt names a provider this version cannot reach, so nothing
   *  was attempted. */
  state: "killed" | "already-gone" | "kill-failed" | "unsupported-provider";
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
  error?: {
    code:
      | "HUMANISH_RECLAIM_RUN_NOT_FOUND"
      | "HUMANISH_RECLAIM_E2B_DEBUG"
      | "HUMANISH_RECLAIM_MODULE_UNAVAILABLE"
      | "HUMANISH_RECLAIM_RECEIPTS_UNREADABLE";
    message: string;
  };
}

export interface ReclaimHooks {
  /** Tests inject a fake @e2b/desktop module; default loads the real one. */
  loadModule?: () => Promise<E2BDesktopModule>;
  requestTimeoutMs?: number;
}

export function reclaimRunSandboxes(
  cwd: string,
  runInput: string,
  hooks: ReclaimHooks = {},
): Promise<ReclaimResult> {
  return reclaimRun(cwd, runInput, () => resolveRunPath(cwd, runInput), hooks);
}

/**
 * Reclaim the run whose directory the caller already holds. Nothing is resolved, so an id that is
 * also an alias (a run named `latest`) cannot reach another run's receipts.
 */
export function reclaimPinnedRunSandboxes(
  cwd: string,
  runPaths: PreparedRunArtifactPaths,
  hooks: ReclaimHooks = {},
): Promise<ReclaimResult> {
  return reclaimRun(cwd, runIdOf(runPaths), () => Promise.resolve(runPaths), hooks);
}

async function reclaimRun(
  cwd: string,
  runInput: string,
  locate: () => Promise<PreparedRunArtifactPaths | null>,
  hooks: ReclaimHooks,
): Promise<ReclaimResult> {
  const warnings: string[] = [];
  const base = {
    schema: RECLAIM_RESULT_SCHEMA,
    cwd,
    runId: runInput,
    receiptCount: 0,
    outcomes: [] as ReclaimOutcome[],
    warnings,
  } as const;
  if (e2bDebugMode()) return { ...base, ok: false, error: E2B_DEBUG_REFUSAL };

  const runPaths = await locate();
  if (!runPaths) {
    return {
      ...base,
      ok: false,
      error: {
        code: "HUMANISH_RECLAIM_RUN_NOT_FOUND",
        message: `No run found for "${runInput}" (use \`humanish runs\` to list runs).`,
      },
    };
  }
  const runId = runIdOf(runPaths);

  const journal = await reclaimJournal(runPaths, hooks);
  if (journal.kind === "empty") {
    // Empty: nothing journaled means either no sandbox was ever created (cheap interrupt:
    // nothing to reclaim) or the run predates receipts (0.35.x and earlier, where the create-time TTL
    // is the only backstop for those). Either way there is no id to act on, and saying so beats
    // pretending a scan happened.
    warnings.push(
      "No sandbox-receipts.ndjson in this run dir: either no sandbox was created before the interrupt, or the run predates create-time receipts. Nothing to reclaim by id; server-side kill-on-timeout covers anything that did exist.",
    );
    return { ...base, runId, ok: true };
  }
  if (journal.kind === "module-unavailable") {
    return {
      ...base,
      runId,
      receiptCount: journal.receiptCount,
      ok: false,
      error: { code: "HUMANISH_RECLAIM_MODULE_UNAVAILABLE", message: journal.message },
    };
  }
  if (journal.kind === "unreadable") {
    return {
      ...base,
      runId,
      ok: false,
      error: { code: "HUMANISH_RECLAIM_RECEIPTS_UNREADABLE", message: UNREADABLE_MESSAGE },
    };
  }

  const { receiptCount, outcomes } = journal;
  const result: ReclaimResult = { ...base, runId, receiptCount, outcomes, ok: allGone(outcomes) };
  // Keep the reclaim record next to the run it cleaned: what was attempted, what happened, when.
  await writeReclaimReceipt(runPaths, runId, receiptCount, outcomes, warnings);
  return result;
}

/**
 * Kill the sandboxes left by interrupted `humanish study check` probes. A probe journals under
 * .humanish/preflight/<probe-id>/ and removes the journal after a confirmed kill, so what is left
 * belongs to a probe that died or could not confirm its teardown. A journal whose probe may still
 * be running is left alone with the reason (see preflightReclaimDecision).
 */
export async function reclaimPreflightSandboxes(
  cwd: string,
  hooks: ReclaimHooks = {},
): Promise<ReclaimResult> {
  const warnings: string[] = [];
  const outcomes: ReclaimOutcome[] = [];
  let receiptCount = 0;
  let unreadable = false;
  const base = { schema: RECLAIM_RESULT_SCHEMA, cwd, runId: "preflight", warnings } as const;
  if (e2bDebugMode())
    return { ...base, ok: false, receiptCount, outcomes, error: E2B_DEBUG_REFUSAL };
  const journals = await listPreflightJournals(cwd);
  if (journals.length === 0) {
    warnings.push(
      "No preflight journals in .humanish/preflight: every probe's teardown was confirmed, or no probe ran here. Nothing to reclaim by id.",
    );
  }
  for (const journal of journals) {
    const decision = await preflightReclaimDecision(journal, Date.now());
    if (!decision.reclaim) {
      warnings.push(`Preflight ${journal.id} left alone: ${decision.reason}.`);
      continue;
    }
    const reclaimed = await reclaimJournal(journal.root, hooks);
    if (reclaimed.kind === "unreadable") {
      // The receipt may name a live sandbox; the journal stays for a later reclaim.
      unreadable = true;
      warnings.push(`Preflight ${journal.id} left alone: ${UNREADABLE_MESSAGE}`);
      continue;
    }
    if (reclaimed.kind === "module-unavailable") {
      return {
        ...base,
        ok: false,
        receiptCount: receiptCount + reclaimed.receiptCount,
        outcomes,
        error: { code: "HUMANISH_RECLAIM_MODULE_UNAVAILABLE", message: reclaimed.message },
      };
    }
    if (reclaimed.kind === "done") {
      receiptCount += reclaimed.receiptCount;
      outcomes.push(...reclaimed.outcomes);
      if (!allGone(reclaimed.outcomes)) {
        // The journal stays so a later reclaim can try again; the receipt says what happened.
        await writeReclaimReceipt(
          journal.root,
          journal.id,
          reclaimed.receiptCount,
          reclaimed.outcomes,
          warnings,
        );
        continue;
      }
    }
    await discardPreflightJournal(journal, [RECLAIM_RECEIPT_ARTIFACT]).catch((error: unknown) => {
      warnings.push(
        `Preflight ${journal.id} was reclaimed but its journal could not be removed: ${redactText(toErrorMessage(error))}`,
      );
    });
  }
  return { ...base, ok: !unreadable && allGone(outcomes), receiptCount, outcomes };
}

// In debug mode the SDK returns true from Sandbox.kill without contacting E2B, so every receipt
// would read killed and preflight journals would be discarded for sandboxes that may still run.
const E2B_DEBUG_REFUSAL = {
  code: "HUMANISH_RECLAIM_E2B_DEBUG",
  message: `${E2B_DEBUG_ENV}=true puts the E2B SDK in debug mode, where Sandbox.kill reports success without contacting E2B. Nothing was killed and the receipts were kept; unset ${E2B_DEBUG_ENV} and run reclaim again.`,
} as const;

const UNREADABLE_MESSAGE =
  "sandbox-receipts.ndjson is present but could not be read safely (not a single regular file, or a read error). Nothing was killed and the receipts were kept; check the file, then run reclaim again.";

type JournalReclaim =
  | { kind: "empty" }
  | { kind: "unreadable" }
  | { kind: "module-unavailable"; receiptCount: number; message: string }
  | { kind: "done"; receiptCount: number; outcomes: ReclaimOutcome[] };

/** Kill every sandbox one receipts journal records, once per sandbox, by exact id. */
async function reclaimJournal(
  root: PreparedOutputRoot,
  hooks: ReclaimHooks,
): Promise<JournalReclaim> {
  const bytes = await readContainedRegularFile(root, SANDBOX_RECEIPTS_ARTIFACT);
  if (bytes === null)
    return (await containedPathAbsent(root, SANDBOX_RECEIPTS_ARTIFACT))
      ? { kind: "empty" }
      : { kind: "unreadable" };

  const receipts = parseSandboxReceipts(bytes.toString("utf8"));
  // Load the E2B SDK only when an E2B receipt needs it.
  let e2b: E2BDesktopModule | undefined;
  try {
    if (receipts.some((receipt) => receipt.provider === "e2b"))
      e2b = await (hooks.loadModule ?? loadE2BDesktopModule)();
  } catch (error) {
    return {
      kind: "module-unavailable",
      receiptCount: receipts.length,
      message: `Cannot load @e2b/desktop to kill by id: ${redactText(toErrorMessage(error))}`,
    };
  }

  const requestTimeoutMs = hooks.requestTimeoutMs ?? 60_000;
  const destroy = async (receipt: ParsedSandboxReceipt) => {
    switch (receipt.provider) {
      case "e2b":
        return destroyE2BSandbox(e2b!, receipt.sandboxId, { requestTimeoutMs });
      default:
        return {
          state: "unsupported-provider" as const,
          detail: `provider ${JSON.stringify(receipt.provider)} is not supported by this humanish version; nothing was attempted, and that provider's own timeout is the backstop`,
        };
    }
  };
  const outcomes: ReclaimOutcome[] = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    // One attempt per sandbox, however many receipts raced.
    const key = JSON.stringify([receipt.provider, receipt.sandboxId]);
    if (seen.has(key)) continue;
    seen.add(key);
    outcomes.push({
      sandboxId: receipt.sandboxId,
      laneId: receipt.laneId,
      ...(await destroy(receipt)),
    });
  }
  return { kind: "done", receiptCount: receipts.length, outcomes };
}

function allGone(outcomes: readonly ReclaimOutcome[]): boolean {
  return outcomes.every(
    (outcome) => outcome.state === "killed" || outcome.state === "already-gone",
  );
}

async function writeReclaimReceipt(
  root: PreparedOutputRoot,
  runId: string,
  receiptCount: number,
  outcomes: readonly ReclaimOutcome[],
  warnings: string[],
): Promise<void> {
  try {
    await writeContainedOutputFile(
      root,
      RECLAIM_RECEIPT_ARTIFACT,
      `${JSON.stringify({ schema: RECLAIM_RESULT_SCHEMA, at: new Date().toISOString(), runId, receiptCount, outcomes }, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    warnings.push(
      `Reclaim ran but its receipt could not be written: ${redactText(toErrorMessage(error))}`,
    );
  }
}
