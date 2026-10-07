// notes.json as a file: reads stop at the size limit before anything is decoded.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { addRunNote, readRunNotes } from "../../src/run/notes.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { bytesReadDuring } from "../helpers/bytes-read.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

const RUN = "notes-files-run";
/** Larger than the 8 MiB a notes.json may hold. */
const OVERSIZED = 9 * 1024 * 1024;

async function oversizedNotes() {
  const cwd = await makeTestTempDir("humanish-notes-files-");
  const runDir = await writeTimedRun(cwd, RUN);
  const notesPath = path.join(runDir, "notes.json");
  await writeFile(notesPath, Buffer.alloc(OVERSIZED, 0x20));
  return { notesPath, prepared: await bindExistingRunArtifactPaths(cwd, RUN) };
}

describe("reading notes.json", () => {
  it("refuses a notes.json over 8 MiB without reading it", async () => {
    const { notesPath, prepared } = await oversizedNotes();

    let refusal: unknown;
    const read = await bytesReadDuring(async () => {
      refusal = await readRunNotes(prepared).catch((error: unknown) => error);
    });

    expect(refusal).toEqual(new Error("HUMANISH_NOTES_UNREADABLE"));
    expect(read).toBeLessThan(OVERSIZED);
    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "More." });
    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTES_UNREADABLE" } });
    expect((await readFile(notesPath)).length).toBe(OVERSIZED);
  });
});
