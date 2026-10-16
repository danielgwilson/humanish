import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  BROWSER_NETWORK_GAPS,
  BROWSER_NETWORK_SCHEMA,
  isIsoTime,
  networkLogPath,
  networkRecordProblem,
  type BrowserNetworkIndex,
} from "../evidence/browser-network.js";
import { REDACTION_MARKERS } from "../evidence/redaction.js";
import { originKeepsNoWithheldLabel, pageProblem } from "../evidence/trace-page.js";
import type { RunBundle } from "../run/bundle.js";
import {
  readContainedRegularFile,
  refusalText,
  RUN_ARTIFACT_MAX_BYTES,
} from "../run/contained-output.js";
import { boundJsonLines } from "../run/live-items.js";
import { streamParticipantIdOf } from "../run/participant-records.js";
import type { PreparedRunArtifactPaths } from "../run/paths.js";
import { isNonNegativeSafeInteger, isRecord } from "../run/type-guards.js";

// A participant's browser network log is a public-safety surface: a header, a cookie or a query
// string in it would have no shape the text scan matches. So verify reads each log a stream index
// names, binds it to the index as a live file is bound, and holds every record to the schema the
// writer holds it to. A file under network/ that no index names was not written by humanish.

const NETWORK_FOLDER = "network";
const RECORD = { one: "a record", many: "records" };
/** The record findings one file reports by line; the rest are counted in one more finding. */
const LINE_FINDINGS = 10;

/** Every key of the index type, so a key added to the type is one verify admits. */
const INDEX_KEYS: ReadonlySet<string> = new Set(
  Object.keys({
    schema: true,
    path: true,
    records: true,
    failed: true,
    pending: true,
    bytes: true,
    sha256: true,
    startedAt: true,
    origins: true,
    complete: true,
    reason: true,
    omitted: true,
  } satisfies Record<keyof BrowserNetworkIndex, true>),
);
const REASONS: ReadonlySet<unknown> = new Set(BROWSER_NETWORK_GAPS);

/** What is wrong with a stream's network index, or undefined when it has the schema's shape. */
function networkIndexProblem(index: unknown): string | undefined {
  if (!isRecord(index)) return "is not an object";
  if (Object.keys(index).some((key) => !INDEX_KEYS.has(key))) return "has a key outside the schema";
  if (index.schema !== BROWSER_NETWORK_SCHEMA) return `is not ${BROWSER_NETWORK_SCHEMA}`;
  const file = [index.records, index.failed, index.pending, index.bytes, index.sha256];
  if (index.path === undefined) {
    if (file.some((value) => value !== undefined)) return "binds a file it gives no path for";
  } else if (
    typeof index.path !== "string" ||
    !isNonNegativeSafeInteger(index.records) ||
    !isNonNegativeSafeInteger(index.failed) ||
    !isNonNegativeSafeInteger(index.pending) ||
    !isNonNegativeSafeInteger(index.bytes) ||
    typeof index.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(index.sha256)
  )
    return "names a file without its record, failed and pending counts, byte count and sha256";
  if (index.startedAt !== undefined && !isIsoTime(index.startedAt))
    return "has a start time that is not an ISO time";
  if (
    !Array.isArray(index.origins) ||
    index.origins.some(
      (origin) =>
        pageProblem({ origin, path: "" }) !== undefined ||
        !originKeepsNoWithheldLabel(String(origin)),
    )
  )
    return "has an origin that is not an origin alone, or a host label the trace page rule withholds";
  if (typeof index.complete !== "boolean") return "does not say whether it is complete";
  if (index.complete ? index.reason !== undefined : !REASONS.has(index.reason))
    return "has a reason that does not match whether it is complete";
  const { omitted } = index;
  if (
    !isRecord(omitted) ||
    Object.keys(omitted).length !== 3 ||
    !isNonNegativeSafeInteger(omitted.otherOrigin) ||
    !isNonNegativeSafeInteger(omitted.overCap) ||
    !isNonNegativeSafeInteger(omitted.invalid)
  )
    return "does not count what it left out as otherOrigin, overCap and invalid";
  return undefined;
}

/**
 * One finding per problem with the run's browser network logs: a stream index without the
 * schema's shape or naming a file other than network/<its participant id>.ndjson, a file that is
 * missing, unreadable or does not match its index's byte count, sha256 and record count, a record
 * outside the schema or on an origin its index does not list, and a file under network/ that no
 * index names. Each finding names the file and the line, never what the line holds.
 */
export async function networkFindings(
  bundle: RunBundle,
  runPaths: PreparedRunArtifactPaths,
): Promise<string[]> {
  const findings: string[] = [];
  const named = new Set<string>();
  for (const stream of bundle.streams) {
    const index: unknown = stream.network;
    if (index === undefined) continue;
    const problem = networkIndexProblem(index);
    if (problem !== undefined) {
      findings.push(`${stream.id} network index ${problem}`);
      continue;
    }
    if (!isRecord(index) || typeof index.path !== "string") continue;
    named.add(index.path);
    const participantId = streamParticipantIdOf(stream);
    if (participantId === undefined || index.path !== networkLogPath(participantId)) {
      findings.push(`${stream.id} network index path is not network/<its participant id>.ndjson`);
      continue;
    }
    findings.push(
      ...(await fileFindings(runPaths, {
        path: index.path,
        origins: new Set(Array.isArray(index.origins) ? index.origins : []),
        lines: Number(index.records),
        failed: Number(index.failed),
        pending: Number(index.pending),
        bytes: Number(index.bytes),
        sha256: String(index.sha256),
      })),
    );
  }
  // No folder means no file to name; one the walk cannot list is unscanned there.
  const listed = await readdir(path.join(runPaths.physicalRunRoot, NETWORK_FOLDER)).catch(
    (): string[] => [],
  );
  for (const name of listed.toSorted((left, right) => left.localeCompare(right))) {
    const file = `${NETWORK_FOLDER}/${name}`;
    if (!named.has(file)) findings.push(`${file} is under network/ and no stream index names it`);
  }
  return findings;
}

/**
 * The findings for one indexed log: its read and binding, its records by line, each record's
 * origin against the index's, then its failed and pending counts against the index's, which a
 * reader such as the Observer shows unchecked. A record's origin can also be the marker tracePage
 * writes for a page withheld whole.
 */
async function fileFindings(
  runPaths: PreparedRunArtifactPaths,
  index: {
    path: string;
    origins: ReadonlySet<unknown>;
    lines: number;
    failed: number;
    pending: number;
    bytes: number;
    sha256: string;
  },
): Promise<string[]> {
  const read = await readContainedRegularFile(runPaths, index.path, RUN_ARTIFACT_MAX_BYTES);
  if (read.status === "missing") return [`${index.path} is missing`];
  if (read.status === "refused") return [refusalText(index.path, read)];
  const bound = boundJsonLines(read.bytes, index, RECORD);
  if ("refused" in bound) return [bound.refused];
  const findings: string[] = [];
  let more = 0;
  const counted = { failed: 0, pending: 0 };
  bound.lines.forEach((record, at) => {
    if (isRecord(record) && record.failed !== undefined) counted.failed += 1;
    if (isRecord(record) && record.pending !== undefined) counted.pending += 1;
    const problem =
      networkRecordProblem(record) ??
      (isRecord(record) &&
      !index.origins.has(record.origin) &&
      record.origin !== REDACTION_MARKERS.urlPart
        ? "has an origin its index does not list"
        : undefined);
    if (problem === undefined) return;
    if (findings.length < LINE_FINDINGS) findings.push(`${index.path} line ${at + 1} ${problem}`);
    else more += 1;
  });
  if (more > 0) findings.push(`${index.path} has ${more} more lines outside the schema`);
  for (const key of ["failed", "pending"] as const)
    if (counted[key] !== index[key])
      findings.push(
        `${index.path} holds ${counted[key]} ${key} records where its index says ${index[key]}`,
      );
  return findings;
}
