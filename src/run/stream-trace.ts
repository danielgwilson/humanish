// Where a participant's trace lives. A v1 run.json holds every stream's trace items and screenshot
// entries inline. From v2 the run writer moves them into one file per stream and leaves an index
// in run.json, so run.json stays a summary whatever the length of the sessions. Every reader that
// needs the items loads them here, which accepts both versions and checks a file against its index.

import { createHash } from "node:crypto";

import type { ActorTrace } from "../actors/contract.js";
import { RUN_BUNDLE_SCHEMA, type RunBundle } from "./bundle.js";
import {
  type PreparedOutputRoot,
  readContainedRegularFile,
  refusalText,
  RUN_ARTIFACT_MAX_BYTES,
} from "./contained-output.js";
import { isRunStreamArtifact, isStreamTraceIndex } from "./stream-shape.js";
import type { RunStream } from "./streams.js";
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

/** A stream id that can name a file under actors/ as it is. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The files routes write the actor trace to: actor.json for one participant, actors/<stream>.json
 * for more, and actor-<surface>.json on the scripted route.
 */
const ACTOR_TRACE_FILE =
  /^(?:actor|actor-[A-Za-z0-9][A-Za-z0-9._-]{0,127}|actors\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

/**
 * The stream's actor trace artifact when no earlier stream took it, else actors/<stream id>.json.
 * Another trace artifact (the scripted route's traces/<surface>.json holds its native step trace)
 * keeps its own file.
 */
function tracePath(stream: RunStream, index: number, taken: ReadonlySet<string>): string {
  const own = stream.artifacts.find(
    (artifact) => artifact.kind === "trace" && ACTOR_TRACE_FILE.test(artifact.path),
  )?.path;
  if (own !== undefined && !taken.has(own)) return own;
  const name = SAFE_NAME.test(stream.id)
    ? stream.id
    : `stream-${String(index + 1).padStart(3, "0")}`;
  return `actors/${name}.json`;
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
  const taken = new Set<string>();
  for (const stream of bundle.streams) if (stream.trace) taken.add(stream.trace.path);
  const streams = bundle.streams.map((stream, index): RunStream => {
    const actor = stream.actor;
    if (actor === undefined || !Array.isArray(actor.items)) return stream;
    const { trace: _previous, ...rest } = stream;
    const filePath = tracePath(rest, index, taken);
    taken.add(filePath);
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
 * The stream from the bytes of its trace file: its actor with the file's items, and its artifacts
 * followed by the file's screenshot entries, without the index. For a reader that reads the file
 * itself (the Observer server holds a pinned folder rather than prepared run paths).
 */
export function joinStreamTrace(stream: RunStream, bytes: Buffer): RunStream {
  const index = stream.trace;
  if (index === undefined) return stream;
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

/**
 * The stream as a v1 run.json held it: its actor with every item and every artifact entry. A
 * stream without an index is returned as it is (a v1 stream, or one with no actor). An indexed
 * stream's file is read under `maxBytes` and checked against the index's byte count, sha256, item
 * count and screenshot count; any difference throws StreamTraceRefusedError.
 */
export async function loadStreamTrace(
  runPaths: PreparedOutputRoot,
  stream: RunStream,
  maxBytes: number = RUN_ARTIFACT_MAX_BYTES,
): Promise<RunStream> {
  const index = stream.trace;
  if (index === undefined) return stream;
  if (!isStreamTraceIndex(index) || stream.actor === undefined)
    throw new StreamTraceRefusedError(stream.id, "run.json records a malformed trace index");
  if (stream.actor.items !== undefined)
    throw new StreamTraceRefusedError(stream.id, "run.json holds items beside its trace index");
  const read = await readContainedRegularFile(runPaths, index.path, maxBytes);
  if (read.status === "missing")
    throw new StreamTraceRefusedError(stream.id, `${index.path} is missing`);
  if (read.status === "refused")
    throw new StreamTraceRefusedError(stream.id, refusalText(index.path, read));
  return joinStreamTrace(stream, read.bytes);
}

/**
 * Every stream of the bundle loaded through loadStreamTrace, one file at a time, and the refusal
 * of each stream that could not be. In a v2 bundle a stream whose actor has no items and no index
 * is refused, so its evidence is never graded on zero items. Each refused stream is kept as
 * run.json holds it.
 */
export async function loadStreamTraces(
  runPaths: PreparedOutputRoot,
  bundle: RunBundle,
  maxBytes?: number,
): Promise<{ bundle: RunBundle; refused: StreamTraceRefusedError[] }> {
  const streams: RunStream[] = [];
  const refused: StreamTraceRefusedError[] = [];
  for (const stream of bundle.streams) {
    try {
      if (
        bundle.schema === RUN_BUNDLE_SCHEMA &&
        stream.trace === undefined &&
        isRecord(stream.actor) &&
        !Array.isArray(stream.actor.items)
      )
        throw new StreamTraceRefusedError(
          stream.id,
          "run.json holds its actor without items and names no trace file",
        );
      streams.push(await loadStreamTrace(runPaths, stream, maxBytes));
    } catch (error) {
      if (!(error instanceof StreamTraceRefusedError)) throw error;
      refused.push(error);
      streams.push(stream);
    }
  }
  return { bundle: { ...bundle, streams }, refused };
}

/** The bundle with every stream loaded; the first refusal throws. */
export async function loadRunTraces(
  runPaths: PreparedOutputRoot,
  bundle: RunBundle,
  maxBytes?: number,
): Promise<RunBundle> {
  const loaded = await loadStreamTraces(runPaths, bundle, maxBytes);
  if (loaded.refused[0]) throw loaded.refused[0];
  return loaded.bundle;
}
