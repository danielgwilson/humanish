import { receivingAnalysisContext } from "../comms/receiving-evidence.js";
import { streamParticipantIdOf } from "../run/participant-records.js";
import { cuaEndpointSource } from "../actors/goal-source.js";
import type { ActorTraceItem } from "../actors/contract.js";
import type { StoredRunBundle } from "../run/bundle.js";
import type { RunStream, StoredRunStream } from "../run/streams.js";
import { isRecord } from "../run/type-guards.js";
import {
  ACTION_CAPTURE_VERSION,
  type AnalysisParticipantInput,
  type CaptureVersion,
} from "./types.js";
import { decodesToPlainRelativePath, isEvidencePath } from "../run/evidence-files.js";
import { isRunEventOf } from "./source.js";

// How a run bundle becomes analysis sources: each participant's recorded provenance and assignment,
// the evidence entries its trace offers, and the order in which entries are admitted under the
// count and byte budgets. captureEvidence selects from these, taking each participant's while its
// trace is loaded (participantSources), and validateAnalysisEvidence re-derives them to check a
// stored analysis against its run.

const stamp = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
// A pointer read's entry carries the position it returned, which its title does not.
const itemText = (item: ActorTraceItem): string =>
  ["message", "reasoning"].includes(item.kind) && item.text !== undefined
    ? item.text
    : [
        item.title,
        item.text,
        item.pointer === undefined
          ? undefined
          : `pointer at (${item.pointer.x}, ${item.pointer.y})`,
      ]
        .filter((entry) => entry !== undefined && entry !== "")
        .join("\n");
const itemsFor = (stream: RunStream): ActorTraceItem[] => stream.actor?.items ?? [];
const isCaptureItem = (item: ActorTraceItem, captureVersion?: CaptureVersion): boolean =>
  item.kind === "screenshot" ||
  (captureVersion === ACTION_CAPTURE_VERSION && item.kind === "ui_action");

export function hasUnmappedCaptures(stream: RunStream): boolean {
  const items = itemsFor(stream);
  const paths = new Set(
    items.flatMap((item) =>
      isCaptureItem(item, 2) && typeof item.screenshotRef?.path === "string"
        ? [item.screenshotRef.path]
        : [],
    ),
  );
  // Presentation URLs use Observer-relative paths. They cannot manufacture an
  // event/frame, but a declared capture outside the trace must limit coverage.
  const previews = [
    stream.ui?.screenshotUrl,
    stream.embed?.kind === "screenshot" ? stream.embed.url : undefined,
  ];
  return (
    (Array.isArray(stream.artifacts) &&
      stream.artifacts.some(
        (artifact) => artifact?.kind === "screenshot" && !paths.has(artifact.path),
      )) ||
    previews.some(
      (ref) => typeof ref === "string" && !paths.has(ref) && !paths.has(ref.replace(/^\.\.\//, "")),
    ) ||
    items.some(
      (item) => typeof item.screenshotRef?.path === "string" && !paths.has(item.screenshotRef.path),
    )
  );
}

export function boundedText(value: string, maxBytes: number): string {
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
  return decodesToPlainRelativePath(
    value,
    8192,
    /^[\\/]|[\\\u0000-\u001f\u007f]|^[a-z][a-z\d+.-]*:/i,
  );
}

export function participantAssignment(
  stream: StoredRunStream,
  captureVersion?: CaptureVersion,
): string | null {
  if (stream.assignment === undefined)
    return captureVersion === ACTION_CAPTURE_VERSION &&
      stream.actor?.lane === "scripted-browser" &&
      typeof stream.ui?.intent === "string" &&
      stream.ui.intent.trim()
      ? stream.ui.intent
      : null;
  return [
    stream.assignment.mission,
    stream.assignment.focus,
    ...(stream.assignment.tasks ?? []).map(
      (task) => `Task ${JSON.stringify(task.id)}: ${task.goal}`,
    ),
  ]
    .filter((entry) => typeof entry === "string")
    .join("\n");
}

export function participantSource(
  stream: RunStream,
  captureVersion?: CaptureVersion,
): AnalysisParticipantInput {
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
      goalSource: cuaEndpointSource(actor, stream.status) ?? null,
      declaredOutcome: actor?.declaredOutcome ?? null,
      taskOutcomes:
        actor?.taskFunnel === undefined
          ? null
          : actor.taskFunnel.tasks.map((task) => ({
              taskId: task.id,
              completed: task.completed,
              observable: task.observable,
              inputsObserved: task.inputsObserved ?? null,
              turn: task.turn ?? null,
            })),
    },
  };
}

const runEventsOf = (bundle: StoredRunBundle, stream: StoredRunStream): StoredRunBundle["events"] =>
  bundle.events.filter((event) => isRunEventOf(stream, event));

/**
 * How many entries sourceEntries gives of run.json's `stream` once its trace is loaded, counted
 * before the trace is read: the trace loader refuses a trace that does not hold the item count its
 * index records.
 */
export function sourceEntryCount(
  bundle: StoredRunBundle,
  stream: StoredRunStream,
  captureVersion: CaptureVersion,
): number {
  const comms = captureVersion === ACTION_CAPTURE_VERSION && bundle.commsReceiving ? 1 : 0;
  const items = stream.trace?.items ?? stream.actor?.items?.length ?? 0;
  return comms + items + runEventsOf(bundle, stream).length;
}

export interface SourceEntry {
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
export function sourceEntries(
  bundle: StoredRunBundle,
  stream: RunStream,
  captureVersion?: CaptureVersion,
): SourceEntry[] {
  const items = itemsFor(stream);
  // Absent version retains the exact legacy mapping used by saved 0.89.1 analyses.
  // V2 follows the actor contract: a scripted action can carry its own capture.
  const captures = items.filter(
    (item) =>
      isCaptureItem(item, captureVersion) &&
      isRecord(item.screenshotRef) &&
      typeof item.screenshotRef.path === "string" &&
      isObserverCapturePath(item.screenshotRef.path),
  );
  const frameIds = new Set(captures.map((item) => item.id));
  const firstAt = stamp(captures[0]?.at);
  let frame = -1;
  const entries: SourceEntry[] = [];
  if (captureVersion === ACTION_CAPTURE_VERSION && bundle.commsReceiving) {
    entries.push({
      eventId: `comms-receiving-${stream.id}`,
      kind: "harness:email_receiving",
      text: receivingAnalysisContext(bundle.commsReceiving, streamParticipantIdOf(stream)),
      quoteEligible: false,
      at: null,
      elapsedMs: null,
      frame: null,
      capturePath: null,
      captureDeclared: false,
      failed:
        bundle.commsReceiving.limitations.length > 0 ||
        bundle.commsReceiving.participants.some((p) => p.limitations.length > 0),
    });
  }
  for (const item of items) {
    const capturePath =
      isCaptureItem(item, captureVersion) &&
      isRecord(item.screenshotRef) &&
      typeof item.screenshotRef.path === "string" &&
      isEvidencePath(item.screenshotRef.path)
        ? item.screenshotRef.path
        : null;
    if (frameIds.has(item.id)) frame++;
    const at = stamp(item.at);
    const delta = at !== null && firstAt !== null ? Date.parse(at) - Date.parse(firstAt) : null;
    entries.push({
      eventId: item.id,
      kind: item.kind,
      text: itemText(item),
      quoteEligible: ["message", "reasoning"].includes(item.kind) && typeof item.text === "string",
      at,
      elapsedMs: delta !== null && delta >= 0 ? delta : null,
      frame: captures.length > 0 ? Math.max(0, frame) : null,
      capturePath,
      captureDeclared:
        item.kind === "screenshot" ||
        (captureVersion === ACTION_CAPTURE_VERSION &&
          item.kind === "ui_action" &&
          item.screenshotRef !== undefined),
      failed: ["failed", "blocked", "timed_out"].includes(item.status ?? ""),
    });
  }
  // parseAnalysisSource refuses a run.json in which two of a participant's run events share an id.
  for (const event of runEventsOf(bundle, stream)) {
    entries.push({
      eventId: event.id,
      kind: `run_event:${event.type}`,
      text: event.message,
      quoteEligible: false,
      at: stamp(event.at),
      elapsedMs: null,
      frame: null,
      capturePath: null,
      captureDeclared: false,
      failed: event.level === "error",
    });
  }
  return entries;
}

/** Max-min allocation; stable ID order breaks a remainder tie by at most one slot. */
export function fairShares(budget: number, capacities: number[]): number[] {
  const shares = capacities.map(() => 0);
  let active = capacities
    .map((capacity, index) => ({ capacity, index }))
    .filter(({ capacity }) => capacity > 0);
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

/** The trace messages that carry a participant's closing impressions. */
function impressionEventIds(stream: RunStream): ReadonlySet<string> {
  const impressions = stream.actor?.impressions;
  return new Set(
    impressions?.status === "collected" ? impressions.items.map((item) => item.messageId) : [],
  );
}

function sourceOrder(
  entries: SourceEntry[],
  capturesOnly: boolean,
  impressions: ReadonlySet<string> = new Set(),
): SourceEntry[] {
  const candidates = capturesOnly ? entries.filter((entry) => entry.capturePath !== null) : entries;
  const ordered = new Set<SourceEntry>();
  const admit = (entry: SourceEntry | undefined): void => {
    if (entry && (!capturesOnly || entry.capturePath !== null)) ordered.add(entry);
  };
  // Actor endings precede appended run bookkeeping when text slots are scarce.
  if (!capturesOnly) admit(entries.findLast((entry) => !entry.kind.startsWith("run_event:")));
  // The participant's closing impressions are its only opinions of the product; keep them all.
  for (const entry of entries) if (impressions.has(entry.eventId)) admit(entry);
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
  // A final scroll or navigation can move the result out of view. Keep its
  // preceding capture as ending context, regardless of the reported outcome.
  if (capturesOnly) admit(candidates.at(-2));
  for (const entry of spreadOrder(candidates)) admit(entry);
  return [...ordered];
}

/**
 * What selection reads of one participant, taken while its trace is loaded so the trace can be
 * dropped: the counts of its source entries and captures, and only the entries selection can
 * reach. Selection admits at most `evidenceShare` entries, in `textOrder`, and reads captures in
 * `captureOrder`.
 */
export interface ParticipantSources {
  /** run.json's stream, which holds no trace items from run bundle v2. */
  readonly stream: StoredRunStream;
  readonly participant: AnalysisParticipantInput;
  /** hasUnmappedCaptures of the loaded stream. */
  readonly unmappedCaptures: boolean;
  /** Whether an entry declares a capture that has no local path. */
  readonly unresolvedCaptures: boolean;
  readonly entryCount: number;
  /** The entries with a local capture path. */
  readonly captureCount: number;
  /** The participant's part of its cohort's evidence limit. */
  readonly evidenceShare: number;
  /** The first evidenceShare entries in admission order, the participant's impressions first. */
  readonly textOrder: readonly SourceEntry[];
  /** The first captures in the order selection reads them. */
  readonly captureOrder: readonly SourceEntry[];
  /** The entries of textOrder and captureOrder, in source order. */
  readonly entries: readonly SourceEntry[];
}

/**
 * ParticipantSources of `loaded`, the stream `stored` with its trace loaded, keeping the first
 * `reach.evidenceShare` entries in admission order and the first `reach.captures` captures.
 */
export function participantSources(
  bundle: StoredRunBundle,
  stored: StoredRunStream,
  loaded: RunStream,
  captureVersion: CaptureVersion,
  reach: { readonly evidenceShare: number; readonly captures: number },
): ParticipantSources {
  const all = sourceEntries(bundle, loaded, captureVersion);
  const textOrder = sourceOrder(all, false, impressionEventIds(loaded)).slice(
    0,
    reach.evidenceShare,
  );
  const captureOrder = sourceOrder(all, true).slice(0, reach.captures);
  const reachable = new Set([...textOrder, ...captureOrder]);
  return {
    stream: stored,
    participant: participantSource(loaded, captureVersion),
    unmappedCaptures: hasUnmappedCaptures(loaded),
    unresolvedCaptures: all.some((entry) => entry.captureDeclared && entry.capturePath === null),
    entryCount: all.length,
    captureCount: all.filter((entry) => entry.capturePath !== null).length,
    evidenceShare: reach.evidenceShare,
    textOrder,
    captureOrder,
    entries: all.filter((entry) => reachable.has(entry)),
  };
}
