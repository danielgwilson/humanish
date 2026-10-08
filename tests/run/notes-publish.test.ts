// A new note is published without replacing anything: when its name is taken between the moment
// the id is chosen and the moment the file appears, the note takes a new id, and the file that
// took the name keeps its bytes. While a note is published, the run directory passes the storage
// check that verify, serving and adding a note run.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { addRunNote } from "../../src/run/notes.js";
import {
  bindExistingRunArtifactPaths,
  validatePreparedRunArtifactPaths,
} from "../../src/run/paths.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

const RUN = "published-notes-run";
const OCCUPANT = "another writer's file";
const NOTE_FILE = /[/\\]notes[/\\]note-[^/\\]+\.json$/;
const occupy = vi.hoisted(() => ({ times: 0, taken: [] as string[] }));
/** Runs after each file system call on a path under notes/, with the call's name. */
const probe = vi.hoisted(() => ({
  afterNotesCall: undefined as ((call: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const underNotes = (args: unknown[]): boolean =>
    args.some((arg) => typeof arg === "string" && /[/\\]notes[/\\]/.test(arg));
  /**
   * The call, which first writes the occupant at a note's final name when the call names it, and
   * then lets the probe look at the run directory.
   */
  const watched =
    <A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const target = args.find((arg) => typeof arg === "string" && NOTE_FILE.test(arg));
      if (occupy.times > 0 && typeof target === "string") {
        occupy.times -= 1;
        occupy.taken.push(target);
        await actual.writeFile(target, OCCUPANT, { flag: "wx" });
      }
      const result = await call(...args);
      if (probe.afterNotesCall !== undefined && underNotes(args)) await probe.afterNotesCall(name);
      return result;
    };
  return {
    ...actual,
    open: watched("open", actual.open),
    rename: watched("rename", actual.rename),
    link: watched("link", actual.link),
    unlink: watched("unlink", actual.unlink),
  };
});

async function timedRun() {
  const cwd = await makeTestTempDir("humanish-notes-publish-");
  const runDir = await writeTimedRun(cwd, RUN);
  return { runDir, prepared: await bindExistingRunArtifactPaths(cwd, RUN) };
}

describe("publishing a new note", () => {
  it("keeps every file in the run directory a single-link regular file at each step", async () => {
    const { prepared } = await timedRun();
    const calls: string[] = [];
    const refusals: string[] = [];
    probe.afterNotesCall = async (call) => {
      calls.push(call);
      await validatePreparedRunArtifactPaths(prepared).catch((error: unknown) => {
        refusals.push(`after ${call}: ${String(error)}`);
      });
    };

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Mine." });
    probe.afterNotesCall = undefined;

    expect(added.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(refusals).toEqual([]);
  });

  it("takes a new id when its name is taken first, and leaves that file as it is", async () => {
    const { runDir, prepared } = await timedRun();
    occupy.times = 1;
    occupy.taken = [];

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Mine." });

    if (!added.ok) throw new Error(added.error.message);
    expect(occupy.taken).toHaveLength(1);
    expect(await readFile(occupy.taken[0]!, "utf8")).toBe(OCCUPANT);
    expect(path.basename(occupy.taken[0]!)).not.toBe(`${added.note.id}.json`);
    const saved = JSON.parse(
      await readFile(path.join(runDir, "notes", `${added.note.id}.json`), "utf8"),
    ) as { text: string };
    expect(saved.text).toBe("Mine.");
    expect((await readdir(path.join(runDir, "notes"))).sort()).toEqual(
      [path.basename(occupy.taken[0]!), `${added.note.id}.json`].sort(),
    );
  });

  it("gives up after a few taken ids, replacing nothing and leaving no temporary file", async () => {
    const { runDir, prepared } = await timedRun();
    occupy.times = 100;
    occupy.taken = [];

    const added = await addRunNote(prepared, { atMs: 0, participant: null, text: "Mine." });

    expect(added).toMatchObject({ ok: false, error: { code: "HUMANISH_NOTE_ID_TAKEN" } });
    expect(occupy.taken.length).toBeGreaterThan(1);
    expect(occupy.taken.length).toBeLessThan(10);
    for (const file of occupy.taken) expect(await readFile(file, "utf8")).toBe(OCCUPANT);
    expect((await readdir(path.join(runDir, "notes"))).sort()).toEqual(
      occupy.taken.map((file) => path.basename(file)).sort(),
    );
    occupy.times = 0;
  });
});
