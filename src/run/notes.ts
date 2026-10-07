// Reviewer notes: free text a person adds at a moment of a recorded run, kept in the run directory
// as notes.json (humanish.run-notes.v1). A note's time counts from the run clock's start, the
// first timed capture or desktop video of any participant, which is the Observer's study clock.

import { randomUUID } from "node:crypto";
import { lstat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";

import type { ActorTraceItem } from "../actors/contract.js";
import { redactText } from "../evidence/redaction.js";
import type { RunBundle } from "./bundle.js";
import { containedPathAbsent, writeContainedOutputFile } from "./contained-output.js";
import { readBoundedFileResult } from "./evidence-files.js";
import { loadRunBundlePrepared } from "./locate.js";
import {
  physicalCwdOf,
  runIdOf,
  validatePreparedRunRootIdentity,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import type { RunStream } from "./streams.js";
import { transientCommsKnownValueScrub } from "./transient-comms-secrets.js";
import { isNodeError, isRecord } from "./type-guards.js";

export const RUN_NOTES_SCHEMA = "humanish.run-notes.v1";
export const RUN_NOTES_FILE = "notes.json";
const DEFAULT_AUTHOR = "you";
export const MAX_NOTE_TEXT = 2000;
const MAX_RUN_NOTES = 500;
const NOTES_LOCK = ".notes-lock";
// Saving a note takes milliseconds, so a lock this old was left by a process that stopped.
const STALE_LOCK_MS = 30_000;

export interface RunNote {
  id: string;
  /** Milliseconds from the run clock's start. */
  atMs: number;
  /** The participant's stream id, or null for a note on the whole run. */
  participant: string | null;
  /** The latest timed capture or event at or before the moment, with its participant. */
  nearest: { participant: string; itemId: string } | null;
  text: string;
  author: string;
  createdAt: string;
  editedAt: string | null;
}

export interface RunNotes {
  schema: typeof RUN_NOTES_SCHEMA;
  runId: string;
  notes: RunNote[];
}

export interface RunNoteInput {
  atMs: number;
  participant: string | null;
  text: string;
}

export type RunNoteErrorCode =
  | "HUMANISH_INVALID_RUN_BUNDLE"
  | "HUMANISH_NOTE_INVALID"
  | "HUMANISH_NOTE_NO_CLOCK"
  | "HUMANISH_NOTE_UNKNOWN_PARTICIPANT"
  | "HUMANISH_NOTE_OUTSIDE_RUN"
  | "HUMANISH_NOTES_UNREADABLE"
  | "HUMANISH_NOTES_FULL"
  | "HUMANISH_NOTES_BUSY";

export type AddRunNoteResult =
  /** `scrubbed`: redaction replaced part of the text before it was written. */
  | { ok: true; note: RunNote; notes: RunNotes; scrubbed: boolean }
  | { ok: false; error: { code: RunNoteErrorCode; message: string } };

const refuse = (code: RunNoteErrorCode, message: string): AddRunNoteResult => ({
  ok: false,
  error: { code, message },
});

/** A run clock time as the Observer shows it: whole minutes and seconds, `02:31`. */
export function formatRunTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The run clock: the first and last timed capture or desktop video moment, in epoch ms. */
export function runClock(bundle: RunBundle): { startMs: number; endMs: number } | null {
  const moments = bundle.streams.flatMap((stream) => [
    ...(captureTimes(stream) ?? []),
    ...recordingMoments(stream),
  ]);
  if (moments.length === 0) return null;
  // A loop, since spreading a long recording's capture times into Math.min can overflow the stack.
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const moment of moments) {
    startMs = Math.min(startMs, moment);
    endMs = Math.max(endMs, moment);
  }
  return { startMs, endMs };
}

function traceItems(stream: RunStream): ActorTraceItem[] {
  return stream.actor?.items ?? stream.liveActor?.items ?? [];
}

const stamp = (item: ActorTraceItem): number =>
  item.at === undefined ? Number.NaN : Date.parse(item.at);

/**
 * A participant's capture times, as the Observer's study clock reads them: only when every capture
 * is stamped and the stamps never go back. Otherwise the participant adds nothing to the clock.
 */
function captureTimes(stream: RunStream): number[] | null {
  const times = traceItems(stream)
    .filter(
      (item) => (item.kind === "screenshot" || item.kind === "ui_action") && item.screenshotRef,
    )
    .map(stamp);
  const ordered = times.every(
    (time, index) => Number.isFinite(time) && (index === 0 || time >= times[index - 1]!),
  );
  return ordered ? times : null;
}

function recordingMoments(stream: RunStream): number[] {
  const recording = stream.recording;
  if (!recording) return [];
  const startMs = Date.parse(recording.startedAt);
  const endMs = startMs + recording.durationMs;
  return Number.isFinite(startMs) && Number.isFinite(endMs) && recording.durationMs > 0
    ? [startMs, endMs]
    : [];
}

/** The latest stamped trace item at or before `moment`, among the given participants. */
function nearestItem(streams: readonly RunStream[], moment: number): RunNote["nearest"] {
  let best: { participant: string; itemId: string; time: number } | null = null;
  for (const stream of streams)
    for (const item of traceItems(stream)) {
      const time = stamp(item);
      if (Number.isFinite(time) && time <= moment && (best === null || time >= best.time))
        best = { participant: stream.id, itemId: item.id, time };
    }
  return best === null ? null : { participant: best.participant, itemId: best.itemId };
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value: unknown): value is string =>
  text(value, 64) && Number.isFinite(Date.parse(value));

function isRunNote(value: unknown): value is RunNote {
  return (
    isRecord(value) &&
    text(value.id, 128) &&
    typeof value.atMs === "number" &&
    Number.isSafeInteger(value.atMs) &&
    value.atMs >= 0 &&
    (value.participant === null || text(value.participant, 256)) &&
    (value.nearest === null ||
      (isRecord(value.nearest) &&
        text(value.nearest.participant, 256) &&
        text(value.nearest.itemId, 256))) &&
    text(value.text, MAX_NOTE_TEXT) &&
    text(value.author, 80) &&
    timestamp(value.createdAt) &&
    (value.editedAt === null || timestamp(value.editedAt))
  );
}

/** A notes file for `runId`, or null when the value is not one. Unknown fields are dropped. */
function parseRunNotes(value: unknown, runId: string): RunNotes | null {
  if (
    !isRecord(value) ||
    value.schema !== RUN_NOTES_SCHEMA ||
    value.runId !== runId ||
    !Array.isArray(value.notes) ||
    value.notes.length > MAX_RUN_NOTES ||
    !value.notes.every(isRunNote) ||
    new Set(value.notes.map((note) => note.id)).size !== value.notes.length
  )
    return null;
  return {
    schema: RUN_NOTES_SCHEMA,
    runId,
    notes: value.notes.map((note) => ({
      id: note.id,
      atMs: note.atMs,
      participant: note.participant,
      nearest: note.nearest && {
        participant: note.nearest.participant,
        itemId: note.nearest.itemId,
      },
      text: note.text,
      author: note.author,
      createdAt: note.createdAt,
      editedAt: note.editedAt,
    })),
  };
}

/** The bytes a notes.json may hold: 500 notes at the longest text, with room for JSON escapes. */
export const MAX_NOTES_BYTES = 8 * 1024 * 1024;

/** The notes in bytes read from a run's notes.json, or null when they are not a notes file. */
export function decodeRunNotes(bytes: Buffer, runId: string): RunNotes | null {
  try {
    return parseRunNotes(JSON.parse(bytes.toString("utf8")), runId);
  } catch {
    return null;
  }
}

/**
 * The run's notes, or null when it has no notes.json. Throws HUMANISH_NOTES_UNREADABLE when a
 * notes.json is there but cannot be read safely, is over MAX_NOTES_BYTES or is not a notes file for
 * this run. The read stops at the limit, before anything is decoded.
 */
export async function readRunNotes(prepared: PreparedRunArtifactPaths): Promise<RunNotes | null> {
  if (await containedPathAbsent(prepared, RUN_NOTES_FILE)) return null;
  const read = await readBoundedFileResult(prepared, RUN_NOTES_FILE, MAX_NOTES_BYTES);
  const parsed = read.state === "read" ? decodeRunNotes(read.bytes, runIdOf(prepared)) : null;
  if (parsed === null) throw new Error("HUMANISH_NOTES_UNREADABLE");
  return parsed;
}

/** The run's notes for a page or a draft: null when it has none or they cannot be read. */
export function readableRunNotes(prepared: PreparedRunArtifactPaths): Promise<RunNotes | null> {
  return readRunNotes(prepared).catch(() => null);
}

/**
 * Runs `action` holding the run's notes lock, a directory only one writer can create, or returns
 * "busy" after about two seconds of waiting. The CLI and an Observer server can add notes to the
 * same run at once, and each rewrites the whole file.
 */
async function withNotesLock<T>(
  prepared: PreparedRunArtifactPaths,
  action: () => Promise<T>,
): Promise<T | "busy"> {
  await validatePreparedRunRootIdentity(prepared);
  const target = path.join(prepared.physicalRunRoot, NOTES_LOCK);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await mkdir(target, { mode: 0o700 });
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const held = await lstat(target).catch(() => null);
      if (held?.isDirectory() && Date.now() - held.mtimeMs > STALE_LOCK_MS) {
        await rmdir(target).catch(() => undefined);
        continue;
      }
      if (attempt >= 100) return "busy";
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const identity = await lstat(target, { bigint: true });
  try {
    return await action();
  } finally {
    // Remove only the empty directory this call created.
    const current = await lstat(target, { bigint: true }).catch(() => null);
    if (current?.isDirectory() && current.ino === identity.ino && current.dev === identity.dev)
      await rmdir(target).catch(() => undefined);
  }
}

const UNREADABLE_MESSAGE = (runId: string): string =>
  `The notes.json in run ${runId} is not a notes file humanish can read, so no note was added and the file was left as it is. Move it out of the run directory to start a new one.`;

/**
 * The text as it is written: line breaks as `\n`, the run's known values and every secret-shaped
 * value or local path replaced, as other run text is before it is written.
 */
function scrubNoteText(text: string): string {
  let known: string;
  try {
    known = transientCommsKnownValueScrub()(text);
  } catch {
    // A closed run scope refuses to scrub and has dropped its values. The note then gets the
    // pattern redaction that a separate `humanish notes` process gives it.
    known = text;
  }
  return redactText(known.replace(/\r\n?/g, "\n").trim());
}

/** Why the text cannot be a note, or null when it can. */
function noteTextProblem(text: string): string | null {
  if (text.length === 0) return "A note needs some text.";
  if (text.length > MAX_NOTE_TEXT)
    return `A note holds at most ${MAX_NOTE_TEXT} characters; this one has ${text.length}. Shorten it and add it again.`;
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text))
    return "A note holds plain text and line breaks; this one has a control character. Remove it and add the note again.";
  return null;
}

export async function addRunNote(
  prepared: PreparedRunArtifactPaths,
  input: RunNoteInput,
): Promise<AddRunNoteResult> {
  const text = scrubNoteText(input.text);
  const problem = noteTextProblem(text);
  if (problem) return refuse("HUMANISH_NOTE_INVALID", problem);
  // Containment checks throw on a link or special file anywhere in the run directory.
  const loaded = await loadRunBundlePrepared(physicalCwdOf(prepared), prepared).catch(() => null);
  if (!loaded)
    return refuse(
      "HUMANISH_INVALID_RUN_BUNDLE",
      `Run ${runIdOf(prepared)} has no run.json humanish can read safely, so no note was added. \`humanish verify --run ${runIdOf(prepared)}\` says what is wrong with it.`,
    );
  const { bundle } = loaded;
  const clock = runClock(bundle);
  if (!clock)
    return refuse(
      "HUMANISH_NOTE_NO_CLOCK",
      `Run ${bundle.runId} has no captures with recorded times, so a note cannot point at a moment of it.`,
    );
  if (
    input.participant !== null &&
    !bundle.streams.some((stream) => stream.id === input.participant)
  )
    return refuse(
      "HUMANISH_NOTE_UNKNOWN_PARTICIPANT",
      `Run ${bundle.runId} has no participant ${input.participant}. Its participants are ${bundle.streams.map((stream) => stream.id).join(", ")}; leave the participant out for a note on the whole run.`,
    );
  // The Observer shows whole seconds, so a moment in the second the clock ends is its end.
  const durationMs = clock.endMs - clock.startMs;
  if (
    !Number.isFinite(input.atMs) ||
    input.atMs < 0 ||
    Math.floor(input.atMs / 1000) > Math.floor(durationMs / 1000)
  )
    return refuse(
      "HUMANISH_NOTE_OUTSIDE_RUN",
      `A note on run ${bundle.runId} needs a moment from 00:00 to ${formatRunTime(durationMs)}, the time its captures cover.`,
    );
  const atMs = Math.min(Math.round(input.atMs), durationMs);
  const streams = bundle.streams.filter(
    (stream) => input.participant === null || stream.id === input.participant,
  );
  const note: RunNote = {
    id: `note-${randomUUID()}`,
    atMs,
    participant: input.participant,
    nearest: nearestItem(streams, clock.startMs + atMs),
    text,
    author: DEFAULT_AUTHOR,
    createdAt: new Date().toISOString(),
    editedAt: null,
  };
  const saved = await withNotesLock(prepared, async (): Promise<AddRunNoteResult> => {
    let existing: RunNotes | null;
    try {
      existing = await readRunNotes(prepared);
    } catch {
      return refuse("HUMANISH_NOTES_UNREADABLE", UNREADABLE_MESSAGE(bundle.runId));
    }
    if ((existing?.notes.length ?? 0) >= MAX_RUN_NOTES)
      return refuse(
        "HUMANISH_NOTES_FULL",
        `Run ${bundle.runId} already has ${MAX_RUN_NOTES} notes, the most one run keeps.`,
      );
    const notes: RunNotes = {
      schema: RUN_NOTES_SCHEMA,
      runId: bundle.runId,
      notes: [...(existing?.notes ?? []), note],
    };
    try {
      await writeContainedOutputFile(
        prepared,
        RUN_NOTES_FILE,
        `${JSON.stringify(notes, null, 2)}\n`,
      );
    } catch {
      return refuse("HUMANISH_NOTES_UNREADABLE", UNREADABLE_MESSAGE(bundle.runId));
    }
    return {
      ok: true,
      note,
      notes,
      scrubbed: text !== input.text.replace(/\r\n?/g, "\n").trim(),
    };
  });
  return saved === "busy"
    ? refuse(
        "HUMANISH_NOTES_BUSY",
        `Another note is being saved to run ${bundle.runId}. Add this one again in a moment.`,
      )
    : saved;
}
