// A reviewer note as the server keeps it and the Observer shows it: its fields, their limits, and
// where an Observer page sends a new one. The Observer bundles this module, so it has no runtime imports
// (observer/tests/contract-lock.test.ts checks that); the server validates notes against these
// limits with zod in note-files.ts and notes-route.ts.

/** The characters a note's text may hold. */
export const MAX_NOTE_TEXT = 2000;
/** The notes one run keeps. A reader reads this many and names the rest. */
export const MAX_RUN_NOTES = 500;
/** The characters of a participant id, a trace item id or a timestamp a note records. */
export const NOTE_FIELD_LIMITS = { participant: 256, itemId: 256, author: 80, timestamp: 64 };
/** A note id: `note-<creation time>-<48 random bits in hex>`. */
export const NOTE_ID = /^note-\d{8}t\d{9}z-[0-9a-f]{12}$/;

/** Where an Observer page sends a note to the loopback server that rendered it. */
export const NOTES_PATH = "/api/notes";
/** The request header that carries the server's note token. */
export const NOTES_TOKEN_HEADER = "x-humanish-notes-token";

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

/** Notes in run clock order, the earliest added first at the same moment. */
export function byRunTime(notes: readonly RunNote[]): RunNote[] {
  return [...notes].sort(
    (left, right) => left.atMs - right.atMs || left.createdAt.localeCompare(right.createdAt),
  );
}
