// verify's RUN_NOT_FINISHED warning: a killed run's in-progress bundle still verifies, and the
// warning says what verify saw. The run index decides liveness by the same rule, so both agree.

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { readRunIndex } from "../../src/run/run-index.js";
import { RUN_STATUS_FILE, type RunStatusRecord } from "../../src/run/status.js";
import { verifyRun } from "../../src/run/verify.js";

const RUN = "killed-run";
const TAIL =
  "Verify ok covers the integrity of what was written; it does not mean the run finished.";

describe("verify on a run that did not finish", () => {
  let cwd: string;
  let runDir: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-run-not-finished-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: RUN });
    runDir = path.join(cwd, ".humanish", "runs", RUN);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const readJson = async <T>(name: string): Promise<T> =>
    JSON.parse(await readFile(path.join(runDir, name), "utf8")) as T;
  const writeJson = (name: string, value: unknown) =>
    writeFile(path.join(runDir, name), `${JSON.stringify(value, null, 2)}\n`);

  /** Leave the run as a SIGKILL does: an in-progress bundle and a `running` record. */
  const kill = async (updatedAt: string) => {
    const bundle = await readJson<RunBundle>("run.json");
    for (const stream of bundle.streams) stream.status = "running";
    for (const simulation of bundle.simulations) simulation.status = "running";
    await writeJson("run.json", bundle);
    const {
      completedAt: _completedAt,
      outcome: _outcome,
      ...status
    } = await readJson<RunStatusRecord>(RUN_STATUS_FILE);
    await writeJson(RUN_STATUS_FILE, { ...status, state: "running", updatedAt });
    await writeFile(
      path.join(runDir, "sandbox-receipts.ndjson"),
      ["synthetic-sandbox-a", "synthetic-sandbox-b"]
        .map((sandboxId, index) =>
          JSON.stringify({ sandboxId, laneId: `lane-0${index + 1}`, provider: "e2b" }),
        )
        .join("\n") + "\n",
    );
  };
  const notFinished = async () => {
    const result = await verifyRun(cwd, RUN);
    return {
      ok: result.ok,
      warnings: result.warnings.filter((warning) => warning.startsWith("RUN_NOT_FINISHED")),
    };
  };
  const indexLiveness = async () => (await readRunIndex(cwd)).runs[0]?.liveness;
  const stopped = "2026-09-30T13:37:29.366Z";

  it("adds nothing to a finished run", async () => {
    await expect(notFinished()).resolves.toEqual({ ok: true, warnings: [] });
    await expect(indexLiveness()).resolves.toBe("finished");
  });

  it("names the stale record, the streams and the reclaim receipt of a killed, reclaimed run", async () => {
    await kill(stopped);
    await writeJson("reclaim-receipt.json", {
      schema: "humanish.reclaim-result.v1",
      at: "2026-09-30T13:38:14.809Z",
      runId: RUN,
      receiptCount: 2,
      outcomes: [
        { sandboxId: "synthetic-sandbox-a", laneId: "lane-01", state: "killed" },
        { sandboxId: "synthetic-sandbox-b", laneId: "lane-02", state: "already-gone" },
      ],
    });

    await expect(notFinished()).resolves.toEqual({
      ok: true,
      warnings: [
        `RUN_NOT_FINISHED: status.json state is running and its owner stopped updating it at ${stopped}; 1 of 1 streams are still running. reclaim-receipt.json records 2 of 2 sandboxes gone. ${TAIL}`,
      ],
    });
    await expect(indexLiveness()).resolves.toBe("interrupted");
  });

  it("says which journaled sandboxes a reclaim receipt did not cover", async () => {
    await kill(stopped);
    await writeJson("reclaim-receipt.json", {
      schema: "humanish.reclaim-result.v1",
      at: "2026-09-30T13:38:14.809Z",
      runId: RUN,
      receiptCount: 1,
      outcomes: [{ sandboxId: "synthetic-sandbox-a", laneId: "lane-01", state: "kill-failed" }],
    });

    const { warnings } = await notFinished();
    expect(warnings[0]).toContain(
      "reclaim-receipt.json records 0 of 1 sandboxes gone, and 1 journaled sandboxes are not in it.",
    );
  });

  it("points a killed, unreclaimed run at humanish reclaim", async () => {
    await kill(stopped);

    await expect(notFinished()).resolves.toEqual({
      ok: true,
      warnings: [
        `RUN_NOT_FINISHED: status.json state is running and its owner stopped updating it at ${stopped}; 1 of 1 streams are still running. It has no reclaim-receipt.json; \`humanish reclaim --run ${RUN}\` stops the 2 sandboxes it journaled. ${TAIL}`,
      ],
    });
    await expect(indexLiveness()).resolves.toBe("interrupted");
  });

  it("says a run with a fresh record may still be writing", async () => {
    const now = new Date().toISOString();
    await kill(now);

    const { warnings } = await notFinished();
    expect(warnings[0]).toContain(
      `status.json state is running and its owner updated it at ${now}, so the run may still be writing`,
    );
    await expect(indexLiveness()).resolves.toBe("running");
  });

  it("falls back to the bundle when the run has no status record", async () => {
    await kill(stopped);
    await rm(path.join(runDir, RUN_STATUS_FILE));

    const { warnings } = await notFinished();
    expect(warnings[0]).toMatch(
      /^RUN_NOT_FINISHED: the run has no usable status\.json and 1 of 1 simulations are still running; 1 of 1 streams are still running\. /,
    );
    await expect(indexLiveness()).resolves.toBe("interrupted");
  });
});
