import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { remoteRunHere } from "../../src/remote/reattach.js";
import { createRunArtifactPaths } from "../../src/run/paths.js";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-reattach-"));
});
afterEach(() => rm(cwd, { recursive: true, force: true }));

async function remoteRun(runId: string, files: Record<string, string>) {
  const created = await createRunArtifactPaths(cwd, runId);
  if (!created.ok) throw new Error("run directory not created");
  for (const [name, text] of Object.entries(files))
    await writeFile(path.join(created.paths.physicalRunRoot, name), text);
}

const RECORD = JSON.stringify({ schema: "humanish.remote-run.v1", provider: "modal" });
const RUNNER_RECEIPT = `${JSON.stringify({ at: "2026-10-21T00:00:00.000Z", laneId: "runner", provider: "modal", sandboxId: "fake-sb-runner" })}\n`;

describe("finding a remote run to follow", () => {
  it("names the runner of a remote run not copied back yet", async () => {
    await remoteRun("cua-remote", {
      "remote.json": RECORD,
      "sandbox-receipts.ndjson": RUNNER_RECEIPT,
    });
    expect(await remoteRunHere(cwd, "cua-remote")).toMatchObject({
      runId: "cua-remote",
      provider: "modal",
      runnerId: "fake-sb-runner",
    });
  });

  it("leaves a copied-back run, a local run and a missing run to the Observer", async () => {
    await remoteRun("cua-copied", {
      "remote.json": RECORD,
      "sandbox-receipts.ndjson": RUNNER_RECEIPT,
      "run.json": "{}",
    });
    await remoteRun("cua-local", { "sandbox-receipts.ndjson": RUNNER_RECEIPT });
    await mkdir(path.join(cwd, ".humanish"), { recursive: true });
    for (const runId of ["cua-copied", "cua-local", "cua-missing"])
      expect(await remoteRunHere(cwd, runId)).toBeUndefined();
  });
});
