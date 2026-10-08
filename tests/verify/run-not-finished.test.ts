// verify's RUN_NOT_FINISHED warning: a killed run's in-progress bundle still verifies, and the
// warning and the result's `unfinished` say what verify saw, including whether anything records
// the run's sandboxes stopped. The run index decides liveness by the same rule, so both agree.

import { appendFile, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { readRunIndex } from "../../src/run/run-index.js";
import { RUN_STATUS_FILE, type RunStatusRecord } from "../../src/run/status.js";
import { verifyRun } from "../../src/verify/verify.js";

const RUN = "killed-run";
const TAIL =
  "Verify ok covers the integrity of what was written; it does not mean the run finished.";

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

/** Leave the run as a SIGKILL does: an in-progress bundle with no outcome and a `running` record. */
const kill = async (updatedAt: string) => {
  const { outcome: _bundleOutcome, ...bundle } = await readJson<RunBundle>("run.json");
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
    ...(result.unfinished === undefined ? {} : { unfinished: result.unfinished }),
  };
};
const indexLiveness = async () => (await readRunIndex(cwd)).runs[0]?.liveness;
const stopped = "2026-09-30T13:37:29.366Z";

describe("verify on a run that did not finish", () => {
  it("reads status.json for this warning only: the grades are the same when it contradicts the bundle or is gone", async () => {
    const graded = async () => {
      const { warnings, unfinished: _unfinished, ...result } = await verifyRun(cwd, RUN);
      return {
        result: {
          ...result,
          warnings: warnings.filter((warning) => !warning.startsWith("RUN_NOT_FINISHED")),
        },
        notFinished: warnings.some((warning) => warning.startsWith("RUN_NOT_FINISHED")),
      };
    };
    const asWritten = await graded();
    expect(asWritten.notFinished).toBe(false);

    const status = await readJson<RunStatusRecord>(RUN_STATUS_FILE);
    await writeJson(RUN_STATUS_FILE, { ...status, state: "running", updatedAt: stopped });
    const contradicted = await graded();
    expect(contradicted.notFinished).toBe(false);
    expect(contradicted.result).toEqual(asWritten.result);

    await rm(path.join(runDir, RUN_STATUS_FILE));
    expect((await graded()).result).toEqual(asWritten.result);
  });

  it("adds nothing to a finished run", async () => {
    await expect(notFinished()).resolves.toEqual({ ok: true, warnings: [] });
    await expect(indexLiveness()).resolves.toBe("finished");
  });

  // A reclaim receipt written before 0.110 names raw ids, as this one does; liveness digests them.
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

    // That receipt predates the tag search, so a sandbox no receipt named is still unknown.
    await expect(notFinished()).resolves.toEqual({
      ok: true,
      warnings: [
        `RUN_NOT_FINISHED: status.json state is running and its owner stopped updating it at ${stopped}; 1 of 1 streams are still running. Sandboxes unknown: reclaim-receipt.json records 2 of 2 sandboxes gone, but it records no finished search of E2B by this run's tags; \`humanish reclaim --run ${RUN}\` searches. ${TAIL}`,
      ],
      unfinished: { liveness: "interrupted", sandboxes: "unknown" },
    });
    await expect(indexLiveness()).resolves.toBe("interrupted");
  });

  it("matches a reclaim receipt that names its sandboxes by digest to the journal", async () => {
    await kill(stopped);
    await writeJson("reclaim-receipt.json", {
      schema: "humanish.reclaim-result.v1",
      at: "2026-10-03T13:38:14.809Z",
      runId: RUN,
      receiptCount: 2,
      outcomes: ["synthetic-sandbox-a", "synthetic-sandbox-b"].map((id, index) => ({
        sandboxId: REDACTED_SANDBOX_ID,
        sandboxIdDigest: sandboxIdDigest(id),
        laneId: `lane-0${index + 1}`,
        state: "killed",
      })),
    });

    const text = (await notFinished()).warnings.join("\n");
    expect(text).toMatch(/reclaim-receipt\.json records 2 of 2 sandboxes gone, but/);
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

    const { warnings, unfinished } = await notFinished();
    expect(unfinished).toEqual({ liveness: "interrupted", sandboxes: "unconfirmed" });
    expect(warnings[0]).toContain(
      "Sandboxes unconfirmed: reclaim-receipt.json records 0 of 1 sandboxes gone, and 1 journaled sandboxes are not in it;",
    );
  });

  it("points a killed, unreclaimed run at humanish reclaim", async () => {
    await kill(stopped);

    await expect(notFinished()).resolves.toEqual({
      ok: true,
      warnings: [
        `RUN_NOT_FINISHED: status.json state is running and its owner stopped updating it at ${stopped}; 1 of 1 streams are still running. Sandboxes unknown: it has no reclaim-receipt.json and journaled 2 sandboxes; \`humanish reclaim --run ${RUN}\` stops those and searches E2B by this run's tags for any whose id never reached a receipt. ${TAIL}`,
      ],
      unfinished: { liveness: "interrupted", sandboxes: "unknown" },
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

  it("reports the bundle interruption even when its status record is fresh", async () => {
    await kill(new Date().toISOString());
    const bundle = await readJson<RunBundle>("run.json");
    bundle.outcome = { state: "interrupted", ok: false, signal: "SIGTERM", at: stopped };
    await writeJson("run.json", bundle);
    const { warnings, unfinished } = await notFinished();
    expect(unfinished?.liveness).toBe("interrupted");
    expect(warnings[0]).toContain(`run.json records interruption by SIGTERM at ${stopped}`);
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

// Whether anything records that the run's sandboxes stopped, which leads verify's one-line output.
describe("verify's sandbox state for a run that did not finish", () => {
  it("calls the sandboxes clean only when the reclaim receipt records a finished tag search", async () => {
    await kill(stopped);
    await writeJson("reclaim-receipt.json", {
      schema: "humanish.reclaim-result.v1",
      at: "2026-10-04T13:38:14.809Z",
      runId: RUN,
      state: "clean",
      receiptCount: 2,
      outcomes: ["synthetic-sandbox-a", "synthetic-sandbox-b"].map((id, index) => ({
        sandboxId: REDACTED_SANDBOX_ID,
        sandboxIdDigest: sandboxIdDigest(id),
        laneId: `lane-0${index + 1}`,
        source: "receipt",
        state: "killed",
      })),
    });
    const result = await notFinished();
    expect(result.unfinished).toEqual({ liveness: "interrupted", sandboxes: "clean" });
    expect(result.warnings[0]).toContain("Sandboxes clean: reclaim-receipt.json records 2 of 2");
  });

  it("calls the sandboxes unconfirmed when the journal is over the read limit", async () => {
    await kill(stopped);
    await writeJson("reclaim-receipt.json", {
      schema: "humanish.reclaim-result.v1",
      at: "2026-10-04T13:38:14.809Z",
      runId: RUN,
      state: "clean",
      receiptCount: 2,
      outcomes: ["synthetic-sandbox-a", "synthetic-sandbox-b"].map((id, index) => ({
        sandboxId: REDACTED_SANDBOX_ID,
        sandboxIdDigest: sandboxIdDigest(id),
        laneId: `lane-0${index + 1}`,
        source: "receipt",
        state: "killed",
      })),
    });
    // A third sandbox the receipt does not cover, then whitespace past the 32 MiB limit.
    await appendFile(
      path.join(runDir, "sandbox-receipts.ndjson"),
      `${JSON.stringify({ sandboxId: "synthetic-sandbox-c", laneId: "lane-03", provider: "e2b" })}\n${" ".repeat(32 * 1024 * 1024)}`,
    );

    const result = await notFinished();

    expect(result.unfinished).toEqual({ liveness: "interrupted", sandboxes: "unconfirmed" });
    expect(result.warnings[0]).toContain(
      "Sandboxes unconfirmed: sandbox-receipts.ndjson is larger than 33554432 bytes",
    );
  });

  it("calls the sandboxes unknown when nothing journaled one and no reclaim searched", async () => {
    await kill(stopped);
    await rm(path.join(runDir, "sandbox-receipts.ndjson"));
    const result = await notFinished();
    expect(result.unfinished).toEqual({ liveness: "interrupted", sandboxes: "unknown" });
    expect(result.warnings[0]).toContain("Sandboxes unknown: it has no reclaim-receipt.json");
  });
});
