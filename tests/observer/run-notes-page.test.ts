// The Observer page carries a run's reviewer notes in its run-notes slot, and a token for adding
// one only when a loopback server asks for it.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { renderObserverHtml } from "../../src/observer/artifact.js";
import { buildObserverData } from "../../src/observer/data.js";
import { renderObserver, serveObserver } from "../../src/observer/render.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { addRunNote, type RunNote, type RunNotes } from "../../src/run/notes.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { bytesReadDuring } from "../helpers/bytes-read.js";
import { noteId } from "../helpers/note-files.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

const RUN = "noted-page-run";

/** The run-notes slot of a rendered page. */
function notesSlot(html: string): unknown {
  const match = /<script id="run-notes" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("the page has no run-notes slot");
  return JSON.parse(match[1]!);
}

async function notedRun(): Promise<{
  cwd: string;
  runDir: string;
  note: RunNote;
  notes: RunNotes;
}> {
  const cwd = await makeTestTempDir("humanish-notes-page-");
  const runDir = await writeTimedRun(cwd, RUN);
  const added = await addRunNote(await bindExistingRunArtifactPaths(cwd, RUN), {
    atMs: 60_000,
    participant: null,
    text: "The whole page went blank here.",
  });
  if (!added.ok) throw new Error(added.error.message);
  return { cwd, runDir, note: added.note, notes: { runId: RUN, notes: [added.note], skipped: [] } };
}

describe("reviewer notes in the Observer page", () => {
  it("the saved Observer page shows the run's notes and carries no token to add one", async () => {
    const { cwd, runDir, note } = await notedRun();

    expect((await renderObserver(cwd, RUN, { open: false })).ok).toBe(true);

    const html = await readFile(path.join(runDir, "observer", "index.html"), "utf8");
    expect(notesSlot(html)).toEqual({
      notes: { runId: RUN, notes: [note], skipped: 0 },
      write: null,
    });
  });

  it("carries a token only when the caller passes one, and never in a snapshot", async () => {
    const { runDir, notes } = await notedRun();
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const data = buildObserverData(bundle);
    const token = "t".repeat(43);

    const slotted = { runId: RUN, notes: notes.notes, skipped: 0 };
    expect(notesSlot(renderObserverHtml(data, { notes, notesToken: token }))).toEqual({
      notes: slotted,
      write: { token },
    });
    expect(
      notesSlot(renderObserverHtml(data, { notes, notesToken: token, snapshot: true })),
    ).toEqual({ notes: slotted, write: null });
  });

  it("serves no file under notes/ over 16 KiB, note or media, and never reads it", async () => {
    const { cwd, runDir, note } = await notedRun();
    const oversized = 17 * 1024;
    const big = noteId(1);
    await writeFile(path.join(runDir, "notes", `${big}.json`), Buffer.alloc(oversized, 0x20));
    const server = await serveObserver(await renderObserver(cwd, RUN, { open: false }), {
      open: false,
      scope: "run",
    });
    // Written after the saved page is rendered: verify refuses unregistered media in a run.
    await writeFile(path.join(runDir, "notes", "large.mp4"), Buffer.alloc(oversized, 0x20));
    try {
      let page = "";
      let raw = 0;
      let media = 0;
      const read = await bytesReadDuring(async () => {
        const response = await fetch(new URL("/observer/index.html", server.url));
        expect(response.status).toBe(200);
        page = await response.text();
        raw = (await fetch(new URL(`/notes/${big}.json`, server.url))).status;
        // Media under notes/ gets the note limit too, before any media handling.
        media = (await fetch(new URL("/notes/large.mp4", server.url))).status;
      });

      expect(notesSlot(page)).toMatchObject({
        notes: { runId: RUN, notes: [note], skipped: 2 },
      });
      expect(raw).toBe(404);
      expect(media).toBe(404);
      expect(read).toBeLessThan(oversized);
      const small = await fetch(new URL(`/notes/${note.id}.json`, server.url));
      expect(small.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
