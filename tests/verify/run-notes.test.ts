// verify reads a run's notes.json as it reads the rest of the run's text: a secret-shaped value
// planted in a note keeps the run from share_ready, and a note added through humanish does not.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { addRunNote, RUN_NOTES_SCHEMA } from "../../src/run/notes.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { verifyRun } from "../../src/verify/verify.js";
import { shareSafetyDryRun } from "../helpers/share-safety-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

// Concatenated so this file never holds a secret-shaped literal; the text scan detects it.
const SYNTHETIC_SECRET = "sk-" + "syntheticvalue1234567890abcdef";

function notesFile(runId: string, text: string): string {
  return JSON.stringify({
    schema: RUN_NOTES_SCHEMA,
    runId,
    notes: [
      {
        id: "note-planted",
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

describe("verify and reviewer notes", () => {
  it("blocks share_ready when notes.json holds a planted secret-shaped value", async () => {
    const cwd = await makeTestTempDir("humanish-notes-verify-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");

    await writeFile(path.join(runDir, "notes.json"), notesFile(runId, `Key ${SYNTHETIC_SECRET}`));

    const verified = await verifyRun(cwd, runId);
    expect(verified.shareSafety.status).toBe("blocked");
    expect(verified.shareSafety.reasons.map((reason) => reason.code)).toContain(
      "PUBLIC_SAFETY_FINDINGS",
    );
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.message).toContain(
      "notes.json",
    );
  });

  it("finds nothing in a note whose secret was replaced when it was added", async () => {
    const cwd = await makeTestTempDir("humanish-notes-verify-");
    await writeTimedRun(cwd, "timed-verify-run");
    const added = await addRunNote(await bindExistingRunArtifactPaths(cwd, "timed-verify-run"), {
      atMs: 0,
      participant: null,
      text: `Key ${SYNTHETIC_SECRET}`,
    });
    expect(added).toMatchObject({ ok: true, scrubbed: true });

    const verified = await verifyRun(cwd, "timed-verify-run");

    expect(verified.checks.find((check) => check.name === "public-safety scan")?.ok).toBe(true);
    expect(verified.shareSafety.reasons.map((reason) => reason.code)).not.toContain(
      "PUBLIC_SAFETY_FINDINGS",
    );
  });
});
