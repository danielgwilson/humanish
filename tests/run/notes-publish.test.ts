// A new note is published without replacing anything: when its name is taken between the moment
// the id is chosen and the moment the file appears, the note takes a new id, and the file that
// took the name keeps its bytes.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { addRunNote } from "../../src/run/notes.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";
import { writeTimedRun } from "../helpers/timed-run.js";

const RUN = "published-notes-run";
const OCCUPANT = "another writer's file";
const occupy = vi.hoisted(() => ({ times: 0, taken: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  /** Writes the occupant at a note's final name just before a publish call reaches it. */
  const occupied =
    <A extends unknown[]>(publish: (from: string, to: string, ...rest: A) => Promise<void>) =>
    async (from: string, to: string, ...rest: A): Promise<void> => {
      if (occupy.times > 0 && /[/\\]notes[/\\]note-[^/\\]+\.json$/.test(String(to))) {
        occupy.times -= 1;
        occupy.taken.push(String(to));
        await actual.writeFile(to, OCCUPANT, { flag: "wx" });
      }
      return publish(from, to, ...rest);
    };
  return {
    ...actual,
    rename: occupied(actual.rename),
    link: occupied(actual.link),
  };
});

async function timedRun() {
  const cwd = await makeTestTempDir("humanish-notes-publish-");
  const runDir = await writeTimedRun(cwd, RUN);
  return { runDir, prepared: await bindExistingRunArtifactPaths(cwd, RUN) };
}

describe("publishing a new note", () => {
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
