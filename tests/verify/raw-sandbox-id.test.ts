// verify grades a run local_only when a file other than sandbox-receipts.ndjson names one of its
// raw sandbox ids. Runs from 0.110 keep them only in the receipts; earlier runs recorded them in
// run.json, and those grade local_only until exported.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { cleanupRun } from "../../src/run/stored-runs.js";
import { verifyRun } from "../../src/verify/verify.js";

const RUN = "sandbox-id-run";
// Shaped like an E2B id and built at run time, so this file holds none at a sandbox-id key.
const RAW = ["i", "q7m2x9k4w8", "n1p3v6z5a"].join("");

describe("verify on a run's sandbox ids", () => {
  let cwd: string;
  let runDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-raw-sandbox-id-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
    await writeFile(
      path.join(runDir, "sandbox-receipts.ndjson"),
      `${JSON.stringify({ at: "t", laneId: "lane-01", provider: "e2b", sandboxId: RAW })}\n`,
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const withResource = async (id: string, idDigest?: string): Promise<void> => {
    const file = path.join(runDir, "run.json");
    const bundle = JSON.parse(await readFile(file, "utf8")) as RunBundle;
    bundle.providerResources = [
      {
        schema: "humanish.provider-resource.v1",
        provider: "e2b-desktop",
        kind: "sandbox",
        id,
        ...(idDigest === undefined ? {} : { idDigest }),
        owner: "humanish",
        status: "killed",
      },
    ];
    await writeFile(file, `${JSON.stringify(bundle, null, 2)}\n`);
  };
  const rawIdReason = async () =>
    (await verifyRun(cwd, RUN)).shareSafety.reasons.find(
      (reason) => reason.code === "RAW_SANDBOX_ID",
    );

  it("passes a run whose only raw id is in its receipts, with the marker and digest in run.json", async () => {
    await withResource(REDACTED_SANDBOX_ID, sandboxIdDigest(RAW));
    expect(await rawIdReason()).toBeUndefined();
  });

  it("grades a run recorded before 0.110, with the raw id in run.json, local_only", async () => {
    await withResource(RAW);
    const result = await verifyRun(cwd, RUN);
    expect(result.shareSafety.status).toBe("local_only");
    expect(await rawIdReason()).toMatchObject({ message: expect.stringContaining("run.json") });
  });

  it("finds an older run's ids with no receipts, from run.json, in review.md", async () => {
    await rm(path.join(runDir, "sandbox-receipts.ndjson"));
    await withResource(RAW);
    const review = path.join(runDir, "review.md");
    await writeFile(review, `${await readFile(review, "utf8")}\nSandbox ${RAW} reclaimed.\n`);
    expect((await rawIdReason())?.message).toContain("review.md, run.json");
  });

  it("grades an export copy from 0.109.1 local_only: no receipts, a raw id in cleanup.json", async () => {
    await rm(path.join(runDir, "sandbox-receipts.ndjson"));
    await withResource(REDACTED_SANDBOX_ID, sandboxIdDigest(RAW));
    await cleanupRun(cwd, RUN);
    const file = path.join(runDir, "cleanup.json");
    const cleanup = JSON.parse(await readFile(file, "utf8")) as { resources: { id: string }[] };
    cleanup.resources[0]!.id = RAW;
    await writeFile(file, JSON.stringify(cleanup, null, 2));
    const result = await verifyRun(cwd, RUN);
    expect(result.shareSafety.status).toBe("local_only");
    expect((await rawIdReason())?.message).toContain("Raw sandbox ids appear in cleanup.json.");
  });

  it("names any other file that holds a receipt's id, such as review.md", async () => {
    await withResource(REDACTED_SANDBOX_ID, sandboxIdDigest(RAW));
    const review = path.join(runDir, "review.md");
    await writeFile(review, `${await readFile(review, "utf8")}\nSandbox ${RAW} reclaimed.\n`);
    const reason = await rawIdReason();
    expect(reason?.message).toContain("review.md");
    expect(reason?.message).not.toContain(RAW);
  });
});
