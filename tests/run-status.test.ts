import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RUN_STATUS_FILE,
  RUN_STATUS_SCHEMA,
  RUN_STATUS_STALE_MS,
  RUN_STATUS_TOUCH_MS,
  beginRunStatus,
  classifyRunStatus,
  inertRunStatus,
  inferLegacyLabId,
  isRunStatusRecord,
  withRunStatusScope,
  type RunStatusRecord
} from "../src/run-status.js";
import { prepareRunArtifactPaths } from "../src/run-paths.js";

describe("run status: identity + liveness on disk (#455)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-status-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const read = async (runId: string): Promise<RunStatusRecord> =>
    JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", runId, RUN_STATUS_FILE), "utf8")) as RunStatusRecord;

  /** Poll until `probe` returns a value, so a timing assertion never depends on scheduler luck. */
  async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 2_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting for the cadence to write");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("writes a running record with lab identity the moment a run starts", async () => {
    const runPaths = await prepareRunArtifactPaths(cwd, "run-a");
    const clock = { t: Date.parse("2026-08-19T10:00:00.000Z") };
    const status = beginRunStatus(runPaths, {
      runId: "run-a",
      mode: "live",
      lab: { id: "observer-live-check", path: ".humanish/labs/observer-live-check.yaml", origin: "ignored" },
      now: () => clock.t,
      pid: 4242,
      touchMs: 0
    });
    await status.touch();

    const record = await read("run-a");
    expect(record.schema).toBe(RUN_STATUS_SCHEMA);
    expect(record.state).toBe("running");
    expect(record.mode).toBe("live");
    expect(record.lab).toEqual({
      id: "observer-live-check",
      path: ".humanish/labs/observer-live-check.yaml",
      origin: "ignored"
    });
    expect(record.pid).toBe(4242);
    expect(record.startedAt).toBe("2026-08-19T10:00:00.000Z");
    expect(isRunStatusRecord(record)).toBe(true);
    // Public-safe by construction: no hostname, no user paths, nothing a share gate must strip.
    const raw = await readFile(path.join(cwd, ".humanish", "runs", "run-a", RUN_STATUS_FILE), "utf8");
    expect(raw).not.toMatch(/host/i);
    expect(raw).not.toContain(cwd);
  });

  it("touch moves updatedAt; finish records the outcome and is idempotent", async () => {
    const runPaths = await prepareRunArtifactPaths(cwd, "run-b");
    const clock = { t: Date.parse("2026-08-19T10:00:00.000Z") };
    const status = beginRunStatus(runPaths, { runId: "run-b", mode: "live", now: () => clock.t, touchMs: 0 });

    clock.t += 5_000;
    await status.touch();
    expect((await read("run-b")).updatedAt).toBe("2026-08-19T10:00:05.000Z");

    clock.t += 5_000;
    await status.finish({
      verdict: "pass",
      participants: { total: 1, reachedGoal: 1, reportedFriction: 0 },
      estimatedCostUsd: 0.34
    });
    const finished = await read("run-b");
    expect(finished.state).toBe("finished");
    expect(finished.completedAt).toBe("2026-08-19T10:00:10.000Z");
    expect(finished.outcome).toEqual({
      verdict: "pass",
      participants: { total: 1, reachedGoal: 1, reportedFriction: 0 },
      estimatedCostUsd: 0.34
    });

    // A second finish (a backend with several exit paths) must not rewrite the record, and a late
    // touch must never resurrect a finished run as running.
    clock.t += 5_000;
    await status.finish({ verdict: "fail" });
    await status.touch();
    const after = await read("run-b");
    expect(after.state).toBe("finished");
    expect(after.outcome?.verdict).toBe("pass");
    expect(after.completedAt).toBe("2026-08-19T10:00:10.000Z");
  });


  it("a run that returns without finalizing still stops claiming to be alive", async () => {
    // The defect this pins, found by CI on a real fail-closed path: the lab backends have 18 early
    // `return`s between opening a status record and finalizing it (bad subject, packing failure,
    // missing key). Each one ends the run and skips `finish()`. Before the scope, the cadence kept
    // ticking and the record kept saying `running`, so a listing surface showed a dead run as alive
    // for as long as the process lived — and a cleanup deleting the run directory raced a writer
    // that was still writing into it.
    const runPaths = await prepareRunArtifactPaths(cwd, "run-abandoned");
    const result = await withRunStatusScope(async () => {
      const status = beginRunStatus(runPaths, { runId: "run-abandoned", mode: "live", touchMs: 5 });
      await status.started;
      // The shape of every fail-closed exit: return an error result, never touch the handle again.
      return { ok: false as const, code: "HUMANISH_SUBJECT_INVALID" };
    });
    expect(result.ok).toBe(false);

    const record = await read("run-abandoned");
    // Finished, because control returned: the run IS over. And with NO outcome, because the scope
    // does not know one — an absent verdict is the honest report, not an invented pass.
    expect(record.state).toBe("finished");
    expect(record.completedAt).toBeDefined();
    expect(record.outcome).toBeUndefined();
    expect(classifyRunStatus(record, Date.now())).toBe("finished");

    // And the cadence is genuinely stopped: nothing writes into the run directory any more, which
    // is what let a concurrent cleanup fail with ENOTEMPTY.
    const settled = (await stat(path.join(cwd, ".humanish", "runs", "run-abandoned", RUN_STATUS_FILE))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await stat(path.join(cwd, ".humanish", "runs", "run-abandoned", RUN_STATUS_FILE))).mtimeMs).toBe(settled);
  });

  it("the scope never overwrites an outcome a backend already recorded", async () => {
    const runPaths = await prepareRunArtifactPaths(cwd, "run-proper");
    await withRunStatusScope(async () => {
      const status = beginRunStatus(runPaths, { runId: "run-proper", mode: "live", touchMs: 0 });
      await status.finish({ verdict: "pass", ok: true, participants: { total: 2, reachedGoal: 2 } });
    });
    const record = await read("run-proper");
    expect(record.state).toBe("finished");
    expect(record.outcome?.verdict).toBe("pass");
    expect(record.outcome?.participants?.total).toBe(2);
  });

  it("concurrent runs in one process each clean up only their own record", async () => {
    // Labs can run side by side in one process, so the scope is async-local rather than global:
    // one run returning must not finalize another run that is still going.
    const slowPaths = await prepareRunArtifactPaths(cwd, "run-slow");
    let slowStatus: ReturnType<typeof beginRunStatus> | undefined;
    // The slow run is held open by a gate the test opens AFTER asserting, so "still running"
    // is a fact about ordering. A sleep here made the assertion a race against wall-clock and
    // it lost on loaded CI runners (Node 24 job, 2026-08-31).
    let releaseSlow!: () => void;
    const slowHeld = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const slow = withRunStatusScope(async () => {
      slowStatus = beginRunStatus(slowPaths, { runId: "run-slow", mode: "live", touchMs: 0 });
      await slowStatus.started;
      await slowHeld;
      await slowStatus.finish({ verdict: "pass" });
    });

    const fastPaths = await prepareRunArtifactPaths(cwd, "run-fast");
    await withRunStatusScope(async () => {
      const status = beginRunStatus(fastPaths, { runId: "run-fast", mode: "live", touchMs: 0 });
      await status.started;
    });

    // The fast run finalized itself; the slow one is untouched and still running.
    expect((await read("run-fast")).state).toBe("finished");
    expect((await read("run-slow")).state).toBe("running");

    releaseSlow();
    await slow;
    expect((await read("run-slow")).outcome?.verdict).toBe("pass");
  });

  it("classifies liveness from the record: running, stale-means-interrupted, finished", () => {
    const at = (iso: string) => ({ state: "running" as const, updatedAt: iso });
    const now = Date.parse("2026-08-19T10:01:00.000Z");
    expect(classifyRunStatus(at("2026-08-19T10:00:58.000Z"), now)).toBe("running");
    // Exactly at the threshold is still alive; one millisecond past it is not.
    expect(classifyRunStatus(at(new Date(now - RUN_STATUS_STALE_MS).toISOString()), now)).toBe("running");
    expect(classifyRunStatus(at(new Date(now - RUN_STATUS_STALE_MS - 1).toISOString()), now)).toBe("interrupted");
    expect(classifyRunStatus({ state: "finished", updatedAt: "2026-08-19T09:00:00.000Z" }, now)).toBe("finished");
    // A record whose timestamp cannot be parsed is interrupted, never optimistically alive.
    expect(classifyRunStatus(at("not-a-date"), now)).toBe("interrupted");
    // The threshold gives three touch intervals of slack, so a hiccup never mislabels a live run.
    expect(RUN_STATUS_STALE_MS).toBe(RUN_STATUS_TOUCH_MS * 3);
  });

  it("the cadence refreshes updatedAt on its own, and never holds the process open", async () => {
    const runPaths = await prepareRunArtifactPaths(cwd, "run-c");
    const clock = { t: Date.parse("2026-08-19T10:00:00.000Z") };
    const status = beginRunStatus(runPaths, { runId: "run-c", mode: "live", now: () => clock.t, touchMs: 10 });
    try {
      // The initial write is fire-and-forget so starting a run never blocks on its own index;
      // `started` is how a caller that needs determinism waits for it.
      await status.started;
      const first = (await read("run-c")).updatedAt;
      clock.t += 60_000;

      // Poll rather than sleep a fixed span. The claim under test is "the cadence refreshes on its
      // own", not "it refreshes within 60ms of wall clock" — and on a loaded machine an interval
      // callback plus its async write can easily miss a fixed window, which made this the one
      // flaky test in the suite.
      const second = await waitFor(async () => {
        const value = (await read("run-c")).updatedAt;
        return value === first ? undefined : value;
      });
      expect(second).not.toBe(first);

      await status.stop();
      const afterStop = (await read("run-c")).updatedAt;
      clock.t += 60_000;
      // The negative half stays a fixed wait: there is nothing to poll for, and the assertion is
      // that several cadence intervals could have passed and none did.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((await read("run-c")).updatedAt).toBe(afterStop);
    } finally {
      // Always, even when an assertion above throws, and AWAITED: a cadence left running — or a
      // single write still in flight — writes into the run directory while afterEach is deleting
      // it, which surfaces as an unrelated ENOTEMPTY.
      await status.stop();
    }
  });

  it("a status write failure never breaks the run it describes", async () => {
    const runPaths = await prepareRunArtifactPaths(cwd, "run-d");
    const status = beginRunStatus(runPaths, { runId: "run-d", mode: "dry-run", touchMs: 0 });
    // Remove the run directory out from under it: the writes now fail, and every call must resolve.
    await rm(path.join(cwd, ".humanish", "runs", "run-d"), { recursive: true, force: true });
    await expect(status.touch()).resolves.toBeUndefined();
    await expect(status.finish({ verdict: "pass" })).resolves.toBeUndefined();
  });

  it("the record is one small file — the point is listing runs without parsing bundles", async () => {
    const runPaths = await prepareRunArtifactPaths(cwd, "run-e");
    const status = beginRunStatus(runPaths, {
      runId: "run-e",
      mode: "live",
      lab: { id: "x", path: "humanish/labs/x.yaml", origin: "committed" },
      touchMs: 0
    });
    await status.finish({ verdict: "pass", participants: { total: 2, reachedGoal: 2 }, estimatedCostUsd: 1.2 });
    const size = (await stat(path.join(cwd, ".humanish", "runs", "run-e", RUN_STATUS_FILE))).size;
    expect(size).toBeLessThan(600);
  });

  it("shape guard accepts additive fields and rejects wrong ones", () => {
    const base = {
      schema: RUN_STATUS_SCHEMA,
      runId: "r",
      state: "running",
      mode: "live",
      pid: 1,
      startedAt: "2026-08-19T10:00:00.000Z",
      updatedAt: "2026-08-19T10:00:00.000Z"
    };
    expect(isRunStatusRecord({ ...base, somethingNewLater: true })).toBe(true);
    expect(isRunStatusRecord({ ...base, state: "sleeping" })).toBe(false);
    expect(isRunStatusRecord({ ...base, schema: "humanish.run-status.v2" })).toBe(false);
    expect(isRunStatusRecord({ ...base, lab: { path: "x" } })).toBe(false);
    expect(isRunStatusRecord(null)).toBe(false);
  });

  it("the legacy bridge reads the old lab:<id> convention, colons included, and nothing else", () => {
    expect(inferLegacyLabId({ persona: { source: "lab:observer-live-check" } })).toBe("observer-live-check");
    // Ids may legitimately contain a colon (the meta lab is `oss:meta`).
    expect(inferLegacyLabId({ scenario: { source: "lab:oss:meta" } })).toBe("oss:meta");
    // A plain persona path is NOT a lab marker — those runs are honestly lab-less.
    expect(inferLegacyLabId({ persona: { source: "humanish/personas/synthetic-new-user.yaml" } })).toBeUndefined();
    expect(inferLegacyLabId({ persona: { source: "lab:" } })).toBeUndefined();
    expect(inferLegacyLabId({})).toBeUndefined();
  });

  it("the inert handle satisfies the interface for callers that cannot write", async () => {
    const inert = inertRunStatus();
    await expect(inert.touch()).resolves.toBeUndefined();
    await expect(inert.finish()).resolves.toBeUndefined();
    expect(() => inert.stop()).not.toThrow();
  });
});
