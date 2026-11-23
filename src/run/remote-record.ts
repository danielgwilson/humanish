// A remote run's record in its run directory here: where the run executes and whether its evidence
// is still on its runner. `humanish run` writes it when it creates the runner (src/remote/launch.ts)
// and the copy back rewrites it (src/remote/copy-back.ts), keeping every key it read. Every reader
// of what it says calls readRemoteRecord, so a listing, reattach, prune and verify read one file by
// one rule.

import { RECLAIM_RECEIPT_ARTIFACT, reclaimReceipt, sandboxGone } from "./reclaim-receipt.js";
import { isSandboxProviderId, type SandboxProviderId } from "./sandbox-receipts.js";
import { studyFields, studyProvenanceOf, type RunStudyProvenance } from "./study-provenance.js";
import { isIsoTime, isRecord } from "./type-guards.js";

/** The file, relative to the run directory. */
export const REMOTE_RECORD_FILE = "remote.json";

const REMOTE_RECORD_SCHEMA = "humanish.remote-run.v1";

/** What a record says about where its run executes, each fact only when it can be read. */
interface RemoteRecordFacts {
  provider?: SandboxProviderId;
  /** `computer-use` or `terminal`; a record written before the field has none. */
  route?: string;
  /** When the runner sandbox's time limit ends, as an ISO time. */
  deadline?: string;
  /** When this machine wrote the record, as an ISO time; a record written before the field has none. */
  startedAt?: string;
  /**
   * The study file the run came from, so a listing can place the run under its study before its
   * own records are copied back. A record written before the field has none.
   */
  study?: RunStudyProvenance;
}

/**
 * The record `humanish run` writes once it has created the runner: where the run executes, when
 * the runner's time limit ends, and that its evidence is still to be copied back.
 */
export function pendingRemoteRecord(run: {
  runId: string;
  provider: SandboxProviderId;
  route: string;
  deadline: string;
  startedAt: string;
  study?: RunStudyProvenance | undefined;
}): Record<string, unknown> {
  return {
    schema: REMOTE_RECORD_SCHEMA,
    runId: run.runId,
    provider: run.provider,
    route: run.route,
    deadline: run.deadline,
    // Until every file has arrived; `humanish observe` finishes the copy while this is set.
    copyPending: true,
    startedAt: run.startedAt,
    ...studyFields(run.study),
  };
}

/**
 * A run's remote record. `none`: no remote.json here, as for a local run. `unreadable`: a
 * remote.json this version cannot read: not JSON, not an object, or another schema. It may be
 * the only pointer to a runner that a newer version wrote, so a caller that deletes keeps it.
 * `pending`: its evidence is still on its runner, so the run is there or its copy has not
 * finished. `copied`: the record does not say a copy is pending, so the copy finished or gave up,
 * and `lostInCopy` lists the recordings that never arrived. A record written before copyPending
 * existed reads as copied too, so a caller that needs the bundle also looks for run.json.
 */
export type RemoteRecordReading =
  | { state: "none" }
  | { state: "unreadable" }
  | ({ state: "pending" } & RemoteRecordFacts)
  | ({ state: "copied"; lostInCopy: string[] } & RemoteRecordFacts);

/**
 * remote.json's text, or undefined when the run directory has none, as its reading. It never
 * throws. A record that names another schema is unreadable, since another version may mean other
 * things by its keys. One with no `schema` is read as this one: every version writes it, so its
 * absence names no other version.
 */
export function readRemoteRecord(text: string | undefined): RemoteRecordReading {
  if (text === undefined) return { state: "none" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { state: "unreadable" };
  }
  if (!isRecord(value) || (value.schema !== undefined && value.schema !== REMOTE_RECORD_SCHEMA))
    return { state: "unreadable" };
  const facts: RemoteRecordFacts = {
    ...(typeof value.provider === "string" && isSandboxProviderId(value.provider)
      ? { provider: value.provider }
      : {}),
    ...(typeof value.route === "string" ? { route: value.route } : {}),
    ...readableTime("deadline", value.deadline),
    ...readableTime("startedAt", value.startedAt),
    ...studyFields(studyProvenanceOf({ study: value.study })),
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
   * The run's reclaim receipt records every sandbox it found gone. `humanish reclaim --run` stops
   * the runner and leaves remote.json as it was, so the record alone would still say pending.
   */
  reclaimed: boolean;
}

/**
 * The run on its runner that a run directory with no run.json holds, or undefined when its
 * remote record does not say a copy is pending. `read` gives a file's text, or undefined when the
 * directory has none; each caller reads with its own file access. The reclaim receipt is read
 * only for a pending record, so a local run costs one read of a missing remote.json.
 *
 * Reclaim writes its receipt before its first kill, so a receipt from a kill that failed, timed
 * out or was stopped is there while the runner goes on. Only a receipt for this run that records
 * at least one sandbox, every one of them gone, counts as reclaimed.
 */
export async function readRunOnRunner(
  runId: string,
  read: (file: string) => Promise<string | undefined>,
): Promise<RunOnRunner | undefined> {
  const record = readRemoteRecord(await read(REMOTE_RECORD_FILE));
  if (record.state !== "pending") return undefined;
  const receipt = reclaimReceipt(parsed(await read(RECLAIM_RECEIPT_ARTIFACT)), runId);
  const reclaimed =
    receipt !== undefined &&
    receipt.outcomes.length > 0 &&
    receipt.outcomes.every((outcome) => sandboxGone(outcome.state));
  return { record, reclaimed };
}

/** A file's JSON, or undefined when there is no file or it is not JSON. */
function parsed(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A time the writer wrote with toISOString. Date.parse alone would take "1" as the year 2001, and
 * a deadline read that way would end a run that is still going.
 */
function readableTime<K extends "deadline" | "startedAt">(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  return isIsoTime(value) ? ({ [key]: value } as Record<K, string>) : {};
}
