import type { RunNote } from "../../src/run/notes";

export type { RunNote } from "../../src/run/notes";

// Kept as a literal (not imported as a value) so the artifact never bundles CLI code.
// tests/contract-lock.test.ts asserts it equals src/run/notes.ts's exported const.
export const RUN_NOTES_SCHEMA = "humanish.run-notes.v1";
// Assembled at runtime so the literal appears once in the built artifact, in the index.html slot.
export const RUN_NOTES_PLACEHOLDER = ["__HUMANISH", "RUN_NOTES__"].join("_");

/** The run's reviewer notes, and the token for adding one when a loopback server rendered the page. */
export interface RunNotesState {
  notes: RunNote[];
  token: string | null;
  /** The page carried notes that could not be read. */
  unreadable: boolean;
}

export const NO_RUN_NOTES: RunNotesState = { notes: [], token: null, unreadable: false };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

function isRunNote(value: unknown): value is RunNote {
  return (
    object(value) &&
    text(value.id, 128) &&
    typeof value.atMs === "number" &&
    Number.isSafeInteger(value.atMs) &&
    value.atMs >= 0 &&
    (value.participant === null || text(value.participant, 256)) &&
    (value.nearest === null ||
      (object(value.nearest) &&
        text(value.nearest.participant, 256) &&
        text(value.nearest.itemId, 256))) &&
    text(value.text, 2000) &&
    text(value.author, 80) &&
    text(value.createdAt, 64) &&
    (value.editedAt === null || text(value.editedAt, 64))
  );
}

/** The notes of `runId` in a notes file, or null when the value is not one. */
function parseNotes(value: unknown, runId: string): RunNote[] | null {
  if (
    !object(value) ||
    value.schema !== RUN_NOTES_SCHEMA ||
    !Array.isArray(value.notes) ||
    value.notes.length > 500 ||
    !value.notes.every(isRunNote)
  )
    return null;
  return value.runId === runId ? value.notes : [];
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
  const notes = slot.notes === null ? [] : parseNotes(slot.notes, runId);
  const token =
    object(slot.write) &&
    typeof slot.write.token === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(slot.write.token)
      ? slot.write.token
      : null;
  return notes === null
    ? { ...NO_RUN_NOTES, unreadable: true }
    : { notes, token, unreadable: false };
}

/** Notes in run clock order, the earliest added first at the same moment. */
export function byRunTime(notes: readonly RunNote[]): RunNote[] {
  return [...notes].sort(
    (left, right) => left.atMs - right.atMs || left.createdAt.localeCompare(right.createdAt),
  );
}

export type SaveRunNoteResult =
  | { ok: true; notes: RunNote[]; scrubbed: boolean }
  | { ok: false; message: string };

/** Sends a note to the server that rendered this page; it answers with all of the run's notes. */
export async function saveRunNote(
  fetchImpl: typeof fetch,
  token: string,
  note: { runId: string; atMs: number; participant: string | null; text: string },
): Promise<SaveRunNoteResult> {
  let response: Response;
  try {
    response = await fetchImpl("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json", "x-humanish-notes-token": token },
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
  if (response.ok && object(body) && object(body.notes)) {
    const notes = parseNotes(body.notes, note.runId);
    if (notes !== null) return { ok: true, notes, scrubbed: body.scrubbed === true };
  }
  const message =
    object(body) && object(body.error) && typeof body.error.message === "string"
      ? body.error.message
      : `The note was not saved: the server answered ${response.status}.`;
  return { ok: false, message };
}
