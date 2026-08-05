// #358 salvage tier: every created sandbox id is journaled to the run dir THE MOMENT create
// returns, before any work happens in it. The lane loop lives in the caller's local process, so a
// sleeping laptop / crash / kill takes every in-memory sandbox id with it — leaving nothing to
// clean up BY ID and forcing the one thing this codebase never does (enumerate the account).
// A durable append-only receipt file makes an interrupted run reclaimable by exact recorded id:
// `humanish reclaim` reads it, kills what is still alive, and reports honestly. The server-side
// create-time TTL remains the liveness backstop either way; receipts make the cleanup PROMPT and
// the spend loss small instead of TTL-bounded.
import { appendFile } from "node:fs/promises";

import { prepareContainedOutputFile, type PreparedOutputRoot } from "./selected-output-paths.js";

export const SANDBOX_RECEIPTS_ARTIFACT = "sandbox-receipts.ndjson";

export interface SandboxReceipt {
  at: string;
  /** The lane/role/subject label the sandbox belongs to (public-safe token). */
  laneId: string;
  sandboxId: string;
  /** The create-time sandbox TTL (ms), when known — how long the server-side backstop runs. */
  timeoutMs?: number;
}

/**
 * Append one receipt. Best-effort BY DESIGN: the receipt exists to protect the run, so a failed
 * receipt write must never fail the lane — the only cost of a miss is that `reclaim` cannot see
 * this id and the TTL backstop covers it instead. Containment is the same prepare step every
 * artifact write uses; append (not atomic-replace) keeps racing lanes' receipts intact.
 */
export async function appendSandboxReceipt(root: PreparedOutputRoot, receipt: SandboxReceipt): Promise<void> {
  try {
    const filePath = await prepareContainedOutputFile(root, SANDBOX_RECEIPTS_ARTIFACT);
    await appendFile(filePath, `${JSON.stringify(receipt)}\n`, "utf8");
  } catch {
    // Swallowed on purpose — see the contract above.
  }
}

/** Parse a receipts file leniently: a torn final line (crash mid-append) drops, valid lines keep. */
export function parseSandboxReceipts(text: string): SandboxReceipt[] {
  const receipts: SandboxReceipt[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SandboxReceipt>;
      if (typeof parsed.sandboxId === "string" && parsed.sandboxId.length > 0 && typeof parsed.laneId === "string") {
        receipts.push({
          at: typeof parsed.at === "string" ? parsed.at : "",
          laneId: parsed.laneId,
          sandboxId: parsed.sandboxId,
          ...(typeof parsed.timeoutMs === "number" ? { timeoutMs: parsed.timeoutMs } : {})
        });
      }
    } catch {
      // torn line — skip
    }
  }
  return receipts;
}
