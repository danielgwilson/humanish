// The Observer page carries a run's reviewer notes in its run-notes slot, and a token for adding
// one only when a loopback server asks for it.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { renderObserverHtml } from "../../src/observer/artifact.js";
import { buildObserverData } from "../../src/observer/data.js";
import { renderObserver } from "../../src/observer/render.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { addRunNote, type RunNotes } from "../../src/run/notes.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

const RUN = "noted-page-run";

/** The run-notes slot of a rendered page. */
function notesSlot(html: string): unknown {
  const match = /<script id="run-notes" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (!match) throw new Error("the page has no run-notes slot");
  return JSON.parse(match[1]!);
}

async function notedRun(): Promise<{ cwd: string; runDir: string; notes: RunNotes }> {
  const cwd = await makeTestTempDir("humanish-notes-page-");
  const runDir = await writeTimedRun(cwd, RUN);
  const added = await addRunNote(await bindExistingRunArtifactPaths(cwd, RUN), {
    atMs: 60_000,
    participant: null,
    text: "The whole page went blank here.",
  });
  if (!added.ok) throw new Error(added.error.message);
  return { cwd, runDir, notes: added.notes };
}

describe("reviewer notes in the Observer page", () => {
  it("the saved Observer page shows the run's notes and carries no token to add one", async () => {
    const { cwd, runDir, notes } = await notedRun();

    expect((await renderObserver(cwd, RUN, { open: false })).ok).toBe(true);

    const html = await readFile(path.join(runDir, "observer", "index.html"), "utf8");
    expect(notesSlot(html)).toEqual({ notes, write: null });
  });

  it("carries a token only when the caller passes one, and never in a snapshot", async () => {
    const { runDir, notes } = await notedRun();
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const data = buildObserverData(bundle);
    const token = "t".repeat(43);

    expect(notesSlot(renderObserverHtml(data, { notes, notesToken: token }))).toEqual({
      notes,
      write: { token },
    });
    expect(
      notesSlot(renderObserverHtml(data, { notes, notesToken: token, snapshot: true })),
    ).toEqual({ notes, write: null });
  });
});
