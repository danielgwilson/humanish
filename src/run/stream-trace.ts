// Where a participant's trace lives. A v1 run.json holds every stream's trace items and screenshot
// entries inline. From v2 the run writer moves them into one file per stream and leaves an index
// in run.json, so run.json stays a summary whatever the length of the sessions. From v3 a running
// participant's items so far are in a live file run.json indexes too (src/run/live-items.ts). From
// v4 the per-request lists (REQUEST_LISTS) are only in the trace file, and a running participant
// carries its totals and the estimate priced from its rows. Every reader that needs the items or
// the lists loads them here, which accepts every version and checks each file against its index.

import { createHash } from "node:crypto";

import type { ActorTrace } from "../actors/contract.js";
import {
  RUN_BUNDLE_FILE,
  RUN_BUNDLE_SCHEMA,
  RUN_BUNDLE_V2_SCHEMA,
  RUN_BUNDLE_V3_SCHEMA,
  type DisplayedRunBundle,
  type RunBundle,
  type StoredRunBundle,
} from "./bundle.js";
import { isRunBundle } from "./bundle-shape.js";
import {
  type PreparedOutputRoot,
  readContainedPrefix,
  readContainedRegularFile,
  refusalText,
  RUN_ARTIFACT_MAX_BYTES,
} from "./contained-output.js";
import {
  isLiveItemsIndex,
  LIVE_ACTOR_SCHEMA,
  LIVE_ACTOR_V1_SCHEMA,
  liveItemsAfter,
  type LiveItemsCursor,
  liveItemsFromBytes,
} from "./live-items.js";
import { estimateActorCostForExecution } from "./pricing.js";
import { isRunStreamArtifact, isStreamTraceIndex, isStreamTracePath } from "./stream-shape.js";
import type {
  DisplayedRunStream,
  LiveItemsIndex,
  RunStream,
  StoredRunStream,
  StreamTraceIndex,
  WithoutRequestLists,
} from "./streams.js";
import { isRecord } from "./type-guards.js";

type StreamArtifact = RunStream["artifacts"][number];

/**
 * A trace that does not match its index, or cannot be read. The message names the stream, and ends
 * with `advice`: by default, restore the run folder from a copy.
 */
export class StreamTraceRefusedError extends Error {
  constructor(
    readonly streamId: string,
    detail: string,
    advice = "A trace file must stay as the run wrote it; restore the run folder from a copy.",
  ) {
    super(`Participant ${streamId}'s trace was not read: ${detail}. ${advice}`);
    this.name = "StreamTraceRefusedError";
  }
}

/** Why the loader reads no trace or live file whose index records more than `maxBytes`. */
const pastLimitDetail = (index: { path: string; bytes: number }, maxBytes: number): string =>
  `run.json records ${index.path} at ${index.bytes} bytes, more than the ${maxBytes} bytes humanish reads of one file`;

/**
 * A trace or live file whose index records more than the loader reads of one file, `maxBytes`. The
 * loader reads no file past the limit, so a copy of the file is refused too.
 */
export class StreamTraceTooLargeError extends StreamTraceRefusedError {
  /** The file's run-relative path, as its index records it. */
  readonly file: string;

  constructor(streamId: string, index: { path: string; bytes: number }, maxBytes: number) {
    super(
      streamId,
      pastLimitDetail(index, maxBytes),
      "Restoring a copy does not help; open the file with another tool, such as jq, to read its items.",
    );
    this.file = index.path;
  }
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const isScreenshot = (artifact: StreamArtifact): boolean => artifact.kind === "screenshot";

/**
 * The file a trace path names on any file system. Trace file names are ASCII (isStreamTracePath),
 * so lower case folds them as a case-insensitive file system does: actors/Case.json and
 * actors/case.json are one file there.
 */
const traceFileKey = (tracePath: string): string => tracePath.toLowerCase();

/** Names of the form actors/<n>.json, which the splitter gives by position and never reuses. */
const POSITION_TRACE_FILE = /^actors\/\d+\.json$/;

/**
 * The stream's actor trace artifact (actor.json, actors/<stream>.json, actor-<surface>.json) when
 * no earlier stream claimed it (compared by traceFileKey), else actors/<position>.json. The
 * position names are a namespace of their own: an artifact named that way is not reused, so two
 * streams never get one file. Another trace artifact (the scripted route's traces/<surface>.json
 * holds its native step trace) keeps its own file.
 */
function tracePath(stream: RunStream, index: number, claimed: ReadonlySet<string>): string {
  const own = stream.artifacts.find(
    (artifact) =>
      artifact.kind === "trace" &&
      isStreamTracePath(artifact.path) &&
      !POSITION_TRACE_FILE.test(artifact.path),
  )?.path;
  return own !== undefined && !claimed.has(traceFileKey(own)) ? own : `actors/${index + 1}.json`;
}

/**
 * A participant's lists that gain one entry per model request, as paths into its actor trace. From
 * run bundle v4 run.json leaves them out of `actor` and `liveActor`, and the trace file alone holds
 * them; the Observer's data leaves them out too.
 */
const REQUEST_LISTS = ["tokenUsage.turns", "conversation.requests", "providerRequests"] as const;

type RequestList = (typeof REQUEST_LISTS)[number];

/** The value at `list`'s path in `trace`, when the object holding it is there. */
function listIn(trace: Record<string, unknown>, list: RequestList): unknown {
  const [first, second] = list.split(".") as [string, string | undefined];
  if (second === undefined) return trace[first];
  const parent = trace[first];
  return isRecord(parent) ? parent[second] : undefined;
}

/** `trace` without the per-request lists; every other field as it is. */
export function withoutRequestLists<T extends object>(trace: T): WithoutRequestLists<T> {
  const copy = { ...trace } as Record<string, unknown>;
  for (const list of REQUEST_LISTS) {
    const [first, second] = list.split(".") as [string, string | undefined];
    const parent = copy[first];
    if (second === undefined) delete copy[first];
    else if (isRecord(parent) && second in parent) {
      const { [second]: _list, ...rest } = parent;
      copy[first] = rest;
    }
  }
  return copy as WithoutRequestLists<T>;
}

/** The first per-request list `trace` holds, if any. */
function heldRequestList(trace: object): RequestList | undefined {
  return REQUEST_LISTS.find((list) => listIn(trace as Record<string, unknown>, list) !== undefined);
}

type LiveActor = NonNullable<RunStream["liveActor"]>;

/**
 * run.json's live actor: without the per-request lists, and with the estimate priced from the
 * rows it leaves out. Long-context pricing needs each request's input size, so a figure priced
 * from the totals alone could be under half the real one. A live actor read back from run.json
 * has no rows and keeps the estimate they gave.
 */
function liveSummary(live: LiveActor): WithoutRequestLists<LiveActor> {
  const summary = withoutRequestLists(live);
  const model = live.ids?.model;
  if (live.tokenUsage === undefined || typeof model !== "string") return summary;
  if (live.tokenUsage.turns === undefined && live.estimatedCost !== undefined) return summary;
  return {
    ...summary,
    estimatedCost: estimateActorCostForExecution(live.tokenUsage, model, live.executionProfile),
  };
}

/**
 * The run.json the run writes, and the trace files it writes first. Each stream with a finished
 * actor keeps that actor without `items` and the per-request lists, its artifacts other than
 * screenshots, and an index of its trace file; the file is the whole actor trace with the stream's
 * screenshot entries as `artifacts`. A stream already split (its actor read back from run.json
 * without its items) keeps its index, since its file is on disk, and loses any lists an older
 * run.json held beside it. A running participant's live actor is written by liveSummary.
 */
export function splitStreamTraces(bundle: RunBundle): {
  bundle: StoredRunBundle;
  files: { path: string; bytes: Buffer }[];
} {
  const files: { path: string; bytes: Buffer }[] = [];
  const claimed = new Set<string>();
  for (const stream of bundle.streams)
    if (stream.trace) claimed.add(traceFileKey(stream.trace.path));
  const streams = bundle.streams.map((written, index): StoredRunStream => {
    const stream =
      written.liveActor === undefined
        ? written
        : { ...written, liveActor: liveSummary(written.liveActor) };
    const actor = stream.actor;
    if (actor === undefined) return stream;
    if (!Array.isArray(actor.items)) return { ...stream, actor: withoutRequestLists(actor) };
    const { trace: _previous, ...rest } = stream;
    const filePath = tracePath(rest, index, claimed);
    // Only a stream already split that moved position can hold this stream's position name.
    if (claimed.has(traceFileKey(filePath)))
      throw new Error(`Two participants' traces would both be written to ${filePath}.`);
    claimed.add(traceFileKey(filePath));
    const screenshots = stream.artifacts.filter(isScreenshot);
    // Compact: every reader refuses a file past RUN_ARTIFACT_MAX_BYTES, and indenting made a
    // trace 1.36 times its compact size on 236 recorded computer-use traces.
    const bytes = Buffer.from(`${JSON.stringify({ ...actor, artifacts: screenshots })}\n`);
    files.push({ path: filePath, bytes });
    const { items, ...summary } = actor;
    return {
      ...rest,
      // run.json's actor is the summary: every field of the trace except its items and lists.
      actor: withoutRequestLists(summary) as WithoutRequestLists<ActorTrace>,
      artifacts: stream.artifacts.filter((artifact) => !isScreenshot(artifact)),
      trace: {
        path: filePath,
        bytes: bytes.length,
        sha256: sha256(bytes),
        items: items.length,
        screenshots: screenshots.length,
      },
    };
  });
  return { bundle: { ...bundle, schema: RUN_BUNDLE_SCHEMA, streams }, files };
}

/**
 * Where a loader reads trace files from: the bytes at a run-relative path, at most `maxBytes`, or
 * why it could not. With `length`, the first `length` bytes, or all of a shorter file: a live file
 * grows past what run.json indexes, and the loader reads only the indexed prefix. With `start` as
 * well, the bytes from `start` to `length`: the items past a reader's cursor. Prepared run paths
 * read through the contained reader; the Observer server passes a reader over its pinned run
 * folder.
 */
export type TraceFileReader = (
  relativePath: string,
  maxBytes: number,
  length?: number,
  start?: number,
) => Promise<{ bytes: Buffer } | { refused: string }>;

function containedReader(runPaths: PreparedOutputRoot): TraceFileReader {
  return async (relativePath, maxBytes, length, start) => {
    const read =
      length === undefined
        ? await readContainedRegularFile(runPaths, relativePath, maxBytes)
        : await readContainedPrefix(runPaths, relativePath, length, start);
    if (read.status === "missing") return { refused: `${relativePath} is missing` };
    if (read.status === "refused") return { refused: refusalText(relativePath, read) };
    return { bytes: read.bytes };
  };
}

/**
 * The stream from the bytes of its trace file: its actor with the file's items, and its artifacts
 * followed by the file's screenshot entries, without the index. Its live actor is as it was.
 */
function joinTrace(
  stream: StoredRunStream & { trace: StreamTraceIndex; actor: WithoutRequestLists<ActorTrace> },
  bytes: Buffer,
): StoredRunStream {
  const index = stream.trace;
  const refuse = (detail: string): never => {
    throw new StreamTraceRefusedError(stream.id, detail);
  };
  if (bytes.length !== index.bytes)
    refuse(`${index.path} holds ${bytes.length} bytes and run.json records ${index.bytes} bytes`);
  if (sha256(bytes) !== index.sha256)
    refuse(`${index.path} does not match the sha256 run.json records for it`);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse(`${index.path} is not JSON`);
  }
  if (!isRecord(value) || !Array.isArray(value.items) || !Array.isArray(value.artifacts))
    return refuse(`${index.path} has no items or artifacts list`);
  const artifacts = value.artifacts as unknown[];
  if (!artifacts.every((artifact) => isRunStreamArtifact(artifact) && isScreenshot(artifact)))
    refuse(`${index.path} lists an artifact that is not a screenshot entry`);
  if (value.items.length !== index.items || artifacts.length !== index.screenshots)
    refuse(
      `${index.path} holds ${value.items.length} items and ${artifacts.length} screenshots and run.json records ${index.items} and ${index.screenshots}`,
    );
  const actor = joinRequestLists(stream.actor, value, index.path, refuse);
  const { trace: _index, ...rest } = stream;
  return {
    ...rest,
    actor: { ...actor, items: value.items as ActorTrace["items"] },
    artifacts: [...stream.artifacts, ...(artifacts as StreamArtifact[])],
  };
}

/**
 * run.json's actor with each per-request list its trace file holds, whatever the bundle's
 * version: before v4 the writer wrote run.json's lists and the file's from one actor, so they are
 * equal. A nested list goes into run.json's `tokenUsage` or `conversation` when run.json has it.
 * A conversation left without a requests list is refused: ActorTrace types the list as present,
 * so a reader that counts it would throw.
 */
function joinRequestLists(
  summary: WithoutRequestLists<ActorTrace>,
  file: Record<string, unknown>,
  filePath: string,
  refuse: (detail: string) => never,
): ActorTrace {
  if (isRecord(file.conversation) && !Array.isArray(file.conversation.requests))
    refuse(`${filePath} records a conversation without its requests list`);
  const joined: Record<string, unknown> = { ...summary };
  for (const list of REQUEST_LISTS) {
    const value = listIn(file, list);
    if (value === undefined) continue;
    if (!Array.isArray(value)) refuse(`${filePath} holds ${list} as something other than a list`);
    const [first, second] = list.split(".") as [string, string | undefined];
    const parent = joined[first];
    if (second === undefined) joined[first] = value;
    else if (isRecord(parent)) joined[first] = { ...parent, [second]: value };
  }
  if (isRecord(joined.conversation) && !Array.isArray(joined.conversation.requests))
    refuse(`run.json records a conversation and ${filePath} holds no requests list for it`);
  return joined as unknown as ActorTrace;
}

/** Refuses an index the shape check would refuse, naming a file that is not a trace file name. */
function assertIndex(stream: StoredRunStream): asserts stream is StoredRunStream & {
  trace: StreamTraceIndex;
  actor: WithoutRequestLists<ActorTrace>;
} {
  const index = stream.trace;
  if (isRecord(index) && typeof index.path === "string" && !isStreamTracePath(index.path))
    throw new StreamTraceRefusedError(
      stream.id,
      `run.json indexes ${index.path}, which is not a trace file name (actor.json, actors/<stream>.json or actor-<surface>.json)`,
    );
  if (!isStreamTraceIndex(index) || stream.actor === undefined)
    throw new StreamTraceRefusedError(stream.id, "run.json records a malformed trace index");
  if (stream.actor.items !== undefined)
    throw new StreamTraceRefusedError(stream.id, "run.json holds items beside its trace index");
}

/**
 * A stream of run.json typed as a loaded one. The loader joins each file run.json indexes, and
 * takes what run.json holds inline as it is: a v1 actor's items and lists, and the items of a live
 * actor of humanish.live-actor.v1. It also types each refused stream this way, kept as run.json
 * holds it: from v2 its actor has no items, from v4 none of the lists, and the loader's `refused`
 * names it.
 */
const asLoaded = (stream: StoredRunStream): RunStream => stream as RunStream;

/** A live actor whose items run.json holds inline: humanish.live-actor.v1, or one with no schema. */
const isInlineLiveActor = (live: Pick<LiveActor, "schema">): boolean =>
  live.schema === LIVE_ACTOR_V1_SCHEMA || (live.schema as unknown) === undefined;

/** A live file that could not be read, which a writer that moved on may have removed. */
class LiveFileUnreadableError extends StreamTraceRefusedError {}

/**
 * A live file the loader joined into stream `streamId`: the index it read the items by, and the
 * cursor it read past when the stream holds only the items after one. A read with `stopped` has
 * an index that records more than the loader reads of one file, so it read nothing and joined no
 * items past `after`, which it always has; `stopped` is the warning a reader that shows the run
 * gives.
 */
export type LiveItemsRead =
  | { streamId: string; index: LiveItemsIndex; after?: LiveItemsCursor; stopped?: undefined }
  | { streamId: string; index: LiveItemsIndex; after: LiveItemsCursor; stopped: string };

/** For a live file's index, the prefix of that file the caller holds already, if any. */
type LiveAfter = (index: LiveItemsIndex) => LiveItemsCursor | undefined;

/** A stream with its live items joined, the file bytes they came from, and what was read. */
interface JoinedLiveItems {
  stream: StoredRunStream;
  file?: { path: string; bytes: Buffer };
  read?: LiveItemsRead;
}

/**
 * The stream with its live actor's items joined from the indexed prefix of its live file, and the
 * file's path and those bytes. A live actor with inline items (humanish.live-actor.v1) is returned
 * as it is; bundleRefusal refuses one in a v3 run.json.
 */
async function readLiveItems(
  read: TraceFileReader,
  stream: StoredRunStream,
  maxBytes: number,
  liveAfter: LiveAfter | undefined,
): Promise<JoinedLiveItems> {
  const live = stream.liveActor;
  if (live === undefined || isInlineLiveActor(live)) return { stream };
  const refuse = (detail: string): never => {
    throw new StreamTraceRefusedError(stream.id, detail);
  };
  if (live.schema !== LIVE_ACTOR_SCHEMA)
    refuse(
      `run.json records live actor schema ${String(live.schema)}, which this version does not read`,
    );
  const index = live.itemsFile;
  if (!isLiveItemsIndex(index)) return refuse("run.json records a malformed live items index");
  if (live.items !== undefined) refuse("run.json holds in-progress items beside their live file");
  const { itemsFile: _index, ...summary } = live;
  const after = liveAfter?.(index);
  if (index.bytes > maxBytes) {
    if (after === undefined || !cursorFits(index, after))
      throw new StreamTraceTooLargeError(stream.id, index, maxBytes);
    // The caller keeps the prefix it holds, read when the file was under the limit.
    return {
      stream: { ...stream, liveActor: { ...summary, items: [] } },
      read: {
        streamId: stream.id,
        index,
        after,
        stopped: `Participant ${stream.id}'s items past ${after.items} were not read: ${pastLimitDetail(index, maxBytes)}. The items read before stay shown; open the file with another tool, such as jq, to read the rest.`,
      },
    };
  }
  const tail = after === undefined ? undefined : await readLiveTail(read, stream, index, after);
  if (tail !== undefined)
    return {
      stream: { ...stream, liveActor: { ...summary, items: tail.items } },
      file: { path: index.path, bytes: tail.bytes },
      read: { streamId: stream.id, index, after: after! },
    };
  const file = await read(index.path, maxBytes, index.bytes);
  if ("refused" in file) throw new LiveFileUnreadableError(stream.id, file.refused);
  // Only the indexed prefix: a reader that ignores `length` hands over the bytes appended since.
  const joined = liveItemsFromBytes(file.bytes.subarray(0, index.bytes), index);
  if ("refused" in joined) return refuse(joined.refused);
  return {
    stream: { ...stream, liveActor: { ...summary, items: joined.items } },
    file: { path: index.path, bytes: file.bytes.subarray(0, index.bytes) },
    read: { streamId: stream.id, index },
  };
}

/**
 * Whether `after` can be a prefix of the file `index` describes: some bytes, no more items or bytes
 * than the index, and at its end in both counts or in neither. Whether it ends on a line end is
 * checked only when the tail is read.
 */
const cursorFits = (index: LiveItemsIndex, after: LiveItemsCursor): boolean =>
  after.bytes > 0 &&
  after.items <= index.items &&
  after.bytes <= index.bytes &&
  (after.items === index.items) === (after.bytes === index.bytes);

/**
 * The items of the live file `index` describes past `after`, and the bytes they were read from;
 * undefined when the cursor does not fit the index or the file's lines, so the caller reads the
 * whole prefix. A cursor at the indexed end reads nothing. A file the reader cannot read throws
 * LiveFileUnreadableError, as a whole read does.
 */
async function readLiveTail(
  read: TraceFileReader,
  stream: StoredRunStream,
  index: LiveItemsIndex,
  after: LiveItemsCursor,
): Promise<{ items: ActorTrace["items"]; bytes: Buffer } | undefined> {
  if (!cursorFits(index, after)) return undefined;
  if (after.bytes === index.bytes) return { items: [], bytes: Buffer.alloc(0) };
  const file = await read(index.path, index.bytes - after.bytes + 1, index.bytes, after.bytes - 1);
  if ("refused" in file) throw new LiveFileUnreadableError(stream.id, file.refused);
  const tail = file.bytes.subarray(0, index.bytes - after.bytes + 1);
  const joined = liveItemsAfter(tail, index, after);
  return "refused" in joined ? undefined : { items: joined.items, bytes: tail.subarray(1) };
}

/**
 * The stream with its trace and live items joined, and each file's path and the bytes it was
 * joined from.
 */
async function readStreamTrace(
  read: TraceFileReader,
  stream: StoredRunStream,
  maxBytes: number,
  liveAfter?: LiveAfter,
): Promise<{ stream: RunStream; files: { path: string; bytes: Buffer }[]; live?: LiveItemsRead }> {
  const files: { path: string; bytes: Buffer }[] = [];
  let joined = stream;
  if (stream.trace !== undefined) {
    assertIndex(stream);
    if (stream.trace.bytes > maxBytes)
      throw new StreamTraceTooLargeError(stream.id, stream.trace, maxBytes);
    const file = await read(stream.trace.path, maxBytes);
    if ("refused" in file) throw new StreamTraceRefusedError(stream.id, file.refused);
    joined = joinTrace(stream, file.bytes);
    files.push({ path: stream.trace.path, bytes: file.bytes });
  }
  const live = await readLiveItems(read, joined, maxBytes, liveAfter);
  if (live.file !== undefined) files.push(live.file);
  return {
    stream: asLoaded(live.stream),
    files,
    ...(live.read === undefined ? {} : { live: live.read }),
  };
}

/**
 * The stream as a v1 run.json held it: its actor with every item and every artifact entry. A
 * stream without an index is returned as it is (a v1 stream, or one with no actor). An indexed
 * stream's file must have a trace file name (isStreamTracePath); it is read under `maxBytes` and
 * checked against the index's byte count, sha256, item count and screenshot count, and any
 * difference throws StreamTraceRefusedError. An index that records more than `maxBytes` throws
 * before the file is read. The rules that need the whole bundle (an unindexed v2
 * actor, two participants indexing one file) are loadStreamTraces'.
 */
export async function loadStreamTrace(
  runPaths: PreparedOutputRoot,
  stream: StoredRunStream,
  maxBytes: number = RUN_ARTIFACT_MAX_BYTES,
): Promise<RunStream> {
  return (await readStreamTrace(containedReader(runPaths), stream, maxBytes)).stream;
}

/**
 * What each version's writer never puts in run.json, so a run.json of that version that holds it
 * did not come from the writer. From v2 the writer indexes every actor on every write, mid-run
 * flushes included, and the final write replaces `liveActor`. From v3 a running participant's
 * items are in a live file (humanish.live-actor.v2). From v4 the per-request lists are only in
 * the trace file. A run.json of v1, or of no version this table names, is read as v1 is.
 */
const WRITER_RULES = new Map<string, { liveFiles: boolean; listsOut: boolean }>([
  [RUN_BUNDLE_V2_SCHEMA, { liveFiles: false, listsOut: false }],
  [RUN_BUNDLE_V3_SCHEMA, { liveFiles: true, listsOut: false }],
  [RUN_BUNDLE_SCHEMA, { liveFiles: true, listsOut: true }],
]);

/**
 * Whether a run.json of `schema` holds the per-request lists (REQUEST_LISTS) the writer kept in
 * it: v1 to v3, and a schema WRITER_RULES does not name, which is read as v1. From v4 they are
 * only in the trace file, so a running participant's `liveActor` holds none.
 */
export const keepsRequestListsInRunJson = (schema: string): boolean =>
  WRITER_RULES.get(schema)?.listsOut !== true;

/**
 * Why a stream of this bundle cannot be read, before any file is. A trace file belongs to one
 * participant, so every stream indexing a path another stream indexes, compared as a
 * case-insensitive file system compares them, is refused in every version. The other rules are
 * WRITER_RULES': a v2 actor without an index lost its trace file, and a run.json whose outcome says
 * the run finished never carries `liveActor`.
 */
function bundleRefusal(
  bundle: StoredRunBundle,
  stream: StoredRunStream,
  owners: ReadonlyMap<string, string[]>,
): string | undefined {
  const shared = isRecord(stream.trace)
    ? owners.get(traceFileKey(String(stream.trace.path)))
    : undefined;
  if (shared !== undefined && shared.length > 1)
    return `run.json indexes ${String(stream.trace!.path)} for participants ${shared.join(", ")} (paths that differ only in case name one file on some file systems), and a trace file belongs to one participant`;
  const rules = WRITER_RULES.get(String(bundle.schema));
  if (rules === undefined) return undefined;
  const version = String(bundle.schema).replace("humanish.run-bundle.", "");
  if (stream.actor !== undefined && stream.trace === undefined)
    return "run.json holds its actor and names no trace file";
  if (stream.liveActor !== undefined && bundle.outcome?.state === "finished")
    return "run.json records a finished run and still holds in-progress items";
  if (rules.liveFiles && stream.liveActor !== undefined && isInlineLiveActor(stream.liveActor))
    return `run.json ${version} holds in-progress items inline, which the writer keeps in a live file`;
  if (rules.listsOut)
    for (const field of ["actor", "liveActor"] as const) {
      const trace = stream[field];
      const list = isRecord(trace) ? heldRequestList(trace) : undefined;
      if (list !== undefined)
        return `run.json ${version} holds ${list} in its ${field}, which the writer keeps only in the trace file`;
    }
  return undefined;
}

interface LoadedTraces {
  bundle: RunBundle;
  refused: StreamTraceRefusedError[];
  /** Each live file joined into a stream that loaded, in stream order. */
  live: LiveItemsRead[];
}

/**
 * Every stream of the bundle loaded through loadStreamTrace, one file at a time, and the refusal
 * of each stream that could not be (see bundleRefusal for the rules that need the whole bundle).
 * Each refused stream is kept as run.json holds it; a reader that shows the run passes the result
 * to displayedTraces. `source` is the run's prepared paths, or a TraceFileReader. `onTrace`
 * receives each trace and live file's path and the bytes the stream was joined from, after they
 * matched the index, so a caller scans exactly what it reads.
 *
 * `liveAfter` names, for a live file's index, the prefix the caller holds already (the Observer
 * feed's cursor). The loader then reads and joins only the items past it, checked by liveItemsAfter
 * without the indexed sha256, and `live` records the cursor; a cursor past the index or off the
 * file's lines gets the whole prefix, checked as always. A live file whose index records more than
 * `maxBytes` is not read: for a cursor that fits the index the stream gets no items past it and
 * `live` records `stopped`, and without one the stream is refused.
 *
 * A live file that cannot be read may have been removed by the writer after `bundle` was read: it
 * removes a superseded generation once run.json names the next one, and every live file once the
 * run finished. The loader then reads run.json again, once, through the same reader, and loads
 * that bundle instead when it is a run bundle of the same run.
 */
export async function loadStreamTraces(
  source: PreparedOutputRoot | TraceFileReader,
  bundle: StoredRunBundle,
  options: {
    maxBytes?: number;
    onTrace?: (path: string, bytes: Buffer) => void;
    liveAfter?: LiveAfter;
  } = {},
): Promise<LoadedTraces> {
  const read = typeof source === "function" ? source : containedReader(source);
  const maxBytes = options.maxBytes ?? RUN_ARTIFACT_MAX_BYTES;
  let loaded = await loadEveryStream(read, bundle, maxBytes, options.liveAfter);
  if (loaded.refused.some((error) => error instanceof LiveFileUnreadableError)) {
    const current = await rereadBundle(read, bundle.runId);
    if (current !== undefined)
      loaded = await loadEveryStream(read, current, maxBytes, options.liveAfter);
  }
  for (const file of loaded.files) options.onTrace?.(file.path, file.bytes);
  return { bundle: loaded.bundle, refused: loaded.refused, live: loaded.live };
}

/** run.json as it is now, when it is a run bundle of run `runId`. */
async function rereadBundle(
  read: TraceFileReader,
  runId: string,
): Promise<StoredRunBundle | undefined> {
  const file = await read(RUN_BUNDLE_FILE, RUN_ARTIFACT_MAX_BYTES);
  if ("refused" in file) return undefined;
  try {
    const value: unknown = JSON.parse(file.bytes.toString("utf8"));
    return isRunBundle(value) && value.runId === runId ? value : undefined;
  } catch {
    return undefined;
  }
}

/** bundleRefusal for each stream of `bundle`, with the streams that index each file counted once. */
function bundleRefusals(bundle: StoredRunBundle): (stream: StoredRunStream) => string | undefined {
  const owners = new Map<string, string[]>();
  for (const stream of bundle.streams)
    if (isRecord(stream.trace)) {
      const key = traceFileKey(String(stream.trace.path));
      owners.set(key, [...(owners.get(key) ?? []), stream.id]);
    }
  return (stream) => bundleRefusal(bundle, stream, owners);
}

async function loadEveryStream(
  read: TraceFileReader,
  bundle: StoredRunBundle,
  maxBytes: number,
  liveAfter: LiveAfter | undefined,
): Promise<LoadedTraces & { files: { path: string; bytes: Buffer }[] }> {
  const refusal = bundleRefusals(bundle);
  const streams: RunStream[] = [];
  const refused: StreamTraceRefusedError[] = [];
  const files: { path: string; bytes: Buffer }[] = [];
  const live: LiveItemsRead[] = [];
  for (const stream of bundle.streams) {
    try {
      const reason = refusal(stream);
      if (reason !== undefined) throw new StreamTraceRefusedError(stream.id, reason);
      const loaded = await readStreamTrace(read, stream, maxBytes, liveAfter);
      files.push(...loaded.files);
      if (loaded.live !== undefined) live.push(loaded.live);
      streams.push(loaded.stream);
    } catch (error) {
      if (!(error instanceof StreamTraceRefusedError)) throw error;
      refused.push(error);
      streams.push(asLoaded(stream));
    }
  }
  return { bundle: { ...bundle, streams }, refused, files, live };
}

/**
 * A loaded bundle as a reader that shows a run presents it. A refused stream keeps run.json's
 * summary, shows none of the items or per-request lists run.json or a file supplied for it (its
 * actor's items and lists, its in-progress items, its screenshot entries), and carries
 * `traceUnavailable` with the reason; a warn event on its timeline says the same. A reader that
 * shows the run then never prices or checks rows the loader refused. A live file the loader
 * stopped reading (LiveItemsRead's `stopped`) gives its stream a `live-items.not-read` warn event.
 */
export function displayedTraces(loaded: {
  bundle: RunBundle;
  refused: readonly StreamTraceRefusedError[];
  live?: readonly LiveItemsRead[];
}): DisplayedRunBundle {
  const reasons = new Map(loaded.refused.map((error) => [error.streamId, error.message]));
  const stopped = (loaded.live ?? []).filter((read) => read.stopped !== undefined);
  if (reasons.size === 0 && stopped.length === 0) return loaded.bundle;
  const streams = loaded.bundle.streams.map((stream): DisplayedRunStream => {
    const reason = reasons.get(stream.id);
    if (reason === undefined) return stream;
    const { liveActor: _live, trace: _index, actor, ...rest } = stream;
    return {
      ...rest,
      ...(actor === undefined ? {} : { actor: { ...withoutRequestLists(actor), items: [] } }),
      artifacts: stream.artifacts.filter((artifact) => !isScreenshot(artifact)),
      traceUnavailable: reason,
    };
  });
  const events = loaded.bundle.streams
    .filter((stream) => reasons.has(stream.id))
    .map((stream) => ({
      id: `event-trace-unavailable-${stream.id}`,
      at: stream.updatedAt,
      level: "warn" as const,
      type: "trace.unavailable",
      message: reasons.get(stream.id)!,
      streamId: stream.id,
    }));
  const notRead = stopped.map((read) => ({
    id: `event-live-items-not-read-${read.streamId}`,
    at: loaded.bundle.streams.find((stream) => stream.id === read.streamId)?.updatedAt ?? "",
    level: "warn" as const,
    type: "live-items.not-read",
    message: read.stopped,
    streamId: read.streamId,
  }));
  return {
    ...loaded.bundle,
    streams,
    events: [...loaded.bundle.events, ...events, ...notRead],
  };
}

/**
 * What `reduce` returns for each stream of the bundle, loaded as loadRunTraces loads it, in stream
 * order; the first refusal throws. Streams are loaded one at a time and nothing of a stream's files
 * is kept past its `reduce` call, so a caller that keeps part of each trace holds one trace at a
 * time where loadRunTraces holds them all. Unlike loadStreamTraces it does not read run.json again
 * when a live file cannot be read, so it suits a run whose participants have finished.
 */
export async function reduceRunTraces<T>(
  runPaths: PreparedOutputRoot,
  bundle: StoredRunBundle,
  reduce: (stream: RunStream, index: number) => T,
): Promise<T[]> {
  const read = containedReader(runPaths);
  const refusal = bundleRefusals(bundle);
  const kept: T[] = [];
  for (const [index, stream] of bundle.streams.entries()) {
    const reason = refusal(stream);
    if (reason !== undefined) throw new StreamTraceRefusedError(stream.id, reason);
    kept.push(reduce((await readStreamTrace(read, stream, RUN_ARTIFACT_MAX_BYTES)).stream, index));
  }
  return kept;
}

/** The bundle with every stream loaded; the first refusal throws. */
export async function loadRunTraces(
  source: PreparedOutputRoot | TraceFileReader,
  bundle: StoredRunBundle,
  maxBytes?: number,
): Promise<RunBundle> {
  const loaded = await loadStreamTraces(source, bundle, maxBytes === undefined ? {} : { maxBytes });
  if (loaded.refused[0]) throw loaded.refused[0];
  return loaded.bundle;
}
