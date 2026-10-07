// A feedback draft checks the notes it includes, as read for the draft. Here a note is added after
// verify graded the run share_ready and before the draft reads the notes.
import { cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { draftFeedback } from "../../src/feedback/feedback.js";
import { noteFile, noteId, writeNoteFile } from "../helpers/note-files.js";
import { runSyntheticLive } from "../helpers/synthetic-live-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

const RUN = "raced-notes-run";
// Concatenated so this file never holds a secret-shaped literal.
const SECRET = "sk-" + "syntheticvalue1234567890abcdef";
const swap = vi.hoisted(() => ({ notesPath: "", text: "" }));

vi.mock("../../src/verify/verify.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/verify/verify.js")>();
  return {
    ...original,
    verifyRunPrepared: async (...args: Parameters<typeof original.verifyRunPrepared>) => {
      const verified = await original.verifyRunPrepared(...args);
      if (swap.notesPath) await writeFile(swap.notesPath, swap.text);
      return verified;
    },
  };
});

describe("a reviewer note added after verify", () => {
  it("refuses a draft whose notes look like a secret when the draft reads them", async () => {
    const cwd = await makeTestTempDir("humanish-notes-race-");
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runSyntheticLive({ cwd, dryRun: true, runId: RUN });
    const runDir = path.join(cwd, ".humanish", "runs", RUN);
    await writeNoteFile(runDir, RUN, { text: "Clean note." });
    // A second note, added after verify read the run.
    swap.notesPath = path.join(runDir, "notes", `${noteId(1)}.json`);
    swap.text = JSON.stringify(noteFile(RUN, { id: noteId(1), text: `Key ${SECRET}` }));

    const drafted = await draftFeedback(cwd, RUN);

    expect(drafted).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED" },
      shareSafety: { status: "blocked", reasons: [{ code: "PUBLIC_SAFETY_FINDINGS" }] },
    });
    expect(JSON.stringify(drafted)).not.toContain(SECRET);
  });
});
