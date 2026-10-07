// A feedback draft checks the notes it includes, as read for the draft. Here notes.json changes
// after verify graded the run share_ready and before the draft reads it.
import { cp, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { draftFeedback } from "../../src/feedback/feedback.js";
import { RUN_NOTES_SCHEMA } from "../../src/run/notes.js";
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

function notesFile(text: string): string {
  return JSON.stringify({
    schema: RUN_NOTES_SCHEMA,
    runId: RUN,
    notes: [
      {
        id: "note-raced",
        atMs: 0,
        participant: null,
        nearest: null,
        text,
        author: "you",
        createdAt: "2026-05-01T10:00:00.000Z",
        editedAt: null,
      },
    ],
  });
}

describe("reviewer notes that change after verify", () => {
  it("refuses a draft whose notes look like a secret when the draft reads them", async () => {
    const cwd = await makeTestTempDir("humanish-notes-race-");
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runSyntheticLive({ cwd, dryRun: true, runId: RUN });
    const notesPath = path.join(cwd, ".humanish", "runs", RUN, "notes.json");
    await writeFile(notesPath, notesFile("Clean note."));
    swap.notesPath = notesPath;
    swap.text = notesFile(`Key ${SECRET}`);

    const drafted = await draftFeedback(cwd, RUN);

    expect(drafted).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_FEEDBACK_SHARE_SAFETY_BLOCKED" },
      shareSafety: { status: "blocked", reasons: [{ code: "PUBLIC_SAFETY_FINDINGS" }] },
    });
    expect(JSON.stringify(drafted)).not.toContain(SECRET);
  });
});
