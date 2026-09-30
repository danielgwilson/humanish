import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { runScope, type RunScope } from "../../src/run/run.js";
import {
  RUN_STATUS_FILE,
  RUN_STATUS_SCHEMA,
  RUN_STATUS_STALE_MS,
  RUN_STATUS_TOUCH_MS,
  classifyRunStatus,
  inferLegacyLabId,
  isRunStatusRecord,
  runStatusOutcome,
  type RunLabProvenance,
  type RunStatusRecord,
} from "../../src/run/status.js";

describe("run status: identity + liveness on disk (#455)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-status-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(cwd, { recursive: true, force: true });
  });

  const statusPath = (runId: string): string =>
    path.join(cwd, ".humanish", "runs", runId, RUN_STATUS_FILE);
  const read = async (runId: string): Promise<RunStatusRecord> =>
    JSON.parse(await readFile(statusPath(runId), "utf8")) as RunStatusRecord;

  const lab: RunLabProvenance = {
    id: "observer-live-check",
    path: ".humanish/labs/observer-live-check.yaml",
    origin: "ignored",
  };

  async function startLive(scope: RunScope, runId: string, withLab?: RunLabProvenance) {
    const started = await scope.startRun({
      cwd,
      runId,
      mintRunId: () => runId,
      mode: "live",
      renderReview: (bundle) => `# Review ${bundle.runId}\n`,
      ...(withLab === undefined ? {} : { lab: withLab }),
    });
    if (!started.ok) throw new Error(started.message);
    return started.run;
  }

  /** The synthetic preview of the same project, relabeled as a live bundle for `runId`. */
  async function bundleFor(runId: string): Promise<RunBundle> {
    const templateId = `${runId}-template`;
    const preview = await runDryRun({ cwd, dryRun: true, runId: templateId });
    if (!preview.ok) throw new Error(preview.error?.message ?? "the preview template failed");
    const template = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", templateId, "run.json"), "utf8"),
    ) as RunBundle;
    return {
      ...template,
      runId,
      mode: "live",
      artifactRoot: path.join(".humanish", "runs", runId),
    };
  }

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

  it("writes a running record with lab identity before startRun returns", async () => {
    await runScope(async (scope) => {
      await startLive(scope, "run-a", lab);

      const record = await read("run-a");
      expect(record.schema).toBe(RUN_STATUS_SCHEMA);
      expect(record.state).toBe("running");
      expect(record.mode).toBe("live");
      expect(record.lab).toEqual(lab);
      expect(record.pid).toBe(process.pid);
      expect(record.updatedAt).toBe(record.startedAt);
      expect(isRunStatusRecord(record)).toBe(true);
      // Public-safe by construction: no hostname, no user paths, nothing a share gate must strip.
      const raw = await readFile(statusPath("run-a"), "utf8");
      expect(raw).not.toMatch(/host/i);
      expect(raw).not.toContain(cwd);
    });
  });

  it("the cadence refreshes updatedAt while the run lives, and finish ends it", async () => {
    const bundle = await bundleFor("run-b");
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "Date"],
      now: Date.parse("2026-08-19T10:00:00.000Z"),
    });
    await runScope(async (scope) => {
      const run = await startLive(scope, "run-b");
      expect((await read("run-b")).updatedAt).toBe("2026-08-19T10:00:00.000Z");

      vi.advanceTimersByTime(RUN_STATUS_TOUCH_MS);
      const touched = "2026-08-19T10:00:05.000Z";
      await waitFor(async () => ((await read("run-b")).updatedAt === touched ? true : undefined));

      await run.finish(bundle);
      const finished = await read("run-b");
      expect(finished.state).toBe("finished");
      expect(finished.completedAt).toBe(touched);
      expect(finished.outcome).toEqual(runStatusOutcome(bundle));

      // A tick after finish would resurrect the run as running; the interval is gone instead.
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(RUN_STATUS_TOUCH_MS * 3);
      expect(await read("run-b")).toEqual(finished);
    });
  });

  it("classifies liveness from the record: running, stale-means-interrupted, finished", () => {
    const at = (iso: string) => ({ state: "running" as const, updatedAt: iso });
    const now = Date.parse("2026-08-19T10:01:00.000Z");
    expect(classifyRunStatus(at("2026-08-19T10:00:58.000Z"), now)).toBe("running");
    // Exactly at the threshold is still alive; one millisecond past it is not.
    expect(classifyRunStatus(at(new Date(now - RUN_STATUS_STALE_MS).toISOString()), now)).toBe(
      "running",
    );
    expect(classifyRunStatus(at(new Date(now - RUN_STATUS_STALE_MS - 1).toISOString()), now)).toBe(
      "interrupted",
    );
    expect(
      classifyRunStatus({ state: "finished", updatedAt: "2026-08-19T09:00:00.000Z" }, now),
    ).toBe("finished");
    // A record whose timestamp cannot be parsed is interrupted, never optimistically alive.
    expect(classifyRunStatus(at("not-a-date"), now)).toBe("interrupted");
    // The threshold gives three touch intervals of slack, so a hiccup never mislabels a live run.
    expect(RUN_STATUS_STALE_MS).toBe(RUN_STATUS_TOUCH_MS * 3);
  });

  it("a status write failure never breaks the run it describes", async () => {
    const bundle = await bundleFor("run-d");
    const { finished } = await runScope(async (scope) => {
      const run = await startLive(scope, "run-d");
      // A directory where the record goes makes every later status write fail.
      await rm(statusPath("run-d"));
      await mkdir(path.join(statusPath("run-d"), "blocker"), { recursive: true });
      await run.finish(bundle);
    });
    expect(finished?.runId).toBe("run-d");
    const published = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", "run-d", "run.json"), "utf8"),
    ) as RunBundle;
    expect(published.runId).toBe("run-d");
    expect((await stat(statusPath("run-d"))).isDirectory()).toBe(true);
  });

  it("the record is one small file — the point is listing runs without parsing bundles", async () => {
    const bundle = await bundleFor("run-e");
    await runScope(async (scope) => {
      await (await startLive(scope, "run-e", lab)).finish(bundle);
    });
    expect((await read("run-e")).state).toBe("finished");
    expect((await stat(statusPath("run-e"))).size).toBeLessThan(600);
  });

  it("shape guard accepts additive fields and rejects wrong ones", () => {
    const base = {
      schema: RUN_STATUS_SCHEMA,
      runId: "r",
      state: "running",
      mode: "live",
      pid: 1,
      startedAt: "2026-08-19T10:00:00.000Z",
      updatedAt: "2026-08-19T10:00:00.000Z",
    };
    expect(isRunStatusRecord({ ...base, somethingNewLater: true })).toBe(true);
    expect(isRunStatusRecord({ ...base, state: "sleeping" })).toBe(false);
    expect(isRunStatusRecord({ ...base, schema: "humanish.run-status.v2" })).toBe(false);
    expect(isRunStatusRecord({ ...base, lab: { path: "x" } })).toBe(false);
    expect(isRunStatusRecord(null)).toBe(false);
  });

  it("the legacy bridge reads the old lab:<id> convention, colons included, and nothing else", () => {
    expect(inferLegacyLabId({ persona: { source: "lab:observer-live-check" } })).toBe(
      "observer-live-check",
    );
    // Ids may legitimately contain a colon (the removed OSS meta-lab wrote `oss:meta`).
    expect(inferLegacyLabId({ scenario: { source: "lab:oss:meta" } })).toBe("oss:meta");
    // A plain persona path is NOT a lab marker — those runs are honestly lab-less.
    expect(
      inferLegacyLabId({ persona: { source: "humanish/personas/synthetic-new-user.yaml" } }),
    ).toBeUndefined();
    expect(inferLegacyLabId({ persona: { source: "lab:" } })).toBeUndefined();
    expect(inferLegacyLabId({})).toBeUndefined();
  });
});
