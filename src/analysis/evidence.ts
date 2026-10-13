import { createHash } from "node:crypto";
import { screenshotEvidenceError } from "../evidence/image.js";
import { type PreparedRunArtifactPaths } from "../run/paths.js";
import { RUN_BUNDLE_FILE } from "../run/bundle.js";
import {
  ACTION_CAPTURE_VERSION,
  type AnalysisEvidence,
  type AnalysisArtifact,
  type AnalysisInput,
  type AnalysisParticipantInput,
} from "./types.js";
import {
  digestAnalysisInput,
  hashAnalysisValue,
  validateAnalysisInputMetadata,
} from "./validation.js";
import {
  boundedText,
  fairShares,
  hasUnmappedCaptures,
  participantAssignment,
  participantSource,
  participantSources,
  sourceEntries,
  type ParticipantSources,
  type SourceEntry,
} from "./evidence-sources.js";
import { readBoundedFile, readBoundedFileResult } from "../run/evidence-files.js";
import { analysisCohortCount, analysisCohorts, EVIDENCE_LIMITS } from "./analysis-limits.js";
import { parseAnalysisSource, readParticipantTraces, runFileTooLarge } from "./source.js";

export { EVIDENCE_LIMITS };
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

/** Lower limits: `participants` for the run, the rest for each cohort's packet. The cohort size
 * stays `EVIDENCE_LIMITS.cohortParticipants`, the size runAnalysis splits by. */
export type EvidenceLimits = {
  [Key in Exclude<keyof typeof EVIDENCE_LIMITS, "cohortParticipants">]?: number;
};
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Select once from retained source. Models receive no filesystem or network resolver. */
export async function captureEvidence(
  prepared: PreparedRunArtifactPaths,
  bundleBytes: Buffer,
  requested: EvidenceLimits = {},
): Promise<AnalysisInput> {
  const limits: Record<keyof typeof EVIDENCE_LIMITS, number> = { ...EVIDENCE_LIMITS, ...requested };
  for (const key of Object.keys(EVIDENCE_LIMITS) as Array<keyof typeof EVIDENCE_LIMITS>) {
    if (
      !Number.isSafeInteger(limits[key]) ||
      limits[key] < 1 ||
      limits[key] > EVIDENCE_LIMITS[key]
    ) {
      throw new Error("ANALYSIS_INPUT_LIMIT_INVALID");
    }
  }
  if (bundleBytes.length > limits.sourceBytes)
    throw runFileTooLarge(bundleBytes.length, limits.sourceBytes);
  const current = await readBoundedFile(prepared, RUN_BUNDLE_FILE, limits.sourceBytes);
  if (!current || !current.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  const bundle = parseAnalysisSource(prepared, bundleBytes);
  const captureVersion = ACTION_CAPTURE_VERSION;
  if (
    bundle.streams.some(
      (stream) => stream.liveActor !== undefined || UNFINISHED_STREAM_STATUSES.has(stream.status),
    )
  ) {
    throw new Error("ANALYSIS_RUN_UNFINISHED");
  }
  // A participant's evidence share is at most limits.evidence, and admission stops at its share,
  // so selection never admits past the first limits.evidence entries in admission order.
  const reach = { entries: limits.evidence, captures: maxCaptureReads(limits) };
  const sources = await readParticipantTraces(prepared, bundle, (stream, index) =>
    participantSources(bundle, bundle.streams[index]!, stream, captureVersion, reach),
  );
  const selected = sources.slice(0, limits.participants);
  const evidence: AnalysisEvidence[] = [];
  const images: AnalysisInput["images"] = [];
  const omissions = new Set<string>();
  const contextBytes = new Map<ParticipantSources, number>();
  const participants = selected.map((sources) => {
    const { participant, stream } = sources;
    const assignment = participantAssignment(stream, captureVersion);
    if (assignment === null || assignment.trim() === "")
      omissions.add("Some participants have no recorded assignment.");
    if (
      participant.label !== stream.label ||
      participant.assignment !== assignment ||
      participant.recordedReason !== (stream.actor?.reason ?? null)
    )
      omissions.add("Participant context exceeded the text limit.");
    contextBytes.set(sources, Buffer.byteLength(JSON.stringify(participant)));
    return participant;
  });
  // Each cohort is one request's packet, selected under the full limits on its own.
  const packings: ParticipantPacking[] = [];
  const textByEntry = new Map<SourceEntry, string>();
  for (const cohort of analysisCohorts(selected)) {
    const textBytes = cohort.reduce((total, sources) => total + contextBytes.get(sources)!, 0);
    if (textBytes > limits.textBytes) throw new Error("ANALYSIS_PARTICIPANT_CONTEXT_TOO_LARGE");
    // Tie-breaking uses stable participant IDs, not the order of streams in a bundle.
    // The emitted packet still preserves participant and source event order.
    const cohortPackings = cohort
      .map((sources) => ({
        sources,
        captures: new Map<SourceEntry, Buffer>(),
        admitted: new Set<SourceEntry>(),
        captureCursor: 0,
        attempts: 0,
        readBytes: 0,
        imageBytes: 0,
        reservationBlocked: false,
      }))
      .sort((a, b) => {
        const [left, right] = [a.sources.stream.id, b.sources.stream.id];
        return left < right ? -1 : left > right ? 1 : 0;
      });
    const sel = planCaptureSelection(cohortPackings, limits);
    await selectCaptures(prepared, cohortPackings, sel, omissions);
    recordCaptureOmissions(cohortPackings, sel, omissions);
    for (const [entry, text] of boundEvidenceText(
      cohortPackings,
      limits.textBytes - textBytes,
      omissions,
    ))
      textByEntry.set(entry, text);
    packings.push(...cohortPackings);
  }
  packEvidence(selected, packings, textByEntry, evidence, images);
  const omittedStreamIds = bundle.streams.slice(limits.participants).map((stream) => stream.id);
  const coverage = {
    includedStreamIds: selected.map((sources) => sources.stream.id),
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
  result.inputDigest = digestAnalysisInput(result);
  validateAnalysisInputMetadata(result);
  const after = await readBoundedFile(prepared, RUN_BUNDLE_FILE, limits.sourceBytes);
  if (!after || !after.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  return result;
}

/** A participant's part of the evidence packet: its sources, and what selection has admitted,
 * captured and spent for it. */
interface ParticipantPacking {
  sources: ParticipantSources;
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
  readonly limits: Required<EvidenceLimits>;
  readonly evidenceShares: number[];
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

/**
 * The most capture reads one cohort's selection makes. Missing/invalid files cannot turn selection
 * into an exhaustive file scan: at most 2 * captures bounded reads, each at most imageBytes;
 * successfully returned bytes (including invalid PNGs) also stop at 2 * totalImageBytes. A read
 * moves its participant's cursor at most one capture on: a reserved read that meets the byte limit
 * leaves the cursor for a later pass. So no participant's reads pass this many captures.
 */
const maxCaptureReads = (limits: Required<EvidenceLimits>): number => 2 * limits.captures;

function planCaptureSelection(
  packings: readonly ParticipantPacking[],
  limits: Required<EvidenceLimits>,
): CaptureSelection {
  const maxAttempts = maxCaptureReads(limits);
  const readBudget = 2 * limits.totalImageBytes;
  const evidenceShares = fairShares(
    limits.evidence,
    packings.map((packing) => packing.sources.entryCount),
  );
  const captureShares = fairShares(
    limits.captures,
    packings.map((packing, index) =>
      Math.min(evidenceShares[index]!, packing.sources.captureCount),
    ),
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
        packing.captureCursor >= packing.sources.captureOrder.length ||
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
      const source = packing.sources.captureOrder[packing.captureCursor]!;
      const result = await readBoundedFileResult(prepared, source.capturePath!, allowance);
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
  // A pass reads only the captures in captureOrder. A slot granted past them is one no pass uses,
  // and selectCaptures would reclaim it again forever.
  const available = packings.map((packing, index) =>
    packing.attempts < sel.attemptShares[index]!
      ? Math.min(
          sel.evidenceShares[index]! - packing.captures.size,
          packing.sources.captureOrder.length - packing.captureCursor,
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
    const { sources } = packing;
    if (!sources.stream.actor)
      omissions.add("Some participants have no normalized recorded trace.");
    if (sources.unmappedCaptures)
      omissions.add("Some declared captures have no normalized trace reference.");
    for (const source of packing.captures.keys()) packing.admitted.add(source);
    for (const source of sources.textOrder) {
      if (packing.admitted.size >= sel.evidenceShares[index]!) break;
      packing.admitted.add(source);
    }
    if (packing.admitted.size < sources.entryCount)
      omissions.add("Some evidence was omitted by the packet size limit.");
    if (sources.captureCount > packing.captures.size) {
      const pending = packing.captureCursor < sources.captureCount;
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
    if (sources.unresolvedCaptures)
      omissions.add("Some screenshot references were absent or nonlocal.");
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
  selected: readonly ParticipantSources[],
  packings: readonly ParticipantPacking[],
  textByEntry: ReadonlyMap<SourceEntry, string>,
  evidence: AnalysisEvidence[],
  images: AnalysisInput["images"],
): void {
  for (const sources of selected) {
    const { stream } = sources;
    const packing = packings.find((candidate) => candidate.sources === sources)!;
    for (const source of sources.entries.filter((entry) => packing.admitted.has(entry))) {
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

/** What validateAnalysisEvidence checks of one stream, taken while its trace is loaded. */
interface CheckedStream {
  readonly participant: AnalysisParticipantInput;
  readonly unmappedCaptures: boolean;
  readonly entryCount: number;
  /** For each kind and event id the artifact cites in this stream, the source entries that match. */
  readonly cited: ReadonlyMap<string, SourceEntry[]>;
}

const citation = (kind: string, eventId: string): string => JSON.stringify([kind, eventId]);

/** Validate exact source membership before any stored path may be read. */
export async function validateAnalysisEvidence(
  prepared: PreparedRunArtifactPaths,
  artifact: AnalysisArtifact,
  bundleBytes: Buffer,
): Promise<void> {
  if (artifact.captureVersion !== undefined && artifact.captureVersion !== ACTION_CAPTURE_VERSION)
    throw new Error("ANALYSIS_CAPTURE_VERSION_INVALID");
  const bundle = parseAnalysisSource(prepared, bundleBytes);
  const citations = new Map<string, Set<string>>();
  for (const entry of artifact.evidence)
    citations.set(
      entry.streamId,
      (citations.get(entry.streamId) ?? new Set()).add(citation(entry.kind, entry.eventId)),
    );
  const checked = new Map(
    await readParticipantTraces(prepared, bundle, (stream): [string, CheckedStream] => {
      const entries = sourceEntries(bundle, stream, artifact.captureVersion);
      const cited = new Map<string, SourceEntry[]>();
      for (const entry of entries) {
        const key = citation(entry.kind, entry.eventId);
        if (citations.get(stream.id)?.has(key)) cited.set(key, [...(cited.get(key) ?? []), entry]);
      }
      const participant = participantSource(stream, artifact.captureVersion);
      const unmappedCaptures = hasUnmappedCaptures(stream);
      return [stream.id, { participant, unmappedCaptures, entryCount: entries.length, cited }];
    }),
  );
  if (artifact.runId !== bundle.runId || artifact.sourceRunSha256 !== sha256(bundleBytes))
    throw new Error("ANALYSIS_SOURCE_CHANGED");
  const included = new Set(artifact.coverage.includedStreamIds);
  const omitted = new Set(artifact.coverage.omittedStreamIds);
  if (
    bundle.streams.some((stream) => !included.has(stream.id) && !omitted.has(stream.id)) ||
    included.size + omitted.size !== bundle.streams.length
  )
    throw new Error("ANALYSIS_SOURCE_COVERAGE_INVALID");
  const context = new Map(
    artifact.participants.map((participant) => [participant.streamId, participant]),
  );
  if (context.size !== included.size || artifact.participants.length !== included.size)
    throw new Error("ANALYSIS_PARTICIPANT_INPUT_INVALID");
  for (const stream of bundle.streams.filter((candidate) => included.has(candidate.id))) {
    const participant = context.get(stream.id);
    const source = checked.get(stream.id)!;
    if (!participant || hashAnalysisValue(participant) !== hashAnalysisValue(source.participant)) {
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
      source.unmappedCaptures
    )
      throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
  }
  const sourceKeys = new Set<string>();
  const checkedCaptures = new Map<string, string>();
  // Each cohort's packet holds at most totalImageBytes.
  const imageByteLimit = analysisCohortCount(included.size) * EVIDENCE_LIMITS.totalImageBytes;
  let checkedImageBytes = 0;
  for (const entry of artifact.evidence) {
    const matches =
      checked.get(entry.streamId)?.cited.get(citation(entry.kind, entry.eventId)) ?? [];
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
        const bytes = await readBoundedFile(
          prepared,
          source.capturePath,
          EVIDENCE_LIMITS.imageBytes,
        );
        if (!bytes || screenshotEvidenceError(source.capturePath, bytes) !== null)
          throw new Error("ANALYSIS_CAPTURE_UNAVAILABLE");
        checkedImageBytes += bytes.length;
        if (checkedImageBytes > imageByteLimit) throw new Error("ANALYSIS_IMAGE_LIMIT_EXCEEDED");
        hash = sha256(bytes);
        checkedCaptures.set(source.capturePath, hash);
      }
      if (hash !== entry.capture.sha256) throw new Error("ANALYSIS_CAPTURE_CHANGED");
    }
  }
  if (
    artifact.coverage.complete &&
    [...checked.values()].reduce((total, stream) => total + stream.entryCount, 0) !==
      artifact.evidence.length
  ) {
    throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
  }

  const current = await readBoundedFile(prepared, RUN_BUNDLE_FILE, EVIDENCE_LIMITS.sourceBytes);
  if (!current?.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
}
