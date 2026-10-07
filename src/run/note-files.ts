// Reviewer notes on disk: one file per note, notes/<id>.json (humanish.run-note.v1) in the run
// directory. A note is written once, to a temporary file that link(2) gives its name only when
// nothing holds that name, and is never rewritten, so a writer never reads or replaces another
// writer's note and no lock is needed. An id starts
// with its creation time, so the files sort in the order they were added, and ends in random
// bits. Readers list notes/ and read each file within MAX_NOTE_FILE_BYTES, skipping and naming
// anything that is not a readable note of the run.

import { randomBytes } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";

import { scanEncodedTextCached } from "../evidence/encoded-text.js";
import { readBoundedFileResult } from "./evidence-files.js";
import { runIdOf, type PreparedRunArtifactPaths } from "./paths.js";
import { isNodeError, isRecord } from "./type-guards.js";

const RUN_NOTE_SCHEMA = "humanish.run-note.v1";
export const RUN_NOTES_DIR = "notes";
/** The bytes one note file may hold: 2000 characters of text with JSON escapes, and its fields. */
export const MAX_NOTE_FILE_BYTES = 16 * 1024;
/** The notes one run keeps. A reader reads this many and names the rest. */
export const MAX_RUN_NOTES = 500;
export const MAX_NOTE_TEXT = 2000;
/** The entries a reader lists in notes/ before it stops. */
const MAX_LISTED_ENTRIES = 2 * MAX_RUN_NOTES;
const NOTE_ID = /^note-\d{8}t\d{9}z-[0-9a-f]{12}$/;
/** A temporary file of a write in progress, or of one a stopped writer left. Never a note. */
const WRITE_IN_PROGRESS = /^\.humanish-write-/;

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

/** A run's notes as read, in the order they were added, and why any file was skipped. */
export interface RunNotes {
  runId: string;
  notes: RunNote[];
  skipped: string[];
}

/** A new note id: `note-<creation time>-<48 random bits>`, such as `note-20261007t214500123z-…`. */
export function newRunNoteId(createdAt: Date): string {
  const stamp = createdAt.toISOString().replace(/[-:.]/g, "").toLowerCase();
  return `note-${stamp}-${randomBytes(6).toString("hex")}`;
}

/** The note's file, relative to the run directory. */
export function runNoteFile(id: string): string {
  return `${RUN_NOTES_DIR}/${id}.json`;
}

/** The note as its file holds it. */
export function encodeRunNote(note: RunNote, runId: string): string {
  return `${JSON.stringify({ schema: RUN_NOTE_SCHEMA, runId, ...note }, null, 2)}\n`;
}

const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value: unknown): value is string =>
  text(value, 64) && Number.isFinite(Date.parse(value));

/** The note in a note file's bytes, when it is a note of `runId` stored under its own `id`. */
export function decodeRunNote(bytes: Buffer, runId: string, id: string): RunNote | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(value) ||
    value.schema !== RUN_NOTE_SCHEMA ||
    value.runId !== runId ||
    value.id !== id ||
    typeof value.atMs !== "number" ||
    !Number.isSafeInteger(value.atMs) ||
    value.atMs < 0 ||
    !(value.participant === null || text(value.participant, 256)) ||
    !(
      value.nearest === null ||
      (isRecord(value.nearest) &&
        text(value.nearest.participant, 256) &&
        text(value.nearest.itemId, 256))
    ) ||
    !text(value.text, MAX_NOTE_TEXT) ||
    !text(value.author, 80) ||
    !timestamp(value.createdAt) ||
    !(value.editedAt === null || timestamp(value.editedAt))
  )
    return null;
  const nearest = isRecord(value.nearest) ? value.nearest : null;
  return {
    id,
    atMs: value.atMs,
    participant: value.participant,
    nearest:
      nearest === null
        ? null
        : { participant: String(nearest.participant), itemId: String(nearest.itemId) },
    text: value.text,
    author: value.author,
    createdAt: value.createdAt,
    editedAt: value.editedAt,
  };
}

/**
 * Up to MAX_LISTED_ENTRIES names in the notes directory at `dir`, or null when there is none.
 * Throws when `dir` is there and is not a plain directory.
 */
export async function listNoteEntries(
  dir: string,
): Promise<{ names: string[]; truncated: boolean } | null> {
  try {
    const stats = await lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink())
      throw new Error("The notes entry is not a directory.");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
  const names: string[] = [];
  const listing = await opendir(dir);
  try {
    for await (const entry of listing) {
      if (names.length === MAX_LISTED_ENTRIES) return { names, truncated: true };
      names.push(entry.name);
    }
  } finally {
    await listing.close().catch(() => undefined);
  }
  return { names, truncated: false };
}

/** The note ids to read from a listing of notes/, in creation order, and what was left out. */
export function noteListing(listing: { names: readonly string[]; truncated: boolean }): {
  ids: string[];
  skipped: string[];
} {
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const name of listing.names) {
    if (WRITE_IN_PROGRESS.test(name)) continue;
    const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (NOTE_ID.test(id)) ids.push(id);
    else skipped.push(`${RUN_NOTES_DIR}/${name} is not a note file, so it was skipped.`);
  }
  ids.sort();
  if (listing.truncated)
    skipped.push(
      `${RUN_NOTES_DIR}/ holds more than ${MAX_LISTED_ENTRIES} entries; only the first ${MAX_LISTED_ENTRIES} were listed.`,
    );
  if (ids.length > MAX_RUN_NOTES) {
    const left = ids.length - MAX_RUN_NOTES;
    skipped.push(
      `${left} note${left === 1 ? "" : "s"} after the first ${MAX_RUN_NOTES} ${left === 1 ? "was" : "were"} not read.`,
    );
    ids.length = MAX_RUN_NOTES;
  }
  return { ids, skipped };
}

/** How many note files notes/ lists, without reading any. Throws when notes/ is unusable. */
export async function countRunNotes(prepared: PreparedRunArtifactPaths): Promise<number> {
  const listing = await listNoteEntries(path.join(prepared.physicalRunRoot, RUN_NOTES_DIR));
  return listing === null ? 0 : noteListing(listing).ids.length + (listing.truncated ? 1 : 0);
}

/**
 * The run's notes. Each file is read through the bounded reader, which refuses a link, a special
 * file or anything over MAX_NOTE_FILE_BYTES before reading past the limit; a file it refuses, or
 * that is not a note of this run, is skipped and named in `skipped`.
 */
export async function readRunNotes(prepared: PreparedRunArtifactPaths): Promise<RunNotes> {
  const runId = runIdOf(prepared);
  let listing;
  try {
    listing = await listNoteEntries(path.join(prepared.physicalRunRoot, RUN_NOTES_DIR));
  } catch {
    return {
      runId,
      notes: [],
      skipped: [`${RUN_NOTES_DIR} in run ${runId} is not a plain folder, so no notes were read.`],
    };
  }
  if (listing === null) return { runId, notes: [], skipped: [] };
  const { ids, skipped } = noteListing(listing);
  const notes: RunNote[] = [];
  for (const id of ids) {
    const read = await readBoundedFileResult(prepared, runNoteFile(id), MAX_NOTE_FILE_BYTES);
    const note = read.state === "read" ? decodeRunNote(read.bytes, runId, id) : null;
    if (note !== null) notes.push(note);
    else
      skipped.push(
        read.state === "limit"
          ? `${runNoteFile(id)} is over ${MAX_NOTE_FILE_BYTES / 1024} KiB, so it was skipped.`
          : `${runNoteFile(id)} is not a readable note of run ${runId}, so it was skipped.`,
      );
  }
  return { runId, notes, skipped };
}

/** What verify's text scan finds in shared notes: a secret-shaped value, or text it cannot read. */
type NotesFinding = "sensitive" | "opaque";

/**
 * The run's notes as a caller is about to share them, read once, with what verify's text scan
 * finds in that set as it would be shared. The caller shares this set only, so a note added or
 * changed after verify ran cannot go out unchecked.
 */
export async function readNotesForSharing(
  prepared: PreparedRunArtifactPaths,
): Promise<{ notes: RunNotes; finding: NotesFinding | null }> {
  const notes = await readRunNotes(prepared);
  if (notes.notes.length === 0) return { notes, finding: null };
  const scan = scanEncodedTextCached(JSON.stringify(notes.notes));
  return { notes, finding: scan.sensitive ? "sensitive" : scan.opaque ? "opaque" : null };
}
