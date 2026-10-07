// notes.json as a file: reads stop at the size limit before anything is decoded.
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
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

const LOCK_WAIT_LIMIT_MS = 6000;

/** A promise and the function that resolves it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/**
 * A note writer in another process that takes the run's notes lock and exits while it holds it,
 * as a crashed `humanish notes --add` would.
 */
async function lockLeftByExitedProcess(cwd: string): Promise<void> {
  const notes = path.resolve("src/run/notes.ts");
  const paths = path.resolve("src/run/paths.ts");
  const script = [
    `import { addRunNote } from ${JSON.stringify(notes)};`,
    `import { bindExistingRunArtifactPaths } from ${JSON.stringify(paths)};`,
    `const prepared = await bindExistingRunArtifactPaths(${JSON.stringify(cwd)}, ${JSON.stringify(RUN)});`,
    `await addRunNote(prepared, { atMs: 0, participant: null, text: "Never saved." }, { beforeWrite: async () => process.exit(0) });`,
  ].join("\n");
  await promisify(execFile)(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    script,
  ]);
}

async function lockedRun() {
  const cwd = await makeTestTempDir("humanish-notes-lock-");
  const runDir = await writeTimedRun(cwd, RUN);
  return { cwd, runDir, prepared: await bindExistingRunArtifactPaths(cwd, RUN) };
}

const savedTexts = async (runDir: string): Promise<string[]> =>
  (
    JSON.parse(await readFile(path.join(runDir, "notes.json"), "utf8")) as {
      notes: Array<{ text: string }>;
    }
  ).notes.map((note) => note.text);

describe("the notes lock", () => {
  it("never takes over a lock a live writer holds, however old the lock is", async () => {
    const { runDir, prepared } = await lockedRun();
    const holding = gate();
    const release = gate();
    const first = addRunNote(
      prepared,
      { atMs: 0, participant: null, text: "First." },
      {
        beforeWrite: async () => {
          holding.open();
          await release.opened;
        },
      },
    );
    await holding.opened;
    const hourAgo = new Date(Date.now() - 3_600_000);
    await utimes(path.join(runDir, ".notes-lock"), hourAgo, hourAgo);

    const second = addRunNote(prepared, { atMs: 1000, participant: null, text: "Second." });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release.open();

    expect((await first).ok).toBe(true);
    expect((await second).ok).toBe(true);
    expect((await savedTexts(runDir)).sort()).toEqual(["First.", "Second."]);
    expect(await readdir(runDir)).not.toContain(".notes-lock");
  });

  it("takes over a lock whose writer exited on this machine", async () => {
    const { cwd, runDir, prepared } = await lockedRun();
    await lockLeftByExitedProcess(cwd);
    expect(await readdir(runDir)).toContain(".notes-lock");

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "After." });

    expect(added.ok).toBe(true);
    expect(await savedTexts(runDir)).toEqual(["After."]);
    expect(await readdir(runDir)).not.toContain(".notes-lock");
  });

  it(
    "answers busy within its wait for a lock it cannot remove, and deletes nothing in it",
    async () => {
      const { runDir, prepared } = await lockedRun();
      await mkdir(path.join(runDir, ".notes-lock"));
      await writeFile(path.join(runDir, ".notes-lock", "keep"), "keep");
      const hourAgo = new Date(Date.now() - 3_600_000);
      await utimes(path.join(runDir, ".notes-lock"), hourAgo, hourAgo);

      const started = Date.now();
      const added = await Promise.race([
        addRunNote(prepared, { atMs: 0, participant: null, text: "Blocked." }),
        new Promise((resolve) => setTimeout(() => resolve("still waiting"), LOCK_WAIT_LIMIT_MS)),
      ]);

      expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTES_BUSY" } });
      expect(Date.now() - started).toBeLessThan(LOCK_WAIT_LIMIT_MS);
      expect(await readdir(path.join(runDir, ".notes-lock"))).toEqual(["keep"]);
    },
    LOCK_WAIT_LIMIT_MS * 2,
  );

  it("answers busy for an exited writer's lock that holds something else, and deletes nothing", async () => {
    const { cwd, runDir, prepared } = await lockedRun();
    await lockLeftByExitedProcess(cwd);
    await writeFile(path.join(runDir, ".notes-lock", "keep"), "keep");

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Blocked." });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTES_BUSY" } });
    expect((await readdir(path.join(runDir, ".notes-lock"))).sort()).toEqual([
      "keep",
      "owner.json",
    ]);
  });

  it("never removes a lock another writer took after the exited writer's lock was found", async () => {
    const { cwd, runDir, prepared } = await lockedRun();
    await lockLeftByExitedProcess(cwd);
    const otherHolds = gate();
    const otherRelease = gate();
    let other: ReturnType<typeof addRunNote> | undefined;

    const reclaiming = addRunNote(
      prepared,
      { atMs: 0, participant: null, text: "Reclaimer." },
      {
        // Between finding the exited writer and removing its lock, another writer removes that
        // lock and takes its own.
        beforeReclaim: async () => {
          if (other) return;
          other = addRunNote(
            prepared,
            { atMs: 1000, participant: null, text: "Other." },
            {
              beforeWrite: async () => {
                otherHolds.open();
                await otherRelease.opened;
              },
            },
          );
          await otherHolds.opened;
        },
      },
    );
    await otherHolds.opened;
    await new Promise((resolve) => setTimeout(resolve, 300));
    otherRelease.open();

    expect((await reclaiming).ok).toBe(true);
    expect((await other)?.ok).toBe(true);
    expect((await savedTexts(runDir)).sort()).toEqual(["Other.", "Reclaimer."]);
  });
});
