// Reviewer notes on disk: one file per note in notes/, written once and never rewritten, read
// within a per-note size limit, with anything else skipped and named.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { readRunNotes } from "../../src/run/note-files.js";
import { addRunNote } from "../../src/run/notes.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { bytesReadDuring } from "../helpers/bytes-read.js";
import { noteEntries, noteId, writeNoteFile } from "../helpers/note-files.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

const RUN = "notes-files-run";

async function timedRun() {
  const cwd = await makeTestTempDir("humanish-notes-files-");
  const runDir = await writeTimedRun(cwd, RUN);
  return { cwd, runDir, prepared: await bindExistingRunArtifactPaths(cwd, RUN) };
}

/** A `humanish notes --add` in another process, adding `count` notes one after another. */
async function addNotesInAnotherProcess(cwd: string, label: string, count: number): Promise<void> {
  const notes = path.resolve("src/run/notes.ts");
  const paths = path.resolve("src/run/paths.ts");
  const script = [
    `import { addRunNote } from ${JSON.stringify(notes)};`,
    `import { bindExistingRunArtifactPaths } from ${JSON.stringify(paths)};`,
    `const prepared = await bindExistingRunArtifactPaths(${JSON.stringify(cwd)}, ${JSON.stringify(RUN)});`,
    `for (let index = 0; index < ${count}; index += 1) {`,
    `  const added = await addRunNote(prepared, { atMs: index * 1000, participant: null, text: ${JSON.stringify(label)} + " " + index });`,
    `  if (!added.ok) throw new Error(added.error.message);`,
    `}`,
  ].join("\n");
  await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
  ]);
}

describe("one file per note", () => {
  it("writes each note once and never rewrites another, in creation order", async () => {
    const { runDir, prepared } = await timedRun();
    const first = await addRunNote(prepared, { atMs: 0, participant: null, text: "First." });
    if (!first.ok) throw new Error(first.error.message);
    const firstFile = path.join(runDir, "notes", `${first.note.id}.json`);
    const before = await stat(firstFile, { bigint: true });
    const firstBytes = await readFile(firstFile);

    const second = await addRunNote(prepared, { atMs: 1000, participant: null, text: "Second." });
    if (!second.ok) throw new Error(second.error.message);

    const after = await stat(firstFile, { bigint: true });
    expect([after.ino, after.mtimeNs, after.ctimeNs]).toEqual([
      before.ino,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    expect(await readFile(firstFile)).toEqual(firstBytes);
    expect(first.note.id < second.note.id).toBe(true);
    expect((await readRunNotes(prepared)).notes.map((note) => note.text)).toEqual([
      "First.",
      "Second.",
    ]);
  });

  it("keeps every note when two processes and this one add notes at once", async () => {
    const { cwd, prepared } = await timedRun();

    await Promise.all([
      addNotesInAnotherProcess(cwd, "Left", 5),
      addNotesInAnotherProcess(cwd, "Right", 5),
      ...[0, 1, 2, 3, 4].map((index) =>
        addRunNote(prepared, { atMs: index * 1000, participant: null, text: `Here ${index}` }),
      ),
    ]);

    const texts = (await readRunNotes(prepared)).notes.map((note) => note.text);
    expect(texts).toHaveLength(15);
    for (const label of ["Left", "Right", "Here"])
      for (const index of [0, 1, 2, 3, 4]) expect(texts).toContain(`${label} ${index}`);
  });
});

describe("reading notes/", () => {
  it("reads the notes it can and names every file it skipped", async () => {
    const { cwd, runDir, prepared } = await timedRun();
    await writeNoteFile(runDir, RUN, { id: noteId(1), text: "Readable." });
    await writeFile(path.join(runDir, "notes", "readme.txt"), "not a note");
    await writeFile(path.join(runDir, "notes", `${noteId(2)}.json`), "{ not json");
    await writeNoteFile(runDir, "another-run", { id: noteId(3), text: "Another run." });
    const mismatched = await writeNoteFile(runDir, RUN, { id: noteId(4), text: "Renamed." });
    await writeFile(path.join(runDir, "notes", `${noteId(5)}.json`), await readFile(mismatched));
    const outside = path.join(cwd, "outside.json");
    await writeFile(outside, "{}");
    await symlink(outside, path.join(runDir, "notes", `${noteId(6)}.json`));
    // A temporary file a writer that stopped mid-write left behind.
    await writeFile(path.join(runDir, "notes", ".humanish-write-1-left.tmp"), "{");

    const read = await readRunNotes(prepared);

    expect(read.notes.map((note) => note.text)).toEqual(["Readable.", "Renamed."]);
    expect(read.skipped).toHaveLength(5);
    for (const name of ["readme.txt", noteId(2), noteId(3), noteId(5), noteId(6)])
      expect(read.skipped.some((message) => message.includes(name))).toBe(true);
    expect(read.skipped.join(" ")).not.toContain(".humanish-write-");
  });

  it("skips a note file over 16 KiB without reading it", async () => {
    const { runDir, prepared } = await timedRun();
    const oversized = 17 * 1024;
    await writeNoteFile(runDir, RUN, { id: noteId(1), text: "Small." });
    await writeFile(path.join(runDir, "notes", `${noteId(2)}.json`), Buffer.alloc(oversized, 0x20));

    let read!: Awaited<ReturnType<typeof readRunNotes>>;
    const bytes = await bytesReadDuring(async () => {
      read = await readRunNotes(prepared);
    });

    expect(read.notes.map((note) => note.text)).toEqual(["Small."]);
    expect(read.skipped).toEqual([expect.stringContaining(noteId(2))]);
    expect(bytes).toBeLessThan(oversized);
  });

  it("reads the first 500 notes and says how many it left out", async () => {
    const { runDir, prepared } = await timedRun();
    for (let index = 0; index < 501; index += 1)
      await writeNoteFile(runDir, RUN, { id: noteId(index), text: `Note ${index}` });

    const read = await readRunNotes(prepared);

    expect(read.notes).toHaveLength(500);
    expect(read.notes.at(-1)?.text).toBe("Note 499");
    expect(read.skipped).toEqual([expect.stringContaining("1 note")]);
  });

  it("refuses a note past 500 on one run without reading the others", async () => {
    const { runDir, prepared } = await timedRun();
    for (let index = 0; index < 500; index += 1)
      await writeNoteFile(runDir, RUN, { id: noteId(index), text: `Note ${index}` });

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "One more." });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTES_FULL" } });
    expect(await noteEntries(runDir)).toHaveLength(500);
  });

  it("refuses to add through a notes folder that links outside the run", async () => {
    const { cwd, runDir, prepared } = await timedRun();
    const outside = path.join(cwd, "outside-notes");
    await mkdir(outside);
    await symlink(outside, path.join(runDir, "notes"));

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Escape?" });

    // Any link in a run directory makes its storage unsafe, run.json included.
    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_INVALID_RUN_BUNDLE" } });
    // The refusal names what the storage check found, which is not a problem with run.json.
    if (added.ok) throw new Error("the note was added");
    expect(added.error.message).toMatch(/symbolic link/);
    expect(added.error.message).not.toMatch(/run\.json/);
    expect(await readdir(outside)).toEqual([]);
    expect((await readRunNotes(prepared)).skipped).toEqual([expect.stringContaining("notes")]);
  });

  it("refuses to add when notes is a file and leaves it alone", async () => {
    const { runDir, prepared } = await timedRun();
    await writeFile(path.join(runDir, "notes"), "a file");

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Where?" });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTES_UNREADABLE" } });
    expect(await readFile(path.join(runDir, "notes"), "utf8")).toBe("a file");
  });
});
