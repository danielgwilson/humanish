// How analysis reads a run's recorded source: run.json, then each participant's trace one at a time,
// and the refusals it gives for either.

import { isCommsReceivingEvidence } from "../comms/receiving-evidence.js";
import { isReadRunBundleSchema, type RunBundle } from "../run/bundle.js";
import { RUN_ARTIFACT_MAX_BYTES } from "../run/contained-output.js";
import { runIdOf, type PreparedRunArtifactPaths } from "../run/paths.js";
import { reduceRunTraces, StreamTraceRefusedError } from "../run/stream-trace.js";
import type { RunStream } from "../run/streams.js";
import { isRecord } from "../run/type-guards.js";
import { EVIDENCE_LIMITS } from "./analysis-limits.js";

/**
 * run.json's bundle, when it is a run bundle of the prepared run that analysis reads: at most
 * EVIDENCE_LIMITS.sourceBytes, at most EVIDENCE_LIMITS.participants participants, and each
 * participant and event with the fields analysis reads.
 */
export function parseAnalysisSource(prepared: PreparedRunArtifactPaths, bytes: Buffer): RunBundle {
  if (bytes.length > EVIDENCE_LIMITS.sourceBytes) throw new Error("ANALYSIS_SOURCE_TOO_LARGE");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !isRecord(value) ||
    !isReadRunBundleSchema(value.schema) ||
    value.runId !== runIdOf(prepared) ||
    !Array.isArray(value.streams) ||
    value.streams.length > EVIDENCE_LIMITS.participants ||
    !Array.isArray(value.events) ||
    (value.commsReceiving !== undefined && !isCommsReceivingEvidence(value.commsReceiving))
  )
    throw new Error("ANALYSIS_SOURCE_INVALID");
  const ids = new Set<string>();
  for (const stream of value.streams) {
    if (
      !isRecord(stream) ||
      typeof stream.id !== "string" ||
      stream.id.length === 0 ||
      stream.id.length > 256 ||
      ids.has(stream.id) ||
      typeof stream.label !== "string" ||
      typeof stream.status !== "string"
    ) {
      throw new Error("ANALYSIS_SOURCE_INVALID");
    }
    ids.add(stream.id);
    if (stream.actor !== undefined && !isRecord(stream.actor))
      throw new Error("ANALYSIS_SOURCE_INVALID");
  }
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      typeof event.id !== "string" ||
      typeof event.message !== "string" ||
      typeof event.type !== "string"
    )
      throw new Error("ANALYSIS_SOURCE_INVALID");
  }
  return value as unknown as RunBundle;
}

/**
 * What `keep` takes from each stream of run.json's bundle with the stream's trace loaded, in stream
 * order. Each trace file is read up to RUN_ARTIFACT_MAX_BYTES, as the loader, verify and the
 * Observer read it, and is dropped once `keep` returns, so analysis holds one trace at a time
 * whatever the number of participants. run.json's digest, which the analysis record binds, binds
 * each trace's sha256.
 */
export async function readParticipantTraces<T>(
  prepared: PreparedRunArtifactPaths,
  bundle: RunBundle,
  keep: (stream: RunStream, index: number) => T,
): Promise<T[]> {
  if (bundle.streams.some((stream) => (stream.trace?.bytes ?? 0) > RUN_ARTIFACT_MAX_BYTES))
    throw new Error("ANALYSIS_SOURCE_TOO_LARGE");
  try {
    return await reduceRunTraces(prepared, bundle, (stream, index) => {
      validateTraceItems(stream.actor);
      return keep(stream, index);
    });
  } catch (error) {
    throw error instanceof StreamTraceRefusedError ? new Error("ANALYSIS_SOURCE_INVALID") : error;
  }
}

function validateTraceItems(actor: unknown): void {
  if (actor !== undefined && (!isRecord(actor) || !Array.isArray(actor.items)))
    throw new Error("ANALYSIS_SOURCE_INVALID");
  const eventIds = new Set<string>();
  for (const item of isRecord(actor) ? (actor.items as unknown[]) : []) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 256 ||
      eventIds.has(item.id) ||
      typeof item.kind !== "string" ||
      typeof item.title !== "string" ||
      (item.text !== undefined && typeof item.text !== "string")
    )
      throw new Error("ANALYSIS_SOURCE_INVALID");
    eventIds.add(item.id);
  }
}
