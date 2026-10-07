import { cp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { addRunNote, readRunNotes, RUN_NOTES_SCHEMA } from "../../src/run/notes.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { FIRST_PARTICIPANT, SECOND_PARTICIPANT, writeTimedRun } from "../helpers/timed-run.js";

const RUN_ID = "timed-notes-run";

async function timedRun() {
  const cwd = await makeTestTempDir("humanish-notes-");
  const runDir = await writeTimedRun(cwd, RUN_ID);
  return { cwd, runDir, prepared: await bindExistingRunArtifactPaths(cwd, RUN_ID) };
}

describe("reviewer notes on a recorded run", () => {
  it("adds a note at a moment and reads it back from notes.json in the run directory", async () => {
    const { runDir, prepared } = await timedRun();

    const added = await addRunNote(prepared, {
      atMs: 151_000,
      participant: FIRST_PARTICIPANT,
      text: "They looked for the save button here.",
    });

    expect(added.ok).toBe(true);
    const stored = JSON.parse(await readFile(path.join(runDir, "notes.json"), "utf8"));
    expect(stored).toMatchObject({ schema: RUN_NOTES_SCHEMA, runId: RUN_ID });
    expect(await readRunNotes(prepared)).toEqual(stored);
    expect(stored.notes).toEqual([
      {
        id: expect.stringMatching(/^note-/),
        atMs: 151_000,
        participant: FIRST_PARTICIPANT,
        nearest: { participant: FIRST_PARTICIPANT, itemId: "capture-003" },
        text: "They looked for the save button here.",
        author: "you",
        createdAt: expect.any(String),
        editedAt: null,
      },
    ]);
  });

  it("refuses a participant the run does not have and names the ones it has", async () => {
    const { runDir, prepared } = await timedRun();

    const added = await addRunNote(prepared, {
      atMs: 1_000,
      participant: "stream-three",
      text: "Who is this?",
    });

    expect(added).toEqual({
      ok: false,
      error: {
        code: "HUMANISH_NOTE_UNKNOWN_PARTICIPANT",
        message: expect.stringContaining("stream-one, stream-two"),
      },
    });
    await expect(readFile(path.join(runDir, "notes.json"))).rejects.toThrow(/ENOENT/);
  });

  it("refuses a moment before the run clock starts or after the second it ends", async () => {
    const { runDir, prepared } = await timedRun();

    for (const atMs of [-1, 152_000, Number.NaN]) {
      const added = await addRunNote(prepared, { atMs, participant: null, text: "Late." });
      expect(added).toEqual({
        ok: false,
        error: {
          code: "HUMANISH_NOTE_OUTSIDE_RUN",
          message: expect.stringContaining("00:00 to 02:31"),
        },
      });
    }
    await expect(readFile(path.join(runDir, "notes.json"))).rejects.toThrow(/ENOENT/);
  });

  it("keeps a moment inside the run clock's last second at the run's end", async () => {
    const { prepared } = await timedRun();

    const added = await addRunNote(prepared, { atMs: 151_900, participant: null, text: "End." });

    expect(added.ok && added.note.atMs).toBe(151_000);
  });

  it("refuses empty text, text over 2000 characters and control characters", async () => {
    const { runDir, prepared } = await timedRun();

    for (const text of ["", "   \n ", "x".repeat(2001), "bell \u0007 here"]) {
      const added = await addRunNote(prepared, { atMs: 0, participant: null, text });
      expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTE_INVALID" } });
    }
    await expect(readFile(path.join(runDir, "notes.json"))).rejects.toThrow(/ENOENT/);
  });

  it("replaces secret-shaped values and local paths before the note is written", async () => {
    const { runDir, prepared } = await timedRun();
    const secret = "sk-" + "syntheticvalue1234567890abcdef";

    const added = await addRunNote(prepared, {
      atMs: 0,
      participant: null,
      text: `Pasted ${secret} from /home/reviewer/keys.txt by mistake.\r\nSecond line.`,
    });

    expect(added).toMatchObject({ ok: true, scrubbed: true });
    const stored = await readFile(path.join(runDir, "notes.json"), "utf8");
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain("/home/reviewer");
    expect(added.ok && added.note.text).toBe(
      "Pasted [REDACTED_SECRET] from [REDACTED_RUNTIME_PATH] by mistake.\nSecond line.",
    );
  });

  it("points a note on the whole run at the latest moment any participant recorded", async () => {
    const { prepared } = await timedRun();

    const added = await addRunNote(prepared, { atMs: 95_000, participant: null, text: "Both." });

    expect(added.ok && added.note.nearest).toEqual({
      participant: SECOND_PARTICIPANT,
      itemId: "capture-102",
    });
  });

  it("refuses a note on a run whose captures carry no times", async () => {
    const cwd = await makeTestTempDir("humanish-notes-");
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: "untimed-run" });

    const added = await addRunNote(await bindExistingRunArtifactPaths(cwd, "untimed-run"), {
      atMs: 0,
      participant: null,
      text: "When?",
    });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTE_NO_CLOCK" } });
  });

  it("keeps every note when several are added at once", async () => {
    const { prepared } = await timedRun();

    const added = await Promise.all(
      [1, 2, 3, 4, 5].map((second) =>
        addRunNote(prepared, { atMs: second * 1000, participant: null, text: `Note ${second}` }),
      ),
    );

    expect(added.every((result) => result.ok)).toBe(true);
    expect((await readRunNotes(prepared))?.notes.map((note) => note.text).sort()).toEqual([
      "Note 1",
      "Note 2",
      "Note 3",
      "Note 4",
      "Note 5",
    ]);
  });

  it("leaves a notes.json it cannot read in place and refuses to add to it", async () => {
    const { runDir, prepared } = await timedRun();
    await writeFile(path.join(runDir, "notes.json"), "{ not json");

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Lost?" });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTES_UNREADABLE" } });
    expect(await readFile(path.join(runDir, "notes.json"), "utf8")).toBe("{ not json");
  });

  it("refuses a notes.json that links outside the run and leaves the target alone", async () => {
    const { cwd, runDir, prepared } = await timedRun();
    const outside = path.join(cwd, "outside.json");
    await writeFile(outside, "outside");
    await symlink(outside, path.join(runDir, "notes.json"));

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Escape?" });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_INVALID_RUN_BUNDLE" } });
    expect(await readFile(outside, "utf8")).toBe("outside");
  });

  it("refuses a note past 500 notes on one run", async () => {
    const { runDir, prepared } = await timedRun();
    const first = await addRunNote(prepared, { atMs: 0, participant: null, text: "First." });
    if (!first.ok) throw new Error(first.error.message);
    const full = {
      ...first.notes,
      notes: Array.from({ length: 500 }, (_, index) => ({ ...first.note, id: `note-${index}` })),
    };
    await writeFile(path.join(runDir, "notes.json"), JSON.stringify(full));

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "One more." });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTES_FULL" } });
  });
});
