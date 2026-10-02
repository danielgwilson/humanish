// Every created sandbox id is journaled to the run dir the moment create returns, before any work
// happens in it. The participant loop lives in the caller's local process, so a sleeping laptop, crash or
// kill loses every in-memory id; this append-only file keeps them for `humanish reclaim`.
import { appendFile } from "node:fs/promises";

import { prepareContainedOutputFile, type PreparedOutputRoot } from "./contained-output.js";

export const SANDBOX_RECEIPTS_ARTIFACT = "sandbox-receipts.ndjson";

/** The providers humanish allocates sandboxes from. Reclaim dispatches on this id. */
export type SandboxProviderId = "e2b";

export interface SandboxReceipt {
  at: string;
  /** The participant or subject label the sandbox belongs to (public-safe token). */
  laneId: string;
  /** Who allocated the sandbox. Receipts written before this field existed have none. */
  provider?: SandboxProviderId;
  sandboxId: string;
  /** The create-time sandbox TTL (ms), when known — how long the server-side backstop runs. */
  timeoutMs?: number;
}

/**
 * A receipt read back from disk. An absent provider reads as "e2b", the only provider before the
 * field existed. A receipt written by a newer humanish may name a provider this version does not
 * know, so the type keeps the raw string for reclaim to report.
 */
export interface ParsedSandboxReceipt extends Omit<SandboxReceipt, "provider"> {
  provider: string;
}

/**
 * Append one receipt. Best-effort by design: the receipt exists to protect the run, so a failed
 * receipt write must never fail the participant — the only cost of a miss is that `reclaim` cannot see
 * this id and the TTL backstop covers it instead. Containment is the same prepare step every
 * artifact write uses; append (not atomic-replace) keeps racing participants' receipts intact.
 */
export async function appendSandboxReceipt(
  root: PreparedOutputRoot,
  receipt: SandboxReceipt,
): Promise<void> {
  try {
    const filePath = await prepareContainedOutputFile(root, SANDBOX_RECEIPTS_ARTIFACT);
    await appendFile(filePath, `${JSON.stringify(receipt)}\n`, "utf8");
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

/** Parse a receipts file leniently: a torn final line (crash mid-append) drops, valid lines keep. */
export function parseSandboxReceipts(text: string): ParsedSandboxReceipt[] {
  const receipts: ParsedSandboxReceipt[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<Record<keyof SandboxReceipt, unknown>>;
      if (
        typeof parsed.sandboxId === "string" &&
        parsed.sandboxId.length > 0 &&
        typeof parsed.laneId === "string" &&
        (parsed.provider === undefined || typeof parsed.provider === "string")
      ) {
        receipts.push({
          at: typeof parsed.at === "string" ? parsed.at : "",
          laneId: parsed.laneId,
          provider: parsed.provider ?? "e2b",
          sandboxId: parsed.sandboxId,
          ...(typeof parsed.timeoutMs === "number" ? { timeoutMs: parsed.timeoutMs } : {}),
        });
      }
    } catch {
      // torn line — skip
    }
  }
  return receipts;
}
