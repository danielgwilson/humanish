// How analysis reads a run's recorded source: run.json, then each participant's trace one at a time,
// and the refusals it gives for either.

import { isCommsReceivingEvidence } from "../comms/receiving-evidence.js";
import { isReadRunBundleSchema, type RunBundle } from "../run/bundle.js";
import { runIdOf, type PreparedRunArtifactPaths } from "../run/paths.js";
import {
  reduceRunTraces,
  StreamTraceRefusedError,
  StreamTraceTooLargeError,
} from "../run/stream-trace.js";
import type { RunStream } from "../run/streams.js";
import { isRecord } from "../run/type-guards.js";
import { EVIDENCE_LIMITS } from "./analysis-limits.js";

/**
 * A refusal of the run's recorded source. Its message is the code, as every analysis error's is,
 * and `reason` says which file analysis did not read and why, for the person who asked.
 */
export class AnalysisSourceRefusedError extends Error {
  constructor(
    code: "ANALYSIS_SOURCE_TOO_LARGE" | "ANALYSIS_SOURCE_INVALID",
    readonly reason: string,
  ) {
    super(code);
    this.name = "AnalysisSourceRefusedError";
  }
}

const bytes = (count: number | bigint): string => `${count.toLocaleString("en-US")} bytes`;
const limit = (max: number): string =>
  `${bytes(max)} (${(max / (1024 * 1024)).toLocaleString("en-US", { maximumFractionDigits: 1 })} MiB)`;

const runFileInvalid = (reason: string): AnalysisSourceRefusedError =>
  new AnalysisSourceRefusedError(
    "ANALYSIS_SOURCE_INVALID",
    `Analysis did not read run.json: ${reason}`,
  );

const traceInvalid = (streamId: string, reason: string): AnalysisSourceRefusedError =>
  new AnalysisSourceRefusedError(
    "ANALYSIS_SOURCE_INVALID",
    `Analysis did not read participant ${streamId}'s trace: ${reason}`,
  );

/** The refusal of a run.json of `size` bytes, more than the `max` analysis reads of it. */
export function runFileTooLarge(size: number | bigint, max: number): AnalysisSourceRefusedError {
  return new AnalysisSourceRefusedError(
    "ANALYSIS_SOURCE_TOO_LARGE",
    `Analysis did not read run.json: it holds ${bytes(size)}, more than the ${limit(max)} analysis reads of it. run.json grows with each participant and the study's mission; split the participants across studies to keep it under the limit.`,
  );
}

/**
 * run.json's bundle, when it is a run bundle of the prepared run that analysis reads: at most
 * EVIDENCE_LIMITS.sourceBytes, at most EVIDENCE_LIMITS.participants participants, and each
 * participant and event with the fields analysis reads.
 */
export function parseAnalysisSource(prepared: PreparedRunArtifactPaths, bytes: Buffer): RunBundle {
  if (bytes.length > EVIDENCE_LIMITS.sourceBytes)
    throw runFileTooLarge(bytes.length, EVIDENCE_LIMITS.sourceBytes);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!isRecord(value) || !isReadRunBundleSchema(value.schema))
    throw runFileInvalid("it is not a run bundle of a schema this version of humanish reads.");
  if (value.runId !== runIdOf(prepared))
    throw runFileInvalid(
      `it records another run than ${runIdOf(prepared)}, the run in its folder.`,
    );
  if (!Array.isArray(value.streams) || !Array.isArray(value.events))
    throw runFileInvalid("it has no participants or events list.");
  if (value.streams.length > EVIDENCE_LIMITS.participants)
    throw runFileInvalid(
      `it lists ${value.streams.length} participants, more than the ${EVIDENCE_LIMITS.participants} analysis reads; split the participants across studies.`,
    );
  if (value.commsReceiving !== undefined && !isCommsReceivingEvidence(value.commsReceiving))
    throw runFileInvalid(
      "its email receiving evidence holds a field or value analysis does not read.",
    );
  const ids = new Set<string>();
  for (const [index, stream] of value.streams.entries()) {
    if (
      !isRecord(stream) ||
      typeof stream.id !== "string" ||
      stream.id.length === 0 ||
      stream.id.length > 256 ||
      ids.has(stream.id) ||
      typeof stream.label !== "string" ||
      typeof stream.status !== "string"
    ) {
      throw runFileInvalid(
        `participant ${index + 1} needs an id of 1 to 256 characters no other participant has, a label and a status.`,
      );
    }
    ids.add(stream.id);
    if (stream.actor !== undefined && !isRecord(stream.actor))
      throw runFileInvalid(`participant ${stream.id}'s actor is not an object.`);
  }
  for (const [index, event] of value.events.entries()) {
    if (
      !isRecord(event) ||
      typeof event.id !== "string" ||
      typeof event.message !== "string" ||
      typeof event.type !== "string"
    )
      throw runFileInvalid(`event ${index + 1} needs an id, a type and a message.`);
  }
  return value as unknown as RunBundle;
}

/**
 * What `keep` takes from each stream of run.json's bundle with the stream's trace loaded, in stream
 * order. Each trace file is read up to RUN_ARTIFACT_MAX_BYTES, as the loader, verify and the
 * Observer read it, and is dropped once `keep` returns, so analysis holds one trace at a time
 * whatever the number of participants. run.json's digest, which the analysis record binds, binds
 * each trace's sha256. A trace whose index records more than the limit is refused as
 * ANALYSIS_SOURCE_TOO_LARGE, and any other trace the loader refuses as ANALYSIS_SOURCE_INVALID.
 */
export async function readParticipantTraces<T>(
  prepared: PreparedRunArtifactPaths,
  bundle: RunBundle,
  keep: (stream: RunStream, index: number) => T,
): Promise<T[]> {
  try {
    return await reduceRunTraces(prepared, bundle, (stream, index) => {
      validateTraceItems(stream);
      return keep(stream, index);
    });
  } catch (error) {
    // The loader's refusal names the participant, the file, why, and what to do.
    if (error instanceof StreamTraceRefusedError)
      throw new AnalysisSourceRefusedError(
        error instanceof StreamTraceTooLargeError
          ? "ANALYSIS_SOURCE_TOO_LARGE"
          : "ANALYSIS_SOURCE_INVALID",
        error.message,
      );
    throw error;
  }
}

function validateTraceItems(stream: RunStream): void {
  const actor: unknown = stream.actor;
  if (actor === undefined) return;
  if (!isRecord(actor) || !Array.isArray(actor.items))
    throw traceInvalid(stream.id, "it has no items list.");
  // The place each id was first seen. A refusal names places, since an id is trace text.
  const firstPlace = new Map<string, number>();
  for (const [index, item] of (actor.items as unknown[]).entries()) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      item.id.length === 0 ||
      item.id.length > 256 ||
      typeof item.kind !== "string" ||
      typeof item.title !== "string" ||
      (item.text !== undefined && typeof item.text !== "string")
    )
      throw traceInvalid(
        stream.id,
        `item ${index + 1} needs an id of 1 to 256 characters, a kind and a title, and a text that is a string if it has one.`,
      );
    const first = firstPlace.get(item.id);
    if (first !== undefined)
      throw traceInvalid(
        stream.id,
        `items ${first + 1} and ${index + 1} share an id, and analysis cites each item by its id.`,
      );
    firstPlace.set(item.id, index);
  }
}
