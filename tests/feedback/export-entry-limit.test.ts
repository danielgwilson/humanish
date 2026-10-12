// Bundle export counts a run's files and folders against the same limit the public-safety scan
// reads, so a run verify grades share_ready also exports: 10,000 for any run and 5,000 for each
// participant its run.json records.
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";

import { exportRun } from "../../src/feedback/export.js";
import { verifyRun } from "../../src/verify/verify.js";
import { shareSafetyDryRun } from "../helpers/share-safety-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

it("exports a one-participant run past 10,000 entries that verify grades share_ready", async () => {
  const cwd = await makeTestTempDir("humanish-export-entries-");
  const { runId, runDir } = await shareSafetyDryRun(cwd);
  const runEntries = (await readdir(runDir, { recursive: true })).length;
  const many = path.join(runDir, "many");
  await mkdir(many);
  for (let index = 0; index < 12_000 - runEntries; index += 1)
    await mkdir(path.join(many, String(index).padStart(5, "0")));
  expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");

  const exported = await exportRun(cwd, runId, {
    format: "bundle",
    redactScreenshots: true,
    out: "shared",
  });
  if (!exported.ok) throw new Error(exported.error.message);
  expect((await verifyRun(path.join(cwd, "shared"), runId)).shareSafety.status).toBe("share_ready");
}, 120_000);
