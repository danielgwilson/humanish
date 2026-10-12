// Where a participant's trace lives. A v1 run.json holds every stream's trace items and screenshot
// entries inline. From v2 the run writer moves them into one file per stream and leaves an index
// in run.json, so run.json stays a summary whatever the length of the sessions. From v3 a running
// participant's items so far are in a live file run.json indexes too (src/run/live-items.ts).
// Every reader that needs the items loads them here, which accepts every version and checks each
// file against its index.

import { createHash } from "node:crypto";

import type { ActorTrace } from "../actors/contract.js";
import {
  RUN_BUNDLE_FILE,
  RUN_BUNDLE_SCHEMA,
  RUN_BUNDLE_V2_SCHEMA,
  type RunBundle,
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
  liveItemsFromBytes,
} from "./live-items.js";
import { isRunStreamArtifact, isStreamTraceIndex, isStreamTracePath } from "./stream-shape.js";
import type { RunStream, StreamTraceIndex } from "./streams.js";
import { isRecord } from "./type-guards.js";

type StreamArtifact = RunStream["artifacts"][number];

/** A trace that does not match its index, or cannot be read. The message names the stream. */
export class StreamTraceRefusedError extends Error {
  constructor(
    readonly streamId: string,
    detail: string,
  ) {
    super(
      `Participant ${streamId}'s trace was not read: ${detail}. A trace file must stay as the run wrote it; restore the run folder from a copy.`,
    );
    this.name = "StreamTraceRefusedError";
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
 * The run.json the run writes, and the trace files it writes first. Each stream with a finished
 * actor keeps that actor without `items`, its artifacts other than screenshots, and an index of its
 * trace file; the file is the actor trace with the stream's screenshot entries as `artifacts`. A
 * stream already split (its actor read back from a v2 run.json without its items) keeps its index,
 * since its file is on disk.
 */
export function splitStreamTraces(bundle: RunBundle): {
  bundle: RunBundle;
  files: { path: string; bytes: Buffer }[];
} {
  const files: { path: string; bytes: Buffer }[] = [];
  const claimed = new Set<string>();
  for (const stream of bundle.streams)
    if (stream.trace) claimed.add(traceFileKey(stream.trace.path));
  const streams = bundle.streams.map((stream, index): RunStream => {
    const actor = stream.actor;
    if (actor === undefined || !Array.isArray(actor.items)) return stream;
    const { trace: _previous, ...rest } = stream;
    const filePath = tracePath(rest, index, claimed);
    // Only a stream already split that moved position can hold this stream's position name.
    if (claimed.has(traceFileKey(filePath)))
      throw new Error(`Two participants' traces would both be written to ${filePath}.`);
    claimed.add(traceFileKey(filePath));
    const screenshots = stream.artifacts.filter(isScreenshot);
    const bytes = Buffer.from(`${JSON.stringify({ ...actor, artifacts: screenshots }, null, 2)}\n`);
    files.push({ path: filePath, bytes });
    const { items, ...summary } = actor;
    return {
      ...rest,
      // run.json's actor is the summary: every field of the trace except its items.
      actor: summary as ActorTrace,
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
 * grows past what run.json indexes, and the loader reads only the indexed prefix. Prepared run
 * paths read through the contained reader; the Observer server passes a reader over its pinned run
 * folder.
 */
export type TraceFileReader = (
  relativePath: string,
  maxBytes: number,
  length?: number,
) => Promise<{ bytes: Buffer } | { refused: string }>;

function containedReader(runPaths: PreparedOutputRoot): TraceFileReader {
  return async (relativePath, maxBytes, length) => {
    const read =
      length === undefined
        ? await readContainedRegularFile(runPaths, relativePath, maxBytes)
        : await readContainedPrefix(runPaths, relativePath, length);
    if (read.status === "missing") return { refused: `${relativePath} is missing` };
    if (read.status === "refused") return { refused: refusalText(relativePath, read) };
    return { bytes: read.bytes };
  };
}

/**
 * The stream from the bytes of its trace file: its actor with the file's items, and its artifacts
 * followed by the file's screenshot entries, without the index.
 */
function joinTrace(stream: RunStream & { trace: StreamTraceIndex }, bytes: Buffer): RunStream {
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
  const { trace: _index, ...rest } = stream;
  return {
    ...rest,
    actor: { ...(stream.actor as ActorTrace), items: value.items as ActorTrace["items"] },
    artifacts: [...stream.artifacts, ...(artifacts as StreamArtifact[])],
  };
}

/** Refuses an index the shape check would refuse, naming a file that is not a trace file name. */
function assertIndex(stream: RunStream): asserts stream is RunStream & { trace: StreamTraceIndex } {
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

/** A live actor whose items run.json holds inline: humanish.live-actor.v1, or one with no schema. */
const isInlineLiveActor = (live: NonNullable<RunStream["liveActor"]>): boolean =>
  live.schema === LIVE_ACTOR_V1_SCHEMA || (live.schema as unknown) === undefined;

/** A live file that could not be read, which a writer that moved on may have removed. */
class LiveFileUnreadableError extends StreamTraceRefusedError {}

/**
 * The stream with its live actor's items joined from the indexed prefix of its live file, and the
 * file's path and those bytes. A live actor with inline items (humanish.live-actor.v1) is returned
 * as it is; bundleRefusal refuses one in a v3 run.json.
 */
async function readLiveItems(
  read: TraceFileReader,
  stream: RunStream,
  maxBytes: number,
): Promise<{ stream: RunStream; live?: { path: string; bytes: Buffer } }> {
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
  if (index.bytes > maxBytes)
    refuse(`${index.path} is indexed at ${index.bytes} bytes, more than the ${maxBytes} read`);
  const file = await read(index.path, maxBytes, index.bytes);
  if ("refused" in file) throw new LiveFileUnreadableError(stream.id, file.refused);
  const joined = liveItemsFromBytes(file.bytes, index);
  if ("refused" in joined) return refuse(joined.refused);
  const { itemsFile: _index, ...summary } = live;
  return {
    stream: { ...stream, liveActor: { ...summary, items: joined.items } },
    live: { path: index.path, bytes: file.bytes },
  };
}

/**
 * The stream with its trace and live items joined, and each file's path and the bytes it was
 * joined from.
 */
async function readStreamTrace(
  read: TraceFileReader,
  stream: RunStream,
  maxBytes: number,
): Promise<{ stream: RunStream; files: { path: string; bytes: Buffer }[] }> {
  const files: { path: string; bytes: Buffer }[] = [];
  let joined = stream;
  if (stream.trace !== undefined) {
    assertIndex(stream);
    const file = await read(stream.trace.path, maxBytes);
    if ("refused" in file) throw new StreamTraceRefusedError(stream.id, file.refused);
    joined = joinTrace(stream, file.bytes);
    files.push({ path: stream.trace.path, bytes: file.bytes });
  }
  const live = await readLiveItems(read, joined, maxBytes);
  if (live.live !== undefined) files.push(live.live);
  return { stream: live.stream, files };
}

/**
 * The stream as a v1 run.json held it: its actor with every item and every artifact entry. A
 * stream without an index is returned as it is (a v1 stream, or one with no actor). An indexed
 * stream's file must have a trace file name (isStreamTracePath); it is read under `maxBytes` and
 * checked against the index's byte count, sha256, item count and screenshot count, and any
 * difference throws StreamTraceRefusedError. The rules that need the whole bundle (an unindexed v2
 * actor, two participants indexing one file) are loadStreamTraces'.
 */
export async function loadStreamTrace(
  runPaths: PreparedOutputRoot,
  stream: RunStream,
  maxBytes: number = RUN_ARTIFACT_MAX_BYTES,
): Promise<RunStream> {
  return (await readStreamTrace(containedReader(runPaths), stream, maxBytes)).stream;
}

/**
 * Why a stream of this bundle cannot be read, before any file is. A trace file belongs to one
 * participant, so every stream indexing a path another stream indexes, compared as a
 * case-insensitive file system compares them, is refused. In v2 the writer
 * indexes every actor on every write, mid-run flushes included, so a v2 actor without an index lost
 * its trace file, and inline items never come from the writer. A run still writing carries its
 * participants' items so far as `liveActor`: inline in v2 (humanish.live-actor.v1), in a live file
 * from v3 (humanish.live-actor.v2), so a v3 run.json with inline live items did not come from the
 * writer. A run.json whose outcome says the run finished never carries `liveActor`, since the
 * final write replaces it.
 */
function bundleRefusal(
  bundle: RunBundle,
  stream: RunStream,
  owners: ReadonlyMap<string, string[]>,
): string | undefined {
  const shared = isRecord(stream.trace)
    ? owners.get(traceFileKey(String(stream.trace.path)))
    : undefined;
  if (shared !== undefined && shared.length > 1)
    return `run.json indexes ${String(stream.trace!.path)} for participants ${shared.join(", ")} (paths that differ only in case name one file on some file systems), and a trace file belongs to one participant`;
  if (bundle.schema !== RUN_BUNDLE_SCHEMA && bundle.schema !== RUN_BUNDLE_V2_SCHEMA)
    return undefined;
  if (stream.actor !== undefined && stream.trace === undefined)
    return "run.json holds its actor and names no trace file";
  if (stream.liveActor !== undefined && bundle.outcome?.state === "finished")
    return "run.json records a finished run and still holds in-progress items";
  if (
    bundle.schema === RUN_BUNDLE_SCHEMA &&
    stream.liveActor !== undefined &&
    isInlineLiveActor(stream.liveActor)
  )
    return "run.json v3 holds in-progress items inline, which the writer keeps in a live file";
  return undefined;
}

interface LoadedTraces {
  bundle: RunBundle;
  refused: StreamTraceRefusedError[];
}

/**
 * Every stream of the bundle loaded through loadStreamTrace, one file at a time, and the refusal
 * of each stream that could not be (see bundleRefusal for the rules that need the whole bundle).
 * Each refused stream is kept as run.json holds it; a reader that shows the run passes the result
 * to displayedTraces. `source` is the run's prepared paths, or a TraceFileReader. `onTrace`
 * receives each trace and live file's path and the bytes the stream was joined from, after they
 * matched the index, so a caller scans exactly what it reads.
 *
 * A live file that cannot be read may have been removed by the writer after `bundle` was read: it
 * removes a superseded generation once run.json names the next one, and every live file once the
 * run finished. The loader then reads run.json again, once, through the same reader, and loads
 * that bundle instead when it is a run bundle of the same run.
 */
export async function loadStreamTraces(
  source: PreparedOutputRoot | TraceFileReader,
  bundle: RunBundle,
  options: { maxBytes?: number; onTrace?: (path: string, bytes: Buffer) => void } = {},
): Promise<LoadedTraces> {
  const read = typeof source === "function" ? source : containedReader(source);
  const maxBytes = options.maxBytes ?? RUN_ARTIFACT_MAX_BYTES;
  let loaded = await loadEveryStream(read, bundle, maxBytes);
  if (loaded.refused.some((error) => error instanceof LiveFileUnreadableError)) {
    const current = await rereadBundle(read, bundle.runId);
    if (current !== undefined) loaded = await loadEveryStream(read, current, maxBytes);
  }
  for (const file of loaded.files) options.onTrace?.(file.path, file.bytes);
  return { bundle: loaded.bundle, refused: loaded.refused };
}

/** run.json as it is now, when it is a run bundle of run `runId`. */
async function rereadBundle(read: TraceFileReader, runId: string): Promise<RunBundle | undefined> {
  const file = await read(RUN_BUNDLE_FILE, RUN_ARTIFACT_MAX_BYTES);
  if ("refused" in file) return undefined;
  try {
    const value: unknown = JSON.parse(file.bytes.toString("utf8"));
    return isRunBundle(value) && value.runId === runId ? value : undefined;
  } catch {
    return undefined;
  }
}

async function loadEveryStream(
  read: TraceFileReader,
  bundle: RunBundle,
  maxBytes: number,
): Promise<LoadedTraces & { files: { path: string; bytes: Buffer }[] }> {
  const owners = new Map<string, string[]>();
  for (const stream of bundle.streams)
    if (isRecord(stream.trace)) {
      const key = traceFileKey(String(stream.trace.path));
      owners.set(key, [...(owners.get(key) ?? []), stream.id]);
    }
  const streams: RunStream[] = [];
  const refused: StreamTraceRefusedError[] = [];
  const files: { path: string; bytes: Buffer }[] = [];
  for (const stream of bundle.streams) {
    try {
      const reason = bundleRefusal(bundle, stream, owners);
      if (reason !== undefined) throw new StreamTraceRefusedError(stream.id, reason);
      const loaded = await readStreamTrace(read, stream, maxBytes);
      files.push(...loaded.files);
      streams.push(loaded.stream);
    } catch (error) {
      if (!(error instanceof StreamTraceRefusedError)) throw error;
      refused.push(error);
      streams.push(stream);
    }
  }
  return { bundle: { ...bundle, streams }, refused, files };
}

/**
 * A loaded bundle as a reader that shows a run presents it. A refused stream keeps run.json's
 * summary, shows none of the items run.json or a file supplied for it (its actor's items, its
 * in-progress items, its screenshot entries), and carries `traceUnavailable` with the reason; a
 * warn event on its timeline says the same.
 */
export function displayedTraces(loaded: {
  bundle: RunBundle;
  refused: readonly StreamTraceRefusedError[];
}): RunBundle {
  const reasons = new Map(loaded.refused.map((error) => [error.streamId, error.message]));
  if (reasons.size === 0) return loaded.bundle;
  const streams = loaded.bundle.streams.map((stream): RunStream => {
    const reason = reasons.get(stream.id);
    if (reason === undefined) return stream;
    const { liveActor: _live, trace: _index, actor, ...rest } = stream;
    return {
      ...rest,
      ...(actor === undefined ? {} : { actor: { ...actor, items: [] } }),
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
  return { ...loaded.bundle, streams, events: [...loaded.bundle.events, ...events] };
}

/** The bundle with every stream loaded; the first refusal throws. */
export async function loadRunTraces(
  source: PreparedOutputRoot | TraceFileReader,
  bundle: RunBundle,
  maxBytes?: number,
): Promise<RunBundle> {
  const loaded = await loadStreamTraces(source, bundle, maxBytes === undefined ? {} : { maxBytes });
  if (loaded.refused[0]) throw loaded.refused[0];
  return loaded.bundle;
}
