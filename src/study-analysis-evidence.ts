import { isCommsReceivingEvidence, receivingAnalysisContext } from "./comms-receiving-evidence.js";
import { cuaGoalSource } from "./actor-goal-source.js";
import { createHash } from "node:crypto";
import { screenshotEvidenceError } from "./image-evidence.js";
import type { PreparedRunArtifactPaths } from "./run-paths.js";
import type { ActorTraceItem } from "./actor-contract.js";
import type { RunBundle, RunStream } from "./run.js";
import type { AnalysisEvidence, AnalysisParticipantInput, StudyAnalysisArtifact, StudyAnalysisInput } from "./study-analysis.js";
import { digestStudyAnalysisInput, hashStudyAnalysisValue, validateStudyAnalysisInputMetadata } from "./study-analysis-validation.js";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { isPathInside, validatePreparedRunRootIdentity } from "./run-paths.js";
import {
  assertPreparedSelectedOutputDirectory,
  type PreparedOutputRoot
} from "./selected-output-paths.js";

/** Analysis inputs are retained local artifacts, never URLs or caller-selected outputs. */
export function isStudyEvidencePath(value: string): boolean {
  if (!value || value.length > 1024) return false;
  try { encodeURIComponent(value); } catch { return false; }
  let checked = value;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (/[\\:\x00-\x1f\x7f]/.test(checked) || checked.startsWith("/")
      || checked.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
    let decoded: string;
    try { decoded = decodeURIComponent(checked); } catch { return !/%[0-9a-f]{2}/i.test(checked); }
    if (decoded === checked) return true;
    if (decoded.split("/").length !== checked.split("/").length) return false;
    checked = decoded;
  }
  return false;
}

/**
 * Bounded companion to readContainedRegularFile. A growing or swapped file must
 * not turn an analysis budget into an unbounded read. No returned bytes have
 * authority to select another file or initiate a network request.
 */
export async function readBoundedStudyFile(
  root: PreparedOutputRoot,
  relativePath: string,
  maxBytes: number
): Promise<Buffer | null> {
  const result = await readBoundedStudyFileResult(root, relativePath, maxBytes);
  return result.state === "read" ? result.bytes : null;
}

type BoundedStudyFileResult = { state: "read"; bytes: Buffer } | { state: "limit"; size: bigint } | { state: "unavailable" };
const unavailable = { state: "unavailable" } as const;

/** Size refusals are distinguished only after the same contained regular-file checks. */
async function readBoundedStudyFileResult(root: PreparedOutputRoot, relativePath: string, maxBytes: number): Promise<BoundedStudyFileResult> {
  if (!isStudyEvidencePath(relativePath) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) return unavailable;
  const validateRoot = async (): Promise<string> => {
    if ("physicalRunRoot" in root) {
      await validatePreparedRunRootIdentity(root);
      return root.physicalRunRoot;
    }
    await assertPreparedSelectedOutputDirectory(root);
    return root.physicalPath;
  };
  try {
    const physicalRoot = await validateRoot();
    const candidate = path.join(physicalRoot, relativePath);
    if (!isPathInside(physicalRoot, candidate) || candidate === physicalRoot) return unavailable;
    const validateParents = async (): Promise<void> => {
      let current = physicalRoot;
      for (const segment of relativePath.split("/").slice(0, -1)) {
        current = path.join(current, segment);
        const info = await lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe analysis input directory.");
      }
    };
    await validateParents();
    const before = await lstat(candidate, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) return unavailable;
    if (await realpath(candidate) !== candidate) return unavailable;
    if (before.size > BigInt(maxBytes)) {
      if (await validateRoot() !== physicalRoot) return unavailable;
      await validateParents();
      const final = await lstat(candidate, { bigint: true });
      if (!final.isFile() || final.isSymbolicLink() || final.nlink !== 1n || final.dev !== before.dev
        || final.ino !== before.ino || final.size !== before.size || final.mtimeNs !== before.mtimeNs
        || final.ctimeNs !== before.ctimeNs) return unavailable;
      return { state: "limit", size: before.size };
    }
    // O_NONBLOCK avoids hanging if a regular leaf is raced into a special file.
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) return unavailable;
      const chunks: Buffer[] = [];
      let total = 0;
      while (total <= maxBytes) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) return unavailable;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
        || after.nlink !== 1n || total !== Number(before.size)) return unavailable;
      if (await validateRoot() !== physicalRoot) return unavailable;
      await validateParents();
      const final = await lstat(candidate, { bigint: true });
      if (!final.isFile() || final.isSymbolicLink() || final.dev !== before.dev || final.ino !== before.ino
        || final.nlink !== 1n || final.size !== before.size || final.mtimeNs !== before.mtimeNs) return unavailable;
      return { state: "read", bytes: Buffer.concat(chunks, total) };
    } finally {
      await handle.close();
    }
  } catch {
    return unavailable;
  }
}



export const STUDY_EVIDENCE_LIMITS = Object.freeze({
  participants: 16, evidence: 800, captures: 40, textBytes: 160 * 1024,
  imageBytes: 8 * 1024 * 1024, totalImageBytes: 20 * 1024 * 1024,
  sourceBytes: 16 * 1024 * 1024
});
export type StudyEvidenceLimits = { [Key in keyof typeof STUDY_EVIDENCE_LIMITS]?: number };
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const stamp = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value))
  ? new Date(value).toISOString() : null;
const itemText = (item: ActorTraceItem): string => ["message", "reasoning"].includes(item.kind) && item.text !== undefined
  ? item.text : [item.title, item.text].filter((entry) => entry !== undefined && entry !== "").join("\n");
const itemsFor = (stream: RunStream): ActorTraceItem[] => stream.actor?.items ?? [];
const isCaptureItem = (item: ActorTraceItem, captureVersion?: 2): boolean => item.kind === "screenshot"
  || (captureVersion === 2 && item.kind === "ui_action");

function hasUnmappedCaptures(stream: RunStream): boolean {
  const items = itemsFor(stream);
  const paths = new Set(items.flatMap((item) => isCaptureItem(item, 2) && typeof item.screenshotRef?.path === "string" ? [item.screenshotRef.path] : []));
  // Presentation URLs use Observer-relative paths. They cannot manufacture an
  // event/frame, but a declared capture outside the trace must limit coverage.
  const previews = [stream.ui?.screenshotUrl, stream.embed?.kind === "screenshot" ? stream.embed.url : undefined];
  return (Array.isArray(stream.artifacts) && stream.artifacts.some((artifact) => artifact?.kind === "screenshot" && !paths.has(artifact.path)))
    || previews.some((ref) => typeof ref === "string" && !paths.has(ref) && !paths.has(ref.replace(/^\.\.\//, "")))
    || items.some((item) => typeof item.screenshotRef?.path === "string" && !paths.has(item.screenshotRef.path));
}

function parseSource(prepared: PreparedRunArtifactPaths, bytes: Buffer): RunBundle {
  if (bytes.length > STUDY_EVIDENCE_LIMITS.sourceBytes) throw new Error("ANALYSIS_SOURCE_TOO_LARGE");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!object(value) || value.schema !== "humanish.run-bundle.v1"
    || value.runId !== path.basename(prepared.physicalRunRoot)
    || !Array.isArray(value.streams) || value.streams.length > 128 || !Array.isArray(value.events)
    || value.events.length > 100000
    || (value.commsReceiving !== undefined && !isCommsReceivingEvidence(value.commsReceiving))) throw new Error("ANALYSIS_SOURCE_INVALID");
  const ids = new Set<string>();
  for (const stream of value.streams) {
    if (!object(stream) || typeof stream.id !== "string" || stream.id.length === 0 || stream.id.length > 256
      || ids.has(stream.id) || typeof stream.label !== "string" || typeof stream.status !== "string") {
      throw new Error("ANALYSIS_SOURCE_INVALID");
    }
    ids.add(stream.id);
    const actor = stream.actor;
    if (actor !== undefined && (!object(actor) || !Array.isArray(actor.items) || actor.items.length > 100000)) {
      throw new Error("ANALYSIS_SOURCE_INVALID");
    }
    const eventIds = new Set<string>();
    for (const item of object(actor) ? actor.items as unknown[] : []) {
      if (!object(item) || typeof item.id !== "string" || item.id.length === 0 || item.id.length > 256
        || eventIds.has(item.id) || typeof item.kind !== "string" || typeof item.title !== "string"
        || (item.text !== undefined && typeof item.text !== "string")) throw new Error("ANALYSIS_SOURCE_INVALID");
      eventIds.add(item.id);
    }
  }
  for (const event of value.events) {
    if (!object(event) || typeof event.id !== "string" || typeof event.message !== "string"
      || typeof event.type !== "string") throw new Error("ANALYSIS_SOURCE_INVALID");
  }
  return value as unknown as RunBundle;
}

function boundedText(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let output = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output;
}

// Count the same frame declarations as Observer even when analysis omits their bytes.
function isObserverCapturePath(value: string): boolean {
  if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return true;
  if (!value || value.length > 8192) return false;
  try { encodeURIComponent(value); } catch { return false; }
  let checked = value;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (/^[\\/]|[\\\u0000-\u001f\u007f]|^[a-z][a-z\d+.-]*:/i.test(checked)
      || checked.split("/").some((part) => part === "." || part === ".." || part === "")) return false;
    let decoded: string;
    try { decoded = decodeURIComponent(checked); } catch { return !/%[0-9a-f]{2}/i.test(checked); }
    if (decoded === checked) return true;
    if (decoded.split("/").length !== checked.split("/").length) return false;
    checked = decoded;
  }
  return false;
}

function participantAssignment(stream: RunStream, captureVersion?: 2): string | null {
  if (stream.assignment === undefined) return captureVersion === 2 && stream.actor?.lane === "scripted-browser"
    && typeof stream.ui?.intent === "string" && stream.ui.intent.trim() ? stream.ui.intent : null;
  return [stream.assignment.mission, stream.assignment.focus,
    ...(stream.assignment.tasks ?? []).map((task) => `Task ${JSON.stringify(task.id)}: ${task.goal}`)]
    .filter((entry) => typeof entry === "string").join("\n");
}

function participantSource(stream: RunStream, captureVersion?: 2): AnalysisParticipantInput {
  const assignment = participantAssignment(stream, captureVersion);
  const actor = stream.actor;
  return {
    streamId: stream.id,
    label: boundedText(stream.label, 1000),
    assignment: assignment === null ? null : boundedText(assignment, 8000),
    recordedStatus: stream.status,
    recordedReason: actor?.reason === undefined ? null : boundedText(actor.reason, 4000),
    provenance: {
      actorStatus: actor?.status ?? null,
      completionReason: actor?.completionReason ?? null,
      stopCause: actor?.stopCause ?? null,
      goalSource: cuaGoalSource(actor, stream.status) ?? null,
      declaredOutcome: actor?.declaredOutcome ?? null,
      taskOutcomes: actor?.taskFunnel === undefined ? null : actor.taskFunnel.tasks.map((task) => ({
        taskId: task.id, completed: task.completed, observable: task.observable,
        inputsObserved: task.inputsObserved ?? null, turn: task.turn ?? null
      }))
    }
  };
}

interface SourceEntry {
  eventId: string;
  kind: string;
  text: string;
  quoteEligible: boolean;
  at: string | null;
  elapsedMs: number | null;
  frame: number | null;
  capturePath: string | null;
  captureDeclared: boolean;
  failed: boolean;
}
function sourceEntries(bundle: RunBundle, stream: RunStream, captureVersion?: 2): SourceEntry[] {
  const items = itemsFor(stream);
  // Absent version retains the exact legacy mapping used by saved 0.89.1 analyses.
  // V2 follows the actor contract: a scripted action can carry its own capture.
  const captures = items.filter((item) => isCaptureItem(item, captureVersion) && object(item.screenshotRef)
    && typeof item.screenshotRef.path === "string" && isObserverCapturePath(item.screenshotRef.path));
  const frameIds = new Set(captures.map((item) => item.id));
  const firstAt = stamp(captures[0]?.at);
  let frame = -1;
  const entries: SourceEntry[] = [];
  if (captureVersion === 2 && bundle.commsReceiving) {
    entries.push({ eventId: `comms-receiving-${stream.id}`, kind: "harness:email_receiving",
      text: receivingAnalysisContext(bundle.commsReceiving, stream.laneId), quoteEligible: false,
      at: null, elapsedMs: null, frame: null, capturePath: null, captureDeclared: false,
      failed: bundle.commsReceiving.limitations.length > 0 || bundle.commsReceiving.participants.some(p => p.limitations.length > 0) });
  }
  for (const item of items) {
    const capturePath = isCaptureItem(item, captureVersion) && object(item.screenshotRef)
      && typeof item.screenshotRef.path === "string" && isStudyEvidencePath(item.screenshotRef.path)
      ? item.screenshotRef.path : null;
    if (frameIds.has(item.id)) frame++;
    const at = stamp(item.at);
    const delta = at !== null && firstAt !== null ? Date.parse(at) - Date.parse(firstAt) : null;
    entries.push({ eventId: item.id, kind: item.kind, text: itemText(item),
      quoteEligible: ["message", "reasoning"].includes(item.kind) && typeof item.text === "string",
      at, elapsedMs: delta !== null && delta >= 0 ? delta : null,
      frame: captures.length > 0 ? Math.max(0, frame) : null, capturePath,
      captureDeclared: item.kind === "screenshot" || (captureVersion === 2 && item.kind === "ui_action" && item.screenshotRef !== undefined),
      failed: ["failed", "blocked", "timed_out"].includes(item.status ?? "") });
  }
  const runEventIds = new Set<string>();
  for (const event of bundle.events.filter((entry) => entry.streamId === stream.id
    || (entry.streamId === undefined && entry.simId === stream.simId))) {
    if (runEventIds.has(event.id)) throw new Error("ANALYSIS_SOURCE_EVENT_DUPLICATE");
    runEventIds.add(event.id);
    entries.push({ eventId: event.id, kind: `run_event:${event.type}`, text: event.message,
      quoteEligible: false, at: stamp(event.at), elapsedMs: null, frame: null, capturePath: null, captureDeclared: false, failed: event.level === "error" });
  }
  return entries;
}

/** Max-min allocation; stable ID order breaks a remainder tie by at most one slot. */
function fairShares(budget: number, capacities: number[]): number[] {
  const shares = capacities.map(() => 0);
  let active = capacities.map((capacity, index) => ({ capacity, index })).filter(({ capacity }) => capacity > 0);
  while (budget > 0 && active.length > 0) {
    const share = Math.max(1, Math.floor(budget / active.length));
    for (const { capacity, index } of active) {
      const granted = Math.min(capacity - shares[index]!, share, budget);
      shares[index]! += granted;
      budget -= granted;
    }
    active = active.filter(({ capacity, index }) => shares[index]! < capacity);
  }
  return shares;
}

/** End, start, then successively bisect the whole interval; no prefix sampling. */
function spreadOrder<T>(entries: T[]): T[] {
  if (entries.length < 2) return entries;
  const result = [entries.at(-1)!, entries[0]!];
  const ranges: Array<[number, number]> = [[0, entries.length - 1]];
  for (let cursor = 0; cursor < ranges.length; cursor++) {
    const [left, right] = ranges[cursor]!;
    if (right - left < 2) continue;
    const middle = Math.floor((left + right) / 2);
    result.push(entries[middle]!);
    ranges.push([left, middle], [middle, right]);
  }
  return result;
}

function sourceOrder(entries: SourceEntry[], capturesOnly: boolean): SourceEntry[] {
  const candidates = capturesOnly ? entries.filter((entry) => entry.capturePath !== null) : entries;
  const ordered = new Set<SourceEntry>();
  const admit = (entry: SourceEntry | undefined): void => {
    if (entry && (!capturesOnly || entry.capturePath !== null)) ordered.add(entry);
  };
  // Actor endings precede appended run bookkeeping when text slots are scarce.
  if (!capturesOnly) admit(entries.findLast((entry) => !entry.kind.startsWith("run_event:")));
  admit(candidates.at(-1));
  admit(candidates[0]);
  const afterCapture: Array<SourceEntry | undefined> = [];
  let nextCapture: SourceEntry | undefined;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    afterCapture[index] = nextCapture;
    if (entry.capturePath !== null) nextCapture = entry;
  }
  let beforeCapture: SourceEntry | undefined;
  const failureContext: SourceEntry[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (entry.failed) {
      for (const context of [entry, afterCapture[index], beforeCapture, entries[index + 1]]) {
        if (context) failureContext.push(context);
      }
    }
    if (entry.capturePath !== null) beforeCapture = entry;
  }
  // Explicit failure status/level is source metadata, not a keyword diagnosis.
  // Spread among failures as well: many early failures cannot hide the last one.
  for (const entry of spreadOrder(failureContext)) admit(entry);
  for (const entry of spreadOrder(candidates)) admit(entry);
  return [...ordered];
}

/** Select once from retained source. Models receive no filesystem or network resolver. */
export async function captureStudyEvidence(
  prepared: PreparedRunArtifactPaths,
  bundleBytes: Buffer,
  requested: StudyEvidenceLimits = {}
): Promise<StudyAnalysisInput> {
  const limits: Required<StudyEvidenceLimits> = { ...STUDY_EVIDENCE_LIMITS, ...requested };
  for (const key of Object.keys(STUDY_EVIDENCE_LIMITS) as Array<keyof typeof STUDY_EVIDENCE_LIMITS>) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > STUDY_EVIDENCE_LIMITS[key]) {
      throw new Error("ANALYSIS_INPUT_LIMIT_INVALID");
    }
  }
  if (bundleBytes.length > limits.sourceBytes) throw new Error("ANALYSIS_SOURCE_TOO_LARGE");
  const current = await readBoundedStudyFile(prepared, "run.json", limits.sourceBytes);
  if (!current || !current.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  const bundle = parseSource(prepared, bundleBytes);
  const captureVersion = 2 as const;
  if (bundle.streams.some((stream) => stream.liveActor !== undefined
    || ["running", "pending", "queued", "starting", "preparing", "not_started", "suspended"].includes(stream.status))) {
    throw new Error("ANALYSIS_RUN_UNFINISHED");
  }
  const selected = bundle.streams.slice(0, limits.participants);
  const evidence: AnalysisEvidence[] = [];
  const images: StudyAnalysisInput["images"] = [];
  const omissions = new Set<string>();
  let textBytes = 0;
  let imageBytes = 0;
  const participants = selected.map((stream) => {
    const participant = participantSource(stream, captureVersion);
    const assignment = participantAssignment(stream, captureVersion);
    if (assignment === null || assignment.trim() === "") omissions.add("Some participants have no recorded assignment.");
    if (participant.label !== stream.label || participant.assignment !== assignment
      || participant.recordedReason !== (stream.actor?.reason ?? null)) omissions.add("Participant context exceeded the text limit.");
    textBytes += Buffer.byteLength(JSON.stringify(participant));
    return participant;
  });
  if (textBytes > limits.textBytes) throw new Error("ANALYSIS_PARTICIPANT_CONTEXT_TOO_LARGE");
  // Tie-breaking uses stable participant IDs, not the order of streams in a bundle.
  // The emitted packet still preserves participant and source event order.
  const lanes = selected.map((stream) => ({ stream, entries: sourceEntries(bundle, stream, captureVersion),
    captures: new Map<SourceEntry, Buffer>(), admitted: new Set<SourceEntry>(), captureCursor: 0, attempts: 0, readBytes: 0, imageBytes: 0,
    reservationBlocked: false }))
    .sort((a, b) => a.stream.id < b.stream.id ? -1 : a.stream.id > b.stream.id ? 1 : 0);
  const evidenceShares = fairShares(limits.evidence, lanes.map((lane) => lane.entries.length));
  const captureOrders = lanes.map((lane) => sourceOrder(lane.entries, true));
  const captureShares = fairShares(limits.captures, lanes.map((_, index) => Math.min(evidenceShares[index]!, captureOrders[index]!.length)));
  const attemptShares = captureShares.map((share) => 2 * share);
  const readShares = fairShares(2 * limits.totalImageBytes, attemptShares.map((share) => share * limits.imageBytes));
  const imageShares = fairShares(limits.totalImageBytes, captureShares.map((share) => share * limits.imageBytes));
  let captureCount = 0;
  let attemptedReads = 0;
  let returnedImageBytes = 0;
  let reserved = true;
  // Missing/invalid files cannot turn selection into an exhaustive file scan.
  // At most 2 * captures bounded reads, each at most imageBytes; successfully
  // returned bytes (including invalid PNGs) also stop at 2 * totalImageBytes.
  const maxAttempts = 2 * limits.captures;
  while (attemptedReads < maxAttempts && captureCount < limits.captures
    && imageBytes < limits.totalImageBytes && returnedImageBytes < 2 * limits.totalImageBytes) {
    let attempted = false;
    for (const [index, lane] of lanes.entries()) {
      if (lane.captures.size >= captureShares[index]! || lane.attempts >= attemptShares[index]!
        || lane.captureCursor >= captureOrders[index]!.length || attemptedReads >= maxAttempts
        || (reserved && lane.reservationBlocked)) continue;
      if (imageBytes >= limits.totalImageBytes || returnedImageBytes >= 2 * limits.totalImageBytes) break;
      const readAllowance = reserved ? readShares[index]! - lane.readBytes : 2 * limits.totalImageBytes - returnedImageBytes;
      const imageAllowance = reserved ? imageShares[index]! - lane.imageBytes : limits.totalImageBytes - imageBytes;
      const allowance = Math.min(limits.imageBytes, limits.totalImageBytes - imageBytes, imageAllowance, readAllowance);
      if (allowance <= 0) {
        lane.reservationBlocked = true;
        continue;
      }
      attempted = true;
      lane.attempts++; attemptedReads++;
      const source = captureOrders[index]![lane.captureCursor]!;
      const result = await readBoundedStudyFileResult(prepared, source.capturePath!, allowance);
      if (result.state === "limit" && result.size <= BigInt(limits.imageBytes)
        && result.size <= BigInt(limits.totalImageBytes - imageBytes) && reserved) {
        // This participant's reservation is too small, not its evidence unsafe.
        // Preserve the candidate for the shared pool after all reserved passes.
        lane.reservationBlocked = true;
        continue;
      }
      lane.captureCursor++;
      if (result.state === "limit" && result.size <= BigInt(limits.imageBytes)) {
        omissions.add(result.size > BigInt(limits.totalImageBytes - imageBytes)
          ? "Some captures were omitted by the image byte limit."
          : "Some captures were omitted by the bounded read budget.");
        continue;
      }
      const bytes = result.state === "read" ? result.bytes : null;
      returnedImageBytes += bytes?.length ?? 0;
      lane.readBytes += bytes?.length ?? 0;
      if (bytes === null || screenshotEvidenceError(source.capturePath!, bytes) !== null) {
        omissions.add("Some captures were missing, unsafe, oversized, or invalid PNG evidence.");
        continue;
      }
      imageBytes += bytes.length;
      lane.imageBytes += bytes.length;
      captureCount++;
      lane.captures.set(source, bytes);
    }
    if (!attempted) {
      // Release unused read/admission reservations after every reserved pass.
      // Zero-share lanes can now compete for reclaimed slots, with two attempts.
      reserved = false;
      attemptShares.forEach((share, index) => { if (share === 0 && evidenceShares[index]! > 0) attemptShares[index] = 2; });
      const extra = fairShares(limits.captures - captureCount, lanes.map((lane, index) =>
        lane.attempts < attemptShares[index]! ? Math.min(evidenceShares[index]! - lane.captures.size,
          captureOrders[index]!.length - lane.captureCursor, attemptShares[index]! - lane.attempts) : 0));
      if (!extra.some((share) => share > 0) || imageBytes >= limits.totalImageBytes
        || returnedImageBytes >= 2 * limits.totalImageBytes || attemptedReads >= maxAttempts) break;
      extra.forEach((share, index) => { captureShares[index]! = lanes[index]!.captures.size + share; });
    }
  }
  for (const [index, lane] of lanes.entries()) {
    if (!lane.stream.actor) omissions.add("Some participants have no normalized recorded trace.");
    if (hasUnmappedCaptures(lane.stream)) omissions.add("Some declared captures have no normalized trace reference.");
    for (const source of lane.captures.keys()) lane.admitted.add(source);
    for (const source of sourceOrder(lane.entries, false)) {
      if (lane.admitted.size >= evidenceShares[index]!) break;
      lane.admitted.add(source);
    }
    if (lane.admitted.size < lane.entries.length) omissions.add("Some evidence was omitted by the packet size limit.");
    if (lane.entries.some((entry) => entry.capturePath !== null && !lane.captures.has(entry))) {
      const pending = lane.captureCursor < captureOrders[index]!.length;
      if (pending && captureCount >= limits.captures) omissions.add("Some captures were omitted by the capture count limit.");
      if (pending && imageBytes >= limits.totalImageBytes) omissions.add("Some captures were omitted by the image byte limit.");
      if (pending && returnedImageBytes >= 2 * limits.totalImageBytes) omissions.add("Some captures were omitted by the bounded read budget.");
      if (pending && captureCount < limits.captures
        && (attemptedReads >= maxAttempts || lane.attempts >= attemptShares[index]!)) {
        omissions.add("Some captures were omitted by the bounded file-attempt limit.");
      }
      omissions.add("Captures were sampled across participants and session boundaries; omitted moments may contain other issues.");
    }
    if (lane.entries.some((entry) => entry.captureDeclared && entry.capturePath === null)) {
      omissions.add("Some screenshot references were absent or nonlocal.");
    }
  }
  const textShares = fairShares(limits.textBytes - textBytes, lanes.map((lane) =>
    [...lane.admitted].reduce((total, entry) => total + Math.min(16000, Buffer.byteLength(entry.text)), 0)));
  const textByEntry = new Map<SourceEntry, string>();
  for (const [index, lane] of lanes.entries()) {
    const entries = [...lane.admitted];
    const shares = fairShares(textShares[index]!, entries.map((entry) => Math.min(16000, Buffer.byteLength(entry.text))));
    for (const [entryIndex, entry] of entries.entries()) {
      const text = boundedText(entry.text, shares[entryIndex]!);
      if (text !== entry.text) omissions.add("Some evidence text was truncated by the packet size limit.");
      textByEntry.set(entry, text);
    }
  }
  for (const stream of selected) {
    const lane = lanes.find((candidate) => candidate.stream === stream)!;
    for (const source of lane.entries.filter((entry) => lane.admitted.has(entry))) {
      const id = `e${String(evidence.length + 1).padStart(6, "0")}`;
      const bytes = lane.captures.get(source);
      const capture = bytes ? { eventId: source.eventId, path: source.capturePath!, sha256: sha256(bytes), mimeType: "image/png" as const } : null;
      if (bytes) images.push({ evidenceId: id, dataUrl: `data:image/png;base64,${bytes.toString("base64")}` });
      evidence.push({ id, streamId: stream.id, eventId: source.eventId, kind: source.kind, text: textByEntry.get(source)!,
        quoteEligible: source.quoteEligible, at: source.at, elapsedMs: source.elapsedMs, frame: source.frame, capture });
    }
  }
  const omittedStreamIds = bundle.streams.slice(limits.participants).map((stream) => stream.id);
  const coverage = { includedStreamIds: selected.map((stream) => stream.id), omittedStreamIds,
    evidenceCount: evidence.length, captureCount: images.length,
    complete: omittedStreamIds.length === 0 && omissions.size === 0, omissions: [...omissions] };
  const result = { captureVersion, runId: bundle.runId, sourceRunSha256: sha256(bundleBytes), inputDigest: "", participants, coverage, evidence, images };
  result.inputDigest = digestStudyAnalysisInput(result);
  validateStudyAnalysisInputMetadata(result);
  const after = await readBoundedStudyFile(prepared, "run.json", limits.sourceBytes);
  if (!after || !after.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  return result;
}

/** Validate exact source membership before any stored path may be read. */
export async function validateStudyAnalysisEvidence(
  prepared: PreparedRunArtifactPaths,
  artifact: StudyAnalysisArtifact,
  bundleBytes: Buffer
): Promise<void> {
  if (artifact.captureVersion !== undefined && artifact.captureVersion !== 2) throw new Error("ANALYSIS_CAPTURE_VERSION_INVALID");
  const bundle = parseSource(prepared, bundleBytes);
  if (artifact.runId !== bundle.runId || artifact.sourceRunSha256 !== sha256(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");
  const included = new Set(artifact.coverage.includedStreamIds);
  const omitted = new Set(artifact.coverage.omittedStreamIds);
  if (bundle.streams.some((stream) => !included.has(stream.id) && !omitted.has(stream.id))
    || included.size + omitted.size !== bundle.streams.length) throw new Error("ANALYSIS_SOURCE_COVERAGE_INVALID");
  const sourceByStream = new Map(bundle.streams.map((stream) => [stream.id, sourceEntries(bundle, stream, artifact.captureVersion)]));
  const context = new Map(artifact.participants.map((participant) => [participant.streamId, participant]));
  if (context.size !== included.size || artifact.participants.length !== included.size) throw new Error("ANALYSIS_PARTICIPANT_INPUT_INVALID");
  for (const stream of bundle.streams.filter((candidate) => included.has(candidate.id))) {
    const participant = context.get(stream.id);
    if (!participant || hashStudyAnalysisValue(participant) !== hashStudyAnalysisValue(participantSource(stream, artifact.captureVersion))) {
      throw new Error("ANALYSIS_PARTICIPANT_INPUT_INVALID");
    }
    if (artifact.captureVersion === 2 && artifact.coverage.complete && !participant.assignment?.trim()) throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
    if (artifact.captureVersion === 2 && artifact.coverage.complete && hasUnmappedCaptures(stream)) throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
  }
  const sourceKeys = new Set<string>();
  const checkedCaptures = new Map<string, string>();
  let checkedImageBytes = 0;
  for (const entry of artifact.evidence) {
    const matches = sourceByStream.get(entry.streamId)?.filter((source) => source.eventId === entry.eventId && source.kind === entry.kind) ?? [];
    const source = matches[0];
    const sourceKey = JSON.stringify([entry.streamId, entry.kind, entry.eventId]);
    if (sourceKeys.has(sourceKey)) throw new Error("ANALYSIS_SOURCE_REFERENCE_DUPLICATE");
    sourceKeys.add(sourceKey);
    if (matches.length !== 1 || source === undefined || !source.text.startsWith(entry.text)
      || entry.quoteEligible !== source.quoteEligible || entry.at !== source.at || entry.elapsedMs !== source.elapsedMs
      || entry.frame !== source.frame) throw new Error("ANALYSIS_SOURCE_REFERENCE_INVALID");
    if (artifact.coverage.complete && (entry.text !== source.text || ((source.capturePath !== null
      || (artifact.captureVersion === 2 && source.captureDeclared)) && entry.capture === null))) {
      throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
    }
    if (entry.capture !== null) {
      if (source.capturePath === null || entry.capture.path !== source.capturePath
        || entry.capture.eventId !== source.eventId || entry.capture.mimeType !== "image/png") throw new Error("ANALYSIS_CAPTURE_REFERENCE_INVALID");
      let hash = checkedCaptures.get(source.capturePath);
      if (hash === undefined) {
        const bytes = await readBoundedStudyFile(prepared, source.capturePath, STUDY_EVIDENCE_LIMITS.imageBytes);
        if (!bytes || screenshotEvidenceError(source.capturePath, bytes) !== null) throw new Error("ANALYSIS_CAPTURE_UNAVAILABLE");
        checkedImageBytes += bytes.length;
        if (checkedImageBytes > STUDY_EVIDENCE_LIMITS.totalImageBytes) throw new Error("ANALYSIS_IMAGE_LIMIT_EXCEEDED");
        hash = sha256(bytes);
        checkedCaptures.set(source.capturePath, hash);
      }
      if (hash !== entry.capture.sha256) throw new Error("ANALYSIS_CAPTURE_CHANGED");
    }
  }
  if (artifact.coverage.complete && [...sourceByStream.values()].reduce((total, entries) => total + entries.length, 0) !== artifact.evidence.length) {
    throw new Error("ANALYSIS_COVERAGE_INCOMPLETE");
  }

  const current = await readBoundedStudyFile(prepared, "run.json", STUDY_EVIDENCE_LIMITS.sourceBytes);
  if (!current?.equals(bundleBytes)) throw new Error("ANALYSIS_SOURCE_CHANGED");

}
