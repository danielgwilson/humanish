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
import { z } from "zod";

import { scanEncodedTextCached } from "../evidence/encoded-text.js";
import { readBoundedFileResult } from "./evidence-files.js";
import {
  MAX_NOTE_TEXT,
  MAX_RUN_NOTES,
  NOTE_FIELD_LIMITS,
  NOTE_ID,
  type RunNote,
} from "./note-shape.js";
import {
  runIdOf,
  validatePreparedRunRootIdentity,
  type PreparedRunArtifactPaths,
} from "./paths.js";
import { isNodeError } from "./type-guards.js";

const RUN_NOTE_SCHEMA = "humanish.run-note.v1";
export const RUN_NOTES_DIR = "notes";
/** The bytes one note file may hold: 2000 characters of text with JSON escapes, and its fields. */
export const MAX_NOTE_FILE_BYTES = 16 * 1024;
/** The entries a reader lists in notes/ before it stops. */
const MAX_LISTED_ENTRIES = 2 * MAX_RUN_NOTES;
/** A temporary file of a write in progress, or of one a stopped writer left. Never a note. */
const WRITE_IN_PROGRESS = /^\.humanish-write-/;

const text = (max: number) => z.string().min(1).max(max);
const timestamp = text(NOTE_FIELD_LIMITS.timestamp).refine((value) =>
  Number.isFinite(Date.parse(value)),
);

/** A note file. Fields a later release adds are dropped on reading, so they never hide a note. */
const runNoteFileSchema = z.object({
  schema: z.literal(RUN_NOTE_SCHEMA),
  runId: z.string(),
  id: z.string().regex(NOTE_ID),
  atMs: z.int().min(0),
  participant: text(NOTE_FIELD_LIMITS.participant).nullable(),
  nearest: z
    .object({
      participant: text(NOTE_FIELD_LIMITS.participant),
      itemId: text(NOTE_FIELD_LIMITS.itemId),
    })
    .nullable(),
  text: text(MAX_NOTE_TEXT),
  author: text(NOTE_FIELD_LIMITS.author),
  createdAt: timestamp,
  editedAt: timestamp.nullable(),
}) satisfies z.ZodType<RunNote>;

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

/** The note in a note file's bytes, when it is a note of `runId` stored under its own `id`. */
function decodeRunNote(bytes: Buffer, runId: string, id: string): RunNote | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = runNoteFileSchema.safeParse(value);
  if (!parsed.success || parsed.data.runId !== runId || parsed.data.id !== id) return null;
  const { schema: _schema, runId: _runId, ...note } = parsed.data;
  return note;
}

/**
 * Up to MAX_LISTED_ENTRIES names in the notes directory at `dir`, or null when there is none.
 * Throws when `dir` is there and is not a plain directory.
 */
async function listNoteEntries(
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
function noteListing(listing: { names: readonly string[]; truncated: boolean }): {
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
 * Where a run's notes are read from: the run's id, its directory, and a reader of the files under
 * it that refuses a link or a special file and stops at `maxBytes`.
 */
export interface RunNoteFiles {
  readonly runId: string;
  /** The run directory's physical path, once it is checked to be the directory bound. Throws otherwise. */
  directory(): Promise<string>;
  /** A file under the run directory: its bytes, "limit" when it holds more than `maxBytes`, or null. */
  read(relativePath: string, maxBytes: number): Promise<Buffer | "limit" | null>;
}

/** The run's note files through the bounded reader, which rechecks the run directory on each read. */
function boundedNoteFiles(prepared: PreparedRunArtifactPaths): RunNoteFiles {
  return {
    runId: runIdOf(prepared),
    async directory() {
      await validatePreparedRunRootIdentity(prepared);
      return prepared.physicalRunRoot;
    },
    async read(relativePath, maxBytes) {
      const read = await readBoundedFileResult(prepared, relativePath, maxBytes);
      return read.state === "read" ? read.bytes : read.state === "limit" ? "limit" : null;
    },
  };
}

/**
 * The run's notes, read from its prepared paths through the bounded reader or through `from`, the
 * files of a run the caller already holds (the served Observer passes its pinned root's). Each file
 * is read within MAX_NOTE_FILE_BYTES; a file the reader refuses, or that is not a note of this run,
 * is skipped and named in `skipped`.
 */
export async function readRunNotes(
  from: PreparedRunArtifactPaths | RunNoteFiles,
): Promise<RunNotes> {
  const files = "physicalRunRoot" in from ? boundedNoteFiles(from) : from;
  const { runId } = files;
  let listing;
  try {
    listing = await listNoteEntries(path.join(await files.directory(), RUN_NOTES_DIR));
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
    const read = await files.read(runNoteFile(id), MAX_NOTE_FILE_BYTES);
    const note = Buffer.isBuffer(read) ? decodeRunNote(read, runId, id) : null;
    if (note !== null) notes.push(note);
    else
      skipped.push(
        read === "limit"
          ? `${runNoteFile(id)} is over ${MAX_NOTE_FILE_BYTES / 1024} KiB, so it was skipped.`
          : `${runNoteFile(id)} is not a readable note of run ${runId}, so it was skipped.`,
      );
  }
  return { runId, notes, skipped };
}

/** What verify's text scan finds in notes about to be shared, and the share safety that gives them. */
export interface NotesSharingProblem {
  status: "local_only" | "blocked";
  reason: { code: "PUBLIC_SAFETY_FINDINGS" | "UNSCANNED_ARTIFACT"; message: string };
}

/**
 * The run's notes as a caller is about to share them, read once, with what verify's text scan
 * finds in that set as it would be shared. The caller shares this set only, so a note added or
 * changed after verify ran cannot go out unchecked.
 */
export async function readNotesForSharing(
  prepared: PreparedRunArtifactPaths,
): Promise<{ notes: RunNotes; problem: NotesSharingProblem | null }> {
  const notes = await readRunNotes(prepared);
  if (notes.notes.length === 0) return { notes, problem: null };
  const scan = scanEncodedTextCached(JSON.stringify(notes.notes));
  if (scan.sensitive)
    return {
      notes,
      problem: {
        status: "blocked",
        reason: {
          code: "PUBLIC_SAFETY_FINDINGS",
          message: "The reviewer notes being shared match secret, token or local-path patterns.",
        },
      },
    };
  if (scan.opaque)
    return {
      notes,
      problem: {
        status: "local_only",
        reason: {
          code: "UNSCANNED_ARTIFACT",
          message: "The reviewer notes being shared hold encoded text the scan cannot read.",
        },
      },
    };
  return { notes, problem: null };
}
