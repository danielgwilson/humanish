// A remote run's record in its run directory here: where the run executes and whether its evidence
// is still on its runner. `humanish run` writes it when it creates the runner (src/remote/launch.ts)
// and the copy back rewrites it (src/remote/copy-back.ts). Everything that reads it calls
// readRemoteRecord, so a listing, reattach, prune and verify read one file by one rule.

import { RECLAIM_RECEIPT_ARTIFACT } from "./reclaim-outcomes.js";
import { isSandboxProviderId, type SandboxProviderId } from "./sandbox-receipts.js";
import { isRecord } from "./type-guards.js";

/** The file, relative to the run directory. */
export const REMOTE_RECORD_FILE = "remote.json";

export const REMOTE_RECORD_SCHEMA = "humanish.remote-run.v1";

/** What a record says about where its run executes, each fact only when it can be read. */
interface RemoteRecordFacts {
  provider?: SandboxProviderId;
  /** `computer-use` or `terminal`; a record written before the field has none. */
  route?: string;
  /** When the runner sandbox's time limit ends, as an ISO time. */
  deadline?: string;
  /** When this machine wrote the record, as an ISO time; a record written before the field has none. */
  startedAt?: string;
}

/**
 * A run's remote record. `none`: no remote.json here (a local run), or one this version cannot
 * read. `pending`: its evidence is still on its runner, so the run is there or its copy has not
 * finished. `copied`: the record does not say a copy is pending, so the copy finished or gave up,
 * and `lostInCopy` lists the recordings that never arrived. A record written before copyPending
 * existed reads as copied too, so a caller that needs the bundle also looks for run.json.
 */
export type RemoteRecordReading =
  | { state: "none" }
  | ({ state: "pending" } & RemoteRecordFacts)
  | ({ state: "copied"; lostInCopy: string[] } & RemoteRecordFacts);

/**
 * remote.json's text, or undefined when the run directory has none, as its reading. It never
 * throws. A record with no `schema` is read as this one, since the tests of its writers write it
 * that way; a record that names another schema is none.
 */
export function readRemoteRecord(text: string | undefined): RemoteRecordReading {
  if (text === undefined) return { state: "none" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "none" };
  }
  if (!isRecord(value) || (value.schema !== undefined && value.schema !== REMOTE_RECORD_SCHEMA))
    return { state: "none" };
  const facts: RemoteRecordFacts = {
    ...(typeof value.provider === "string" && isSandboxProviderId(value.provider)
      ? { provider: value.provider }
      : {}),
    ...(typeof value.route === "string" ? { route: value.route } : {}),
    ...readableTime("deadline", value.deadline),
    ...readableTime("startedAt", value.startedAt),
  };
  if (value.copyPending === true) return { state: "pending", ...facts };
  const lost = Array.isArray(value.lostInCopy) ? (value.lostInCopy as unknown[]) : [];
  return {
    state: "copied",
    lostInCopy: lost.filter((entry): entry is string => typeof entry === "string"),
    ...facts,
  };
}

/** A run whose remote record says its evidence is still on its runner. */
export interface RunOnRunner {
  record: Extract<RemoteRecordReading, { state: "pending" }>;
  /**
   * A reclaim receipt is in the run's directory. `humanish reclaim --run` stops the runner and
   * leaves remote.json as it was, so the record alone would still say pending.
   */
  reclaimed: boolean;
}

/**
 * The run on its runner that a run directory with no run.json holds, or undefined when its
 * remote record does not say a copy is pending. `read` gives a file's text, or undefined when the
 * directory has none; each caller reads with its own file access. The reclaim receipt is read
 * only for a pending record, so a local run costs one read of a missing remote.json.
 */
export async function readRunOnRunner(
  read: (file: string) => Promise<string | undefined>,
): Promise<RunOnRunner | undefined> {
  const record = readRemoteRecord(await read(REMOTE_RECORD_FILE));
  if (record.state !== "pending") return undefined;
  return { record, reclaimed: (await read(RECLAIM_RECEIPT_ARTIFACT)) !== undefined };
}

function readableTime<K extends "deadline" | "startedAt">(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? ({ [key]: value } as Record<K, string>)
    : {};
}
