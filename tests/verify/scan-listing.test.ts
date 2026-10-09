// The public-safety scan lists every directory of a run. A directory it cannot list, and the
// entries past the most it lists, hold files it never read, so the run cannot grade share_ready.
// `humanish verify` names each as a folder, not as a file it could not read.
import { CommanderError, type Command } from "commander";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
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

/** `humanish verify --run <runId>`'s exit code and its share-safety lines. */
async function verifyCli(
  cwd: string,
  runId: string,
): Promise<{ exitCode: number; shareSafety: string[] }> {
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
  return { exitCode, shareSafety: lines.filter((line) => line.startsWith("share-safety: ")) };
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

  it("stops after 10,000 entries and names the stop as unscanned", async () => {
    const cwd = await makeTestTempDir("humanish-scan-entries-");
    const { runId, runDir } = await shareSafetyDryRun(cwd);
    // Empty directories: the walk counts them without reading any file.
    const many = path.join(runDir, "many");
    await mkdir(many);
    for (let index = 0; index < 10_001; index += 1)
      await mkdir(path.join(many, String(index).padStart(5, "0")));

    const verified = await verifyCli(cwd, runId);

    expect(verified.exitCode).toBe(0);
    expect(verified.shareSafety).toEqual([
      "share-safety: UNSCANNED_ARTIFACT: The public-safety scan stopped at its limit of 10000 files and folders while listing many/, so it read nothing listed after that point. Review the run folder before sharing.",
    ]);
    expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("local_only");
  }, 60_000);
});
