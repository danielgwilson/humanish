import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runDryRun } from "../../src/run/dry-run.js";

// The seam: the mkdir of the run under test first replaces the latest pointer with a directory,
// after createRunArtifactPaths checked it and before preparation checks it again.
const race = vi.hoisted(() => ({ pointer: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (race.pointer !== "" && path.basename(String(args[0])) === "raced") {
        const pointer = race.pointer;
        race.pointer = "";
        await actual.rm(pointer, { force: true });
        await actual.mkdir(pointer);
      }
      return actual.mkdir(...args);
    },
  };
});

describe("a pointer that changes after the check", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-pointer-race-"));
  });
  afterEach(async () => {
    race.pointer = "";
    await rm(cwd, { recursive: true, force: true });
  });

  it("removes the new run directory, so the id stays free", async () => {
    const runsRoot = path.join(cwd, ".humanish", "runs");
    const latest = path.join(runsRoot, "latest.json");
    await mkdir(runsRoot, { recursive: true });
    race.pointer = latest;

    await expect(runDryRun({ cwd, dryRun: true, runId: "raced" })).rejects.toThrow(
      /single-link regular files/,
    );
    expect(await readdir(runsRoot)).toEqual(["latest.json"]);

    await rm(latest, { recursive: true });
    expect((await runDryRun({ cwd, dryRun: true, runId: "raced" })).ok).toBe(true);
  });
});
