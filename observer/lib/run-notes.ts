// The note shape, its limits and the request path come from note-shape.ts, which has no runtime
// imports, so no CLI code reaches the artifact (observer/tests/contract-lock.test.ts).
import {
  MAX_NOTE_TEXT,
  MAX_RUN_NOTES,
  NOTE_FIELD_LIMITS,
  NOTE_ID,
  NOTES_PATH,
  NOTES_TOKEN_HEADER,
  type RunNote,
} from "../../src/run/note-shape.js";

export type { RunNote } from "../../src/run/note-shape.js";

// Assembled at runtime so the literal appears once in the built artifact, in the index.html slot.
export const RUN_NOTES_PLACEHOLDER = ["__HUMANISH", "RUN_NOTES__"].join("_");

/** The run's reviewer notes, and the token for adding one when a loopback server rendered the page. */
export interface RunNotesState {
  notes: RunNote[];
  token: string | null;
  /** The page carried notes that could not be read, or the server skipped note files. */
  unreadable: boolean;
}

export const NO_RUN_NOTES: RunNotesState = { notes: [], token: null, unreadable: false };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const timestamp = (value: unknown): value is string =>
  text(value, NOTE_FIELD_LIMITS.timestamp) && Number.isFinite(Date.parse(value));

/** The server's note file schema (src/run/note-files.ts), without zod, which the Observer leaves out. */
function isRunNote(value: unknown): value is RunNote {
  return (
    object(value) &&
    typeof value.id === "string" &&
    NOTE_ID.test(value.id) &&
    typeof value.atMs === "number" &&
    Number.isSafeInteger(value.atMs) &&
    value.atMs >= 0 &&
    (value.participant === null || text(value.participant, NOTE_FIELD_LIMITS.participant)) &&
    (value.nearest === null ||
      (object(value.nearest) &&
        text(value.nearest.participant, NOTE_FIELD_LIMITS.participant) &&
        text(value.nearest.itemId, NOTE_FIELD_LIMITS.itemId))) &&
    text(value.text, MAX_NOTE_TEXT) &&
    text(value.author, NOTE_FIELD_LIMITS.author) &&
    timestamp(value.createdAt) &&
    (value.editedAt === null || timestamp(value.editedAt))
  );
}

/**
 * The notes of `runId` the slot carries and how many note files the server skipped, or null when
 * the value is not that.
 */
function parseNotes(value: unknown, runId: string): { notes: RunNote[]; skipped: number } | null {
  if (
    !object(value) ||
    !Array.isArray(value.notes) ||
    value.notes.length > MAX_RUN_NOTES ||
    !value.notes.every(isRunNote) ||
    typeof value.skipped !== "number" ||
    !Number.isSafeInteger(value.skipped) ||
    value.skipped < 0
  )
    return null;
  return value.runId === runId
    ? { notes: value.notes, skipped: value.skipped }
    : { notes: [], skipped: 0 };
}

/** The run-notes slot the CLI fills, for the run the page shows. */
export function readInlineRunNotes(doc: Document, runId: string): RunNotesState {
  const raw = doc.getElementById("run-notes")?.textContent?.trim() ?? "";
  if (!raw || raw === RUN_NOTES_PLACEHOLDER) return NO_RUN_NOTES;
  let slot: unknown;
  try {
    slot = JSON.parse(raw);
  } catch {
    return { ...NO_RUN_NOTES, unreadable: true };
  }
  if (!object(slot)) return { ...NO_RUN_NOTES, unreadable: true };
  const notes = slot.notes === null ? { notes: [], skipped: 0 } : parseNotes(slot.notes, runId);
  const token =
    object(slot.write) &&
    typeof slot.write.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(slot.write.token)
      ? slot.write.token
      : null;
  return notes === null
    ? { ...NO_RUN_NOTES, unreadable: true }
    : { notes: notes.notes, token, unreadable: notes.skipped > 0 };
}

export type SaveRunNoteResult =
  | { ok: true; note: RunNote; scrubbed: boolean }
  | { ok: false; message: string };

/** Sends a note to the server that rendered this page; it answers with the note it saved. */
export async function saveRunNote(
  fetchImpl: typeof fetch,
  token: string,
  note: { runId: string; atMs: number; participant: string | null; text: string },
): Promise<SaveRunNoteResult> {
  let response: Response;
  try {
    response = await fetchImpl(NOTES_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", [NOTES_TOKEN_HEADER]: token },
      body: JSON.stringify(note),
    });
  } catch {
    return {
      ok: false,
      message:
        "The note was not saved: the Observer could not reach the humanish process serving it. Check that it is still running, then save again.",
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (response.ok && object(body) && isRunNote(body.note))
    return { ok: true, note: body.note, scrubbed: body.scrubbed === true };
  const message =
    object(body) && object(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : `The note was not saved: the server answered ${response.status}.`;
  return { ok: false, message };
}
