import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, expect, it } from "vitest";
import { lab } from "../admission/fixtures.js";
import { studyFileText } from "../helpers/study-file.js";

// `lab run --rerun-failed-from <run> --participants <ids>` is the example in `lab run --help`.
// The CLI must pass the selection as rerun.participantIds: runStudyWith refuses the removed
// rerun.laneIds with HUMANISH_STUDY_OPTION_UNSUPPORTED. A child process gives the real stderr, where
// Node prints warnings.

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
afterAll(async () => {
  await Promise.all(cleanup.map((dir) => rm(dir, { recursive: true, force: true })));
});

it("passes the selected participants to the rerun check without a warning", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-rerun-participants-"));
  cleanup.push(cwd);
  await writeFile(path.join(cwd, "package.json"), '{ "name": "rerun-participants-fixture" }\n');
  await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
  const raw = lab("cuAppUrl", {}, { lanes: [{ id: "lane-01" }, { id: "lane-02" }] });
  await writeFile(
    path.join(cwd, "humanish", "studies", "fanout.yaml"),
    studyFileText({ ...raw, id: "fanout" }, cwd),
  );

  const child = await execFileAsync(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      path.resolve("src/cli.ts"),
      "run",
      "fanout",
      "--cwd",
      cwd,
      "--rerun-failed-from",
      "latest",
      "--participants",
      "lane-02",
      "--dry-run",
      "--json",
    ],
    { env: { ...process.env, DO_NOT_TRACK: "1" } },
  ).catch((error: { stdout: string; stderr: string; code: number }) => error);

  expect(child.stderr).not.toContain("DeprecationWarning");
  // The selection reached the rerun check: there is no earlier run to rerun from.
  const result = JSON.parse(child.stdout) as { error?: { code?: string } };
  expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_RERUN_INVALID");
});
