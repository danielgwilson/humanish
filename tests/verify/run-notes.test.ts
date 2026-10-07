// verify reads a run's note files as it reads the rest of the run's text: a secret-shaped value
// planted in a note keeps the run from share_ready, and a note added through humanish does not.
import path from "node:path";
import { describe, expect, it } from "vitest";

import { addRunNote } from "../../src/run/notes.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { verifyRun } from "../../src/verify/verify.js";
import { writeNoteFile } from "../helpers/note-files.js";
import { shareSafetyDryRun } from "../helpers/share-safety-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

// Concatenated so this file never holds a secret-shaped literal; the text scan detects it.
const SYNTHETIC_SECRET = "sk-" + "syntheticvalue1234567890abcdef";

describe("verify and reviewer notes", () => {
  it("blocks share_ready when a note file holds a planted secret-shaped value", async () => {
    const cwd = await makeTestTempDir("humanish-notes-verify-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");

    const planted = await writeNoteFile(runDir, runId, { text: `Key ${SYNTHETIC_SECRET}` });

    const verified = await verifyRun(cwd, runId);
    expect(verified.shareSafety.status).toBe("blocked");
    expect(verified.shareSafety.reasons.map((reason) => reason.code)).toContain(
      "PUBLIC_SAFETY_FINDINGS",
    );
    expect(verified.checks.find((check) => check.name === "public-safety scan")?.message).toContain(
      path.relative(runDir, planted),
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
