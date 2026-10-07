// Reviewer note files written the way the store writes them: notes/<id>.json in the run directory.
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** A note id for a creation time `seconds` after 2026-05-01T10:00:00Z, ending in `serial`. */
export function noteId(seconds: number, serial = 1): string {
  const created = new Date(Date.parse("2026-05-01T10:00:00.000Z") + seconds * 1000);
  const stamp = created.toISOString().replace(/[-:.]/g, "").toLowerCase();
  return `note-${stamp}-${String(serial).padStart(12, "0")}`;
}

export interface NoteFields {
  id?: string;
  atMs?: number;
  participant?: string | null;
  text: string;
}

/** The stored form of a note on run `runId`. */
export function noteFile(runId: string, fields: NoteFields): Record<string, unknown> {
  const id = fields.id ?? noteId(0);
  return {
    schema: "humanish.run-note.v1",
    runId,
    id,
    atMs: fields.atMs ?? 0,
    participant: fields.participant ?? null,
    nearest: null,
    text: fields.text,
    author: "you",
    createdAt: "2026-05-01T10:00:00.000Z",
    editedAt: null,
  };
}

/** Writes a note file into `runDir`/notes and returns its path. */
export async function writeNoteFile(
  runDir: string,
  runId: string,
  fields: NoteFields,
): Promise<string> {
  const stored = noteFile(runId, fields);
  await mkdir(path.join(runDir, "notes"), { recursive: true });
  const file = path.join(runDir, "notes", `${String(stored.id)}.json`);
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
  return file;
}

/** The entries of `runDir`/notes, or none when it does not exist. */
export async function noteEntries(runDir: string): Promise<string[]> {
  return (await readdir(path.join(runDir, "notes")).catch(() => [] as string[])).sort();
}
