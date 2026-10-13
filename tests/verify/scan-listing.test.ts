// The public-safety scan lists every directory of a run. A directory it cannot list, and the
// entries past the most it lists, hold files it never read, so the run cannot grade share_ready.
// `humanish verify` names each as a folder, not as a file it could not read.
import { CommanderError, type Command } from "commander";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { mapWithConcurrency } from "../../src/run/concurrency.js";
import { verifyRun } from "../../src/verify/verify.js";
import { shareSafetyDryRun } from "../helpers/share-safety-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

// The scan lists a directory with readdir(path); storage validation passes options. One listing of
// `target` by the scan fails as a transient permission error would.
const failing = vi.hoisted(() => ({ target: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (...args: Parameters<typeof actual.readdir>) => {
      const [directory, options] = args;
      if (failing.target !== "" && options === undefined && String(directory) === failing.target) {
        failing.target = "";
        throw Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
      }
      return actual.readdir(...args);
    }) as typeof actual.readdir,
  };
});

/** `humanish verify --run <runId>`'s exit code, its first line and its share-safety lines. */
async function verifyCli(
  cwd: string,
  runId: string,
): Promise<{ exitCode: number; summary: string; shareSafety: string[] }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => {},
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", "verify", "--run", runId, "--cwd", cwd], {
      from: "node",
    });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  const lines = stdout.join("").split("\n");
  return {
    exitCode,
    summary: lines[0] ?? "",
    shareSafety: lines.filter((line) => line.startsWith("share-safety: ")),
  };
}

describe("the public-safety scan's directory listing", () => {
  it("names a directory it could not list as unscanned", async () => {
    const cwd = await makeTestTempDir("humanish-scan-listing-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    const extras = path.join(await realpath(runDir), "extras");
    await mkdir(extras);
    await writeFile(path.join(extras, "notes.txt"), "Plain text.\n");
    expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");
    failing.target = extras;

    const verified = await verifyCli(cwd, runId);

    expect(verified.exitCode).toBe(0);
    expect(verified.shareSafety).toEqual([
      "share-safety: UNSCANNED_ARTIFACT: The public-safety scan could not list 1 folder, so it read none of the files in it: extras/. Review the run folder before sharing.",
    ]);
  });

  it("reads 15,000 entries of a one-participant run and names the stop past them", async () => {
    const cwd = await makeTestTempDir("humanish-scan-entries-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    const runEntries = (await readdir(runDir, { recursive: true })).length;
    // Empty directories: the walk counts them without reading any file. The run's own files and
    // these come to the limit for one participant: 10,000 for any run and 5,000 for each participant.
    const many = path.join(runDir, "many");
    await mkdir(many);
    // Made 64 at a time: one at a time, 15,000 of them took 8 s on a loaded box.
    const makeAll = (names: string[]) =>
      mapWithConcurrency(names, 64, (name) => mkdir(path.join(many, name)));
    await makeAll(
      Array.from({ length: 15_000 - runEntries - 1 }, (_, index) => String(index).padStart(5, "0")),
    );
    expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");

    // Enough more that many/ alone passes the limit, whatever order the run folder lists in.
    await makeAll(Array.from({ length: runEntries + 1 }, (_, index) => `more-${index}`));
    const verified = await verifyCli(cwd, runId);

    expect(verified.exitCode).toBe(0);
    expect(verified.summary).toMatch(/ · local_only · \d+ checks passed$/);
    expect(verified.shareSafety).toEqual([
      "share-safety: UNSCANNED_ARTIFACT: The public-safety scan stopped at its limit of 15000 files and folders while listing many/, so it read nothing listed after that point. Review the run folder before sharing.",
    ]);
    // Two scans of 15,000 entries: about 19 s alone, and past 60 s at a load average of 30.
  }, 120_000);
});
