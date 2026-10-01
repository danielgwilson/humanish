import { isCommsReceivingEvidence } from "../comms/receiving-evidence.js";
import { createHash } from "node:crypto";
import { screenshotEvidenceError } from "../evidence/image.js";
import { runIdOf, type PreparedRunArtifactPaths } from "../run/paths.js";
import { isRecord } from "../run/type-guards.js";
import { RUN_BUNDLE_FILE, type RunBundle } from "../run/bundle.js";
import type { RunStream } from "../run/streams.js";
import {
  ACTION_CAPTURE_VERSION,
  type AnalysisEvidence,
  type StudyAnalysisArtifact,
  type StudyAnalysisInput,
} from "./study-analysis.js";
import {
  digestStudyAnalysisInput,
  hashStudyAnalysisValue,
  validateStudyAnalysisInputMetadata,
} from "./validation.js";
import {
  boundedText,
  fairShares,
  hasUnmappedCaptures,
  participantAssignment,
  participantSource,
  sourceEntries,
  sourceOrder,
  type SourceEntry,
} from "./evidence-sources.js";
import { readBoundedStudyFile, readBoundedStudyFileResult } from "../run/study-files.js";

export const STUDY_EVIDENCE_LIMITS = Object.freeze({
  participants: 16,
  evidence: 800,
  captures: 40,
  textBytes: 160 * 1024,
  imageBytes: 8 * 1024 * 1024,
  totalImageBytes: 20 * 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024,
});
// A second guard for direct callers. The analysis service already requires every stream to be in
// TERMINAL_SIMULATION_STATUSES; this refuses only statuses that mean still running, so a dry-run
// bundle's contract_proof_only streams stay capturable. The source is not shape-guarded here, so
// the list also names statuses outside RunSimulationStatus.
const UNFINISHED_STREAM_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "pending",
  "queued",
  "starting",
  "preparing",
  "not_started",
  "suspended",
]);

export type StudyEvidenceLimits = { [Key in keyof typeof STUDY_EVIDENCE_LIMITS]?: number };
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function parseSource(prepared: PreparedRunArtifactPaths, bytes: Buffer): RunBundle {
  if (bytes.length > STUDY_EVIDENCE_LIMITS.sourceBytes)
    throw new Error("ANALYSIS_SOURCE_TOO_LARGE");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !isRecord(value) ||
    value.schema !== "humanish.run-bundle.v1" ||
    value.runId !== runIdOf(prepared) ||
    !Array.isArray(value.streams) ||
    value.streams.length > 128 ||
    !Array.isArray(value.events) ||
    value.events.length > 100000 ||
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
    const actor = stream.actor;
    if (
      actor !== undefined &&
      (!isRecord(actor) || !Array.isArray(actor.items) || actor.items.length > 100000)
    ) {
      throw new Error("ANALYSIS_SOURCE_INVALID");
    }
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

/** Select once from retained source. Models receive no filesystem or network resolver. */
export async function captureStudyEvidence(
  prepared: PreparedRunArtifactPaths,
  bundleBytes: Buffer,
  requested: StudyEvidenceLimits = {},
): Promise<StudyAnalysisInput> {
  const limits: Required<StudyEvidenceLimits> = { ...STUDY_EVIDENCE_LIMITS, ...requested };
  for (const key of Object.keys(STUDY_EVIDENCE_LIMITS) as Array<
    keyof typeof STUDY_EVIDENCE_LIMITS
  >) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > STUDY_EVIDENCE_LIMITS[key]
    ) {
      throw new Error("ANALYSIS_INPUT_LIMIT_INVALID");
    }
  }
  if (bundleBytes.length > limits.sourceBytes) throw new Error("ANALYSIS_SOURCE_TOO_LARGE");
  const current = await readBoundedStudyFile(prepared, RUN_BUNDLE_FILE, limits.sourceBytes);
  if (!current || !current.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  const bundle = parseSource(prepared, bundleBytes);
  const captureVersion = ACTION_CAPTURE_VERSION;
  if (
    bundle.streams.some(
      (stream) => stream.liveActor !== undefined || UNFINISHED_STREAM_STATUSES.has(stream.status),
    )
  ) {
    throw new Error("ANALYSIS_RUN_UNFINISHED");
  }
  const selected = bundle.streams.slice(0, limits.participants);
  const evidence: AnalysisEvidence[] = [];
  const images: StudyAnalysisInput["images"] = [];
  const omissions = new Set<string>();
  let textBytes = 0;
  const participants = selected.map((stream) => {
    const participant = participantSource(stream, captureVersion);
    const assignment = participantAssignment(stream, captureVersion);
    if (assignment === null || assignment.trim() === "")
      omissions.add("Some participants have no recorded assignment.");
    if (
      participant.label !== stream.label ||
      participant.assignment !== assignment ||
      participant.recordedReason !== (stream.actor?.reason ?? null)
    )
      omissions.add("Participant context exceeded the text limit.");
    textBytes += Buffer.byteLength(JSON.stringify(participant));
    return participant;
  });
  if (textBytes > limits.textBytes) throw new Error("ANALYSIS_PARTICIPANT_CONTEXT_TOO_LARGE");
  // Tie-breaking uses stable participant IDs, not the order of streams in a bundle.
  // The emitted packet still preserves participant and source event order.
  const packings = selected
    .map((stream) => ({
      stream,
      entries: sourceEntries(bundle, stream, captureVersion),
      captures: new Map<SourceEntry, Buffer>(),
      admitted: new Set<SourceEntry>(),
      captureCursor: 0,
      attempts: 0,
      readBytes: 0,
      imageBytes: 0,
      reservationBlocked: false,
    }))
    .sort((a, b) => (a.stream.id < b.stream.id ? -1 : a.stream.id > b.stream.id ? 1 : 0));
  const sel = planCaptureSelection(packings, limits);
  await selectCaptures(prepared, packings, sel, omissions);
  recordCaptureOmissions(packings, sel, omissions);
  const textByEntry = boundEvidenceText(packings, limits.textBytes - textBytes, omissions);
  packEvidence(selected, packings, textByEntry, evidence, images);
  const omittedStreamIds = bundle.streams.slice(limits.participants).map((stream) => stream.id);
  const coverage = {
    includedStreamIds: selected.map((stream) => stream.id),
    omittedStreamIds,
    evidenceCount: evidence.length,
    captureCount: images.length,
    complete: omittedStreamIds.length === 0 && omissions.size === 0,
    omissions: [...omissions],
  };
  const result = {
    captureVersion,
    runId: bundle.runId,
    sourceRunSha256: sha256(bundleBytes),
    inputDigest: "",
    participants,
    coverage,
    evidence,
    images,
  };
  result.inputDigest = digestStudyAnalysisInput(result);
  validateStudyAnalysisInputMetadata(result);
  const after = await readBoundedStudyFile(prepared, RUN_BUNDLE_FILE, limits.sourceBytes);
  if (!after || !after.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  return result;
}

/** A participant's part of the evidence packet: its stream, its source entries, and what selection
 * has admitted, captured and spent for it. */
interface ParticipantPacking {
  stream: RunStream;
  entries: SourceEntry[];
  captures: Map<SourceEntry, Buffer>;
  admitted: Set<SourceEntry>;
  captureCursor: number;
  attempts: number;
  readBytes: number;
  imageBytes: number;
  reservationBlocked: boolean;
}

/** The per-participant shares and overall budgets of one capture selection, and what it has spent. */
interface CaptureSelection {
  readonly limits: Required<StudyEvidenceLimits>;
  readonly evidenceShares: number[];
  readonly captureOrders: SourceEntry[][];
  readonly captureShares: number[];
  readonly attemptShares: number[];
  readonly readShares: number[];
  readonly imageShares: number[];
  readonly maxAttempts: number;
  readonly readBudget: number;
  captureCount: number;
  attemptedReads: number;
  returnedImageBytes: number;
  imageBytes: number;
  reserved: boolean;
}

function planCaptureSelection(
  packings: readonly ParticipantPacking[],
  limits: Required<StudyEvidenceLimits>,
): CaptureSelection {
  // Missing/invalid files cannot turn selection into an exhaustive file scan.
  // At most 2 * captures bounded reads, each at most imageBytes; successfully
  // returned bytes (including invalid PNGs) also stop at 2 * totalImageBytes.
  const maxAttempts = 2 * limits.captures;
  const readBudget = 2 * limits.totalImageBytes;
  const evidenceShares = fairShares(
    limits.evidence,
    packings.map((packing) => packing.entries.length),
  );
  const captureOrders = packings.map((packing) => sourceOrder(packing.entries, true));
  const captureShares = fairShares(
    limits.captures,
    packings.map((_, index) => Math.min(evidenceShares[index]!, captureOrders[index]!.length)),
  );
  const attemptShares = captureShares.map((share) => 2 * share);
  const readShares = fairShares(
    readBudget,
    attemptShares.map((share) => share * limits.imageBytes),
  );
  const imageShares = fairShares(
    limits.totalImageBytes,
    captureShares.map((share) => share * limits.imageBytes),
  );
  return {
    limits,
    evidenceShares,
    captureOrders,
    captureShares,
    attemptShares,
    readShares,
    imageShares,
    maxAttempts,
    readBudget,
    captureCount: 0,
    attemptedReads: 0,
    returnedImageBytes: 0,
    imageBytes: 0,
    reserved: true,
  };
}

async function selectCaptures(
  prepared: PreparedRunArtifactPaths,
  packings: ParticipantPacking[],
  sel: CaptureSelection,
  omissions: Set<string>,
): Promise<void> {
  const { limits } = sel;
  while (
    sel.attemptedReads < sel.maxAttempts &&
    sel.captureCount < limits.captures &&
    sel.imageBytes < limits.totalImageBytes &&
    sel.returnedImageBytes < sel.readBudget
  ) {
    let attempted = false;
    for (const [index, packing] of packings.entries()) {
      if (
        packing.captures.size >= sel.captureShares[index]! ||
        packing.attempts >= sel.attemptShares[index]! ||
        packing.captureCursor >= sel.captureOrders[index]!.length ||
        sel.attemptedReads >= sel.maxAttempts ||
        (sel.reserved && packing.reservationBlocked)
      )
        continue;
      if (sel.imageBytes >= limits.totalImageBytes || sel.returnedImageBytes >= sel.readBudget)
        break;
      const readAllowance = sel.reserved
        ? sel.readShares[index]! - packing.readBytes
        : sel.readBudget - sel.returnedImageBytes;
      const imageAllowance = sel.reserved
        ? sel.imageShares[index]! - packing.imageBytes
        : limits.totalImageBytes - sel.imageBytes;
      const allowance = Math.min(
        limits.imageBytes,
        limits.totalImageBytes - sel.imageBytes,
        imageAllowance,
        readAllowance,
      );
      if (allowance <= 0) {
        packing.reservationBlocked = true;
        continue;
      }
      attempted = true;
      packing.attempts++;
      sel.attemptedReads++;
      const source = sel.captureOrders[index]![packing.captureCursor]!;
      const result = await readBoundedStudyFileResult(prepared, source.capturePath!, allowance);
      if (
        result.state === "limit" &&
        result.size <= BigInt(limits.imageBytes) &&
        result.size <= BigInt(limits.totalImageBytes - sel.imageBytes) &&
        sel.reserved
      ) {
        // This participant's reservation is too small, not its evidence unsafe.
        // Preserve the candidate for the shared pool after all reserved passes.
        packing.reservationBlocked = true;
        continue;
      }
      packing.captureCursor++;
      if (result.state === "limit" && result.size <= BigInt(limits.imageBytes)) {
        omissions.add(
          result.size > BigInt(limits.totalImageBytes - sel.imageBytes)
            ? "Some captures were omitted by the image byte limit."
            : "Some captures were omitted by the bounded read budget.",
        );
        continue;
      }
      const bytes = result.state === "read" ? result.bytes : null;
      sel.returnedImageBytes += bytes?.length ?? 0;
      packing.readBytes += bytes?.length ?? 0;
      if (bytes === null || screenshotEvidenceError(source.capturePath!, bytes) !== null) {
        omissions.add("Some captures were missing, unsafe, oversized, or invalid PNG evidence.");
        continue;
      }
      sel.imageBytes += bytes.length;
      packing.imageBytes += bytes.length;
      sel.captureCount++;
      packing.captures.set(source, bytes);
    }
    if (!attempted && !reclaimCaptureSlots(packings, sel)) break;
  }
}

/**
 * Release unused read/admission reservations after a pass with no attempt. Returns false when no
 * participant can use a reclaimed slot or a global budget is spent.
 */
function reclaimCaptureSlots(
  packings: readonly ParticipantPacking[],
  sel: CaptureSelection,
): boolean {
  const { limits } = sel;
  // Release unused read/admission reservations after every reserved pass.
  // Zero-share participants can now compete for reclaimed slots, with two attempts.
  sel.reserved = false;
  sel.attemptShares.forEach((share, index) => {
    if (share === 0 && sel.evidenceShares[index]! > 0) sel.attemptShares[index] = 2;
  });
  const available = packings.map((packing, index) =>
    packing.attempts < sel.attemptShares[index]!
      ? Math.min(
          sel.evidenceShares[index]! - packing.captures.size,
          sel.captureOrders[index]!.length - packing.captureCursor,
          sel.attemptShares[index]! - packing.attempts,
        )
      : 0,
  );
  const extra = packings.map(() => 0);
  // Count earlier admissions when reclaiming slots: a byte-deferred participant
  // must catch up before better-covered participants receive additional captures.
  for (let remaining = limits.captures - sel.captureCount; remaining > 0; remaining--) {
    let next = -1;
    for (const [index, packing] of packings.entries()) {
      if (
        extra[index]! < available[index]! &&
        (next === -1 ||
          packing.captures.size + extra[index]! < packings[next]!.captures.size + extra[next]!)
      )
        next = index;
    }
    if (next === -1) break;
    extra[next]!++;
  }
  if (
    !extra.some((share) => share > 0) ||
    sel.imageBytes >= limits.totalImageBytes ||
    sel.returnedImageBytes >= sel.readBudget ||
    sel.attemptedReads >= sel.maxAttempts
  )
    return false;
  extra.forEach((share, index) => {
    sel.captureShares[index]! = packings[index]!.captures.size + share;
  });
  return true;
}

function recordCaptureOmissions(
  packings: readonly ParticipantPacking[],
  sel: CaptureSelection,
  omissions: Set<string>,
): void {
  const { limits } = sel;
  for (const [index, packing] of packings.entries()) {
    if (!packing.stream.actor)
      omissions.add("Some participants have no normalized recorded trace.");
    if (hasUnmappedCaptures(packing.stream))
      omissions.add("Some declared captures have no normalized trace reference.");
    for (const source of packing.captures.keys()) packing.admitted.add(source);
    for (const source of sourceOrder(packing.entries, false)) {
      if (packing.admitted.size >= sel.evidenceShares[index]!) break;
      packing.admitted.add(source);
    }
    if (packing.admitted.size < packing.entries.length)
      omissions.add("Some evidence was omitted by the packet size limit.");
    if (
      packing.entries.some((entry) => entry.capturePath !== null && !packing.captures.has(entry))
    ) {
      const pending = packing.captureCursor < sel.captureOrders[index]!.length;
      if (pending && sel.captureCount >= limits.captures)
        omissions.add("Some captures were omitted by the capture count limit.");
      if (pending && sel.imageBytes >= limits.totalImageBytes)
        omissions.add("Some captures were omitted by the image byte limit.");
      if (pending && sel.returnedImageBytes >= sel.readBudget)
        omissions.add("Some captures were omitted by the bounded read budget.");
      if (
        pending &&
        sel.captureCount < limits.captures &&
        (sel.attemptedReads >= sel.maxAttempts || packing.attempts >= sel.attemptShares[index]!)
      ) {
        omissions.add("Some captures were omitted by the bounded file-attempt limit.");
      }
      omissions.add(
        "Captures were sampled across participants and session boundaries; omitted moments may contain other issues.",
      );
    }
    if (packing.entries.some((entry) => entry.captureDeclared && entry.capturePath === null)) {
      omissions.add("Some screenshot references were absent or nonlocal.");
    }
  }
}

function boundEvidenceText(
  packings: readonly ParticipantPacking[],
  budget: number,
  omissions: Set<string>,
): Map<SourceEntry, string> {
  const textShares = fairShares(
    budget,
    packings.map((packing) =>
      [...packing.admitted].reduce(
        (total, entry) => total + Math.min(16000, Buffer.byteLength(entry.text)),
        0,
      ),
    ),
  );
  const textByEntry = new Map<SourceEntry, string>();
  for (const [index, packing] of packings.entries()) {
    const entries = [...packing.admitted];
    const shares = fairShares(
      textShares[index]!,
      entries.map((entry) => Math.min(16000, Buffer.byteLength(entry.text))),
    );
    for (const [entryIndex, entry] of entries.entries()) {
      const text = boundedText(entry.text, shares[entryIndex]!);
      if (text !== entry.text)
        omissions.add("Some evidence text was truncated by the packet size limit.");
      textByEntry.set(entry, text);
    }
  }
  return textByEntry;
}

function packEvidence(
  selected: readonly RunStream[],
  packings: readonly ParticipantPacking[],
  textByEntry: ReadonlyMap<SourceEntry, string>,
  evidence: AnalysisEvidence[],
  images: StudyAnalysisInput["images"],
): void {
  for (const stream of selected) {
    const packing = packings.find((candidate) => candidate.stream === stream)!;
    for (const source of packing.entries.filter((entry) => packing.admitted.has(entry))) {
      const id = `e${String(evidence.length + 1).padStart(6, "0")}`;
      const bytes = packing.captures.get(source);
      const capture = bytes
        ? {
            eventId: source.eventId,
            path: source.capturePath!,
            sha256: sha256(bytes),
            mimeType: "image/png" as const,
          }
        : null;
      if (bytes)
        images.push({
          evidenceId: id,
          dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        });
      evidence.push({
        id,
        streamId: stream.id,
        eventId: source.eventId,
        kind: source.kind,
        text: textByEntry.get(source)!,
        quoteEligible: source.quoteEligible,
        at: source.at,
        elapsedMs: source.elapsedMs,
        frame: source.frame,
        capture,
      });
    }
  }
}

/** Validate exact source membership before any stored path may be read. */
export async function validateStudyAnalysisEvidence(
  prepared: PreparedRunArtifactPaths,
  artifact: StudyAnalysisArtifact,
  bundleBytes: Buffer,
): Promise<void> {
  if (artifact.captureVersion !== undefined && artifact.captureVersion !== ACTION_CAPTURE_VERSION)
    throw new Error("ANALYSIS_CAPTURE_VERSION_INVALID");
  const bundle = parseSource(prepared, bundleBytes);
  if (artifact.runId !== bundle.runId || artifact.sourceRunSha256 !== sha256(bundleBytes))
    throw new Error("ANALYSIS_SOURCE_CHANGED");
  const included = new Set(artifact.coverage.includedStreamIds);
  const omitted = new Set(artifact.coverage.omittedStreamIds);
  if (
    bundle.streams.some((stream) => !included.has(stream.id) && !omitted.has(stream.id)) ||
    included.size + omitted.size !== bundle.streams.length
  )
    throw new Error("ANALYSIS_SOURCE_COVERAGE_INVALID");
  const sourceByStream = new Map(
    bundle.streams.map((stream) => [
      stream.id,
      sourceEntries(bundle, stream, artifact.captureVersion),
    ]),
  );
  const context = new Map(
    artifact.participants.map((participant) => [participant.streamId, participant]),
  );
  if (context.size !== included.size || artifact.participants.length !== included.size)
    throw new Error("ANALYSIS_PARTICIPANT_INPUT_INVALID");
  for (const stream of bundle.streams.filter((candidate) => included.has(candidate.id))) {
    const participant = context.get(stream.id);
    if (
      !participant ||
      hashStudyAnalysisValue(participant) !==
        hashStudyAnalysisValue(participantSource(stream, artifact.captureVersion))
    ) {
      throw new Error("ANALYSIS_PARTICIPANT_INPUT_INVALID");
    }
    if (
      artifact.captureVersion === ACTION_CAPTURE_VERSION &&
      artifact.coverage.complete &&
      !participant.assignment?.trim()
    )
      throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
    if (
      artifact.captureVersion === ACTION_CAPTURE_VERSION &&
      artifact.coverage.complete &&
      hasUnmappedCaptures(stream)
    )
      throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
  }
  const sourceKeys = new Set<string>();
  const checkedCaptures = new Map<string, string>();
  let checkedImageBytes = 0;
  for (const entry of artifact.evidence) {
    const matches =
      sourceByStream
        .get(entry.streamId)
        ?.filter((source) => source.eventId === entry.eventId && source.kind === entry.kind) ?? [];
    const source = matches[0];
    const sourceKey = JSON.stringify([entry.streamId, entry.kind, entry.eventId]);
    if (sourceKeys.has(sourceKey)) throw new Error("ANALYSIS_SOURCE_REFERENCE_DUPLICATE");
    sourceKeys.add(sourceKey);
    if (
      matches.length !== 1 ||
      source === undefined ||
      !source.text.startsWith(entry.text) ||
      entry.quoteEligible !== source.quoteEligible ||
      entry.at !== source.at ||
      entry.elapsedMs !== source.elapsedMs ||
      entry.frame !== source.frame
    )
      throw new Error("ANALYSIS_SOURCE_REFERENCE_INVALID");
    if (
      artifact.coverage.complete &&
      (entry.text !== source.text ||
        ((source.capturePath !== null ||
          (artifact.captureVersion === ACTION_CAPTURE_VERSION && source.captureDeclared)) &&
          entry.capture === null))
    ) {
      throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
    }
    if (entry.capture !== null) {
      if (
        source.capturePath === null ||
        entry.capture.path !== source.capturePath ||
        entry.capture.eventId !== source.eventId ||
        entry.capture.mimeType !== "image/png"
      )
        throw new Error("ANALYSIS_CAPTURE_REFERENCE_INVALID");
      let hash = checkedCaptures.get(source.capturePath);
      if (hash === undefined) {
        const bytes = await readBoundedStudyFile(
          prepared,
          source.capturePath,
          STUDY_EVIDENCE_LIMITS.imageBytes,
        );
        if (!bytes || screenshotEvidenceError(source.capturePath, bytes) !== null)
          throw new Error("ANALYSIS_CAPTURE_UNAVAILABLE");
        checkedImageBytes += bytes.length;
        if (checkedImageBytes > STUDY_EVIDENCE_LIMITS.totalImageBytes)
          throw new Error("ANALYSIS_IMAGE_LIMIT_EXCEEDED");
        hash = sha256(bytes);
        checkedCaptures.set(source.capturePath, hash);
      }
      if (hash !== entry.capture.sha256) throw new Error("ANALYSIS_CAPTURE_CHANGED");
    }
  }
  if (
    artifact.coverage.complete &&
    [...sourceByStream.values()].reduce((total, entries) => total + entries.length, 0) !==
      artifact.evidence.length
  ) {
    throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
  }

  const current = await readBoundedStudyFile(
    prepared,
    RUN_BUNDLE_FILE,
    STUDY_EVIDENCE_LIMITS.sourceBytes,
  );
  if (!current?.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
}
