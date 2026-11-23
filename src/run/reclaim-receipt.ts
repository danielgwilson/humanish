// What a run directory's reclaim-receipt.json says, read without the provider code that writes it
// (src/run/reclaim-outcomes.ts), so a listing can ask whether a reclaim stopped a run's sandboxes
// without loading a provider SDK. Reclaim, verify and the remote record read it by these rules.

import { sandboxIdDigest } from "../evidence/redaction.js";
import { isRecord } from "./type-guards.js";

/** The file, relative to the run directory. */
export const RECLAIM_RECEIPT_ARTIFACT = "reclaim-receipt.json";

/** Whether a recorded outcome confirms its sandbox gone: killed, or no longer known to its provider. */
export function sandboxGone(state: string): boolean {
  return state === "killed" || state === "already-gone";
}

/**
 * A reclaim receipt written for this run, with each outcome's sandbox by digest, or undefined
 * when it names another run or is not a receipt. A receipt from before receipts named sandboxes by
 * digest holds the raw id, which is digested here.
 */
export function reclaimReceipt(
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
