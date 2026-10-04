// Every created sandbox id is journaled to the run dir as soon as it reaches this process: when the
// desktop startup guard reports it, or when create returns, before any work happens in it. The
// participant loop lives in the caller's local process, so a sleeping laptop, crash or kill loses
// every in-memory id; this append-only file keeps them for `humanish reclaim`, and tells verify and
// the sweep which ids to look for.
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
  /** The create-time sandbox TTL (ms), when known: how long the server-side backstop runs. */
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
 * The ids this process has receipted for each run directory, kept even when the append fails, so
 * the run's other records can still be scrubbed of them. Keyed by the directory's identity, so a
 * run created later at a deleted run's path starts empty, and only the latest runs are kept.
 */
const appended = new Map<string, Set<string>>();
const MAX_REMEMBERED_RUNS = 64;

function rootKey(root: PreparedOutputRoot): string {
  const [where, { dev, ino, birthtimeNs }] =
    "physicalRunRoot" in root
      ? [root.physicalRunRoot, root.runRootIdentity]
      : [root.physicalPath, root.identity];
  return `${where}\0${dev}:${ino}:${birthtimeNs}`;
}

/** The ids this process has receipted for `root`, whether or not the journal write landed. */
export function appendedSandboxIds(root: PreparedOutputRoot): string[] {
  return [...(appended.get(rootKey(root)) ?? [])];
}

/**
 * Append one receipt; false when the write failed. Best-effort by design: the receipt exists to
 * protect the run, so a failed receipt write must never fail the participant. The only cost of a
 * miss is that `reclaim` cannot see this id and the TTL backstop covers it instead. Containment is
 * the same prepare step every artifact write uses; append (not atomic-replace) keeps racing
 * participants' receipts intact.
 */
export async function appendSandboxReceipt(
  root: PreparedOutputRoot,
  receipt: SandboxReceipt,
): Promise<boolean> {
  const key = rootKey(root);
  const ids = appended.get(key) ?? new Set<string>();
  appended.delete(key);
  appended.set(key, ids.add(receipt.sandboxId));
  for (const oldest of appended.keys()) {
    if (appended.size <= MAX_REMEMBERED_RUNS) break;
    appended.delete(oldest);
  }
  try {
    const filePath = await prepareContainedOutputFile(root, SANDBOX_RECEIPTS_ARTIFACT);
    await appendFile(filePath, `${JSON.stringify(receipt)}\n`, "utf8");
    return true;
  } catch {
    // Swallowed on purpose; see the contract above.
    return false;
  }
}

/**
 * A line written before each create: the owner tags the sandbox is created with. It names no
 * sandbox, so parseSandboxReceipts, and every version before it existed, skip it. Reclaim searches
 * E2B with these tags, so a run directory that was copied or moved still finds its sandboxes, and
 * an empty search counts as clean only when the run recorded the tags it used.
 */
interface SandboxOwnerLine {
  at: string;
  provider: SandboxProviderId;
  owner: SandboxOwnerTags;
}

/** Append one owner line; false when the write failed, which never fails the create. */
export async function appendSandboxOwner(
  root: PreparedOutputRoot,
  owner: SandboxOwnerTags,
): Promise<boolean> {
  try {
    const line: SandboxOwnerLine = { at: new Date().toISOString(), provider: "e2b", owner };
    const filePath = await prepareContainedOutputFile(root, SANDBOX_RECEIPTS_ARTIFACT);
    // The leading newline ends a line an earlier append left torn, so this record parses.
    await appendFile(filePath, `\n${JSON.stringify(line)}\n`, "utf8");
    return true;
  } catch {
    // Never fails the create. Without the line, reclaim reports the run's sandboxes as unknown,
    // never clean, so the next create tries again.
    return false;
  }
}

/** The owner tags every sandbox carries; sandboxOwnerTags in src/run/sandbox-creates.ts. */
// A type alias, so a tag set passes where E2B metadata (a string record) is expected.
export type SandboxOwnerTags = {
  tool: "humanish";
  runId: string;
  runKey: string;
};

const RUN_KEY = /^[0-9a-f]{16}$/;

/**
 * The owner tag sets a journal's owner lines record for the run named `runId`. Only a complete
 * tuple counts: provider e2b, `tool: humanish`, this run's id and a well-formed key, and nothing
 * else. A partial or foreign line would widen reclaim's search past this run, so it is skipped.
 */
export function parseSandboxOwners(text: string, runId: string): SandboxOwnerTags[] {
  const owners = new Map<string, SandboxOwnerTags>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { provider?: unknown; owner?: unknown };
      const owner = parsed.owner as Partial<Record<keyof SandboxOwnerTags, unknown>> | null;
      if (parsed.provider !== "e2b" || owner === null || typeof owner !== "object") continue;
      if (Object.keys(owner).length !== 3 || owner.tool !== "humanish" || owner.runId !== runId)
        continue;
      if (typeof owner.runKey !== "string" || !RUN_KEY.test(owner.runKey)) continue;
      owners.set(owner.runKey, { tool: "humanish", runId, runKey: owner.runKey });
    } catch {
      // A torn line: skip it.
    }
  }
  return [...owners.values()];
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
      // A torn line: skip it.
    }
  }
  return receipts;
}
