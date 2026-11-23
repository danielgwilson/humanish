import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runLiveness } from "../../src/run/liveness.js";
import { RUN_STATUS_SCHEMA, RUN_STATUS_STALE_MS } from "../../src/run/status.js";

const NOW = Date.parse("2026-08-19T10:01:00.000Z");
const RUN_ID = "run-a";

function status(overrides: Record<string, unknown> = {}) {
  return {
    schema: RUN_STATUS_SCHEMA,
    runId: RUN_ID,
    state: "running",
    mode: "live",
    pid: 4242,
    startedAt: "2026-08-19T10:00:00.000Z",
    updatedAt: "2026-08-19T10:00:58.000Z",
    ...overrides,
  };
}

const running = { simulations: [{ status: "running" }] };
const ended = { simulations: [{ status: "passed" }] };

describe("a run's liveness and the basis for it", () => {
  it("reads run.json's outcome first, whatever status.json says", () => {
    const finished = {
      state: "finished" as const,
      ok: true,
      execution: { succeeded: true, failures: [] },
    };
    expect(runLiveness(RUN_ID, status(), { ...running, outcome: finished }, NOW)).toEqual({
      liveness: "finished",
      basis: "outcome",
      outcome: finished,
    });
    const interrupted = {
      state: "interrupted" as const,
      ok: false as const,
      signal: "SIGINT" as const,
      at: "2026-08-19T10:00:30.000Z",
    };
    expect(runLiveness(RUN_ID, undefined, { ...ended, outcome: interrupted }, NOW)).toEqual({
      liveness: "interrupted",
      basis: "outcome",
      outcome: interrupted,
    });
  });

  it("reads a state the status record's own process or reclaim wrote as recorded", () => {
    const finished = status({ state: "finished", completedAt: "2026-08-19T10:00:58.000Z" });
    expect(runLiveness(RUN_ID, finished, running, NOW)).toEqual({
      liveness: "finished",
      basis: "status",
      record: finished,
    });
    const interrupted = status({ state: "interrupted", reason: "reclaimed" });
    expect(runLiveness(RUN_ID, interrupted, running, NOW)).toMatchObject({
      liveness: "interrupted",
      basis: "status",
    });
  });

  it("reads a running record by its heartbeat: fresh is running, stale is interrupted", () => {
    expect(runLiveness(RUN_ID, status(), running, NOW)).toMatchObject({
      liveness: "running",
      basis: "heartbeat",
    });
    const stale = status({ updatedAt: new Date(NOW - RUN_STATUS_STALE_MS - 1).toISOString() });
    expect(runLiveness(RUN_ID, stale, running, NOW)).toEqual({
      liveness: "interrupted",
      basis: "stale-heartbeat",
      record: stale,
    });
    // A heartbeat that cannot be read is no heartbeat, and neither is one dated an hour ahead:
    // a record copied from a machine with another clock says nothing about a process here.
    for (const updatedAt of ["not-a-date", "2026-08-19T11:01:00.000Z"]) {
      expect(runLiveness(RUN_ID, status({ updatedAt }), running, NOW)).toMatchObject({
        liveness: "interrupted",
        basis: "stale-heartbeat",
      });
    }
  });

  it("reads a bundle whose participants have not all ended as interrupted, whatever they wait on", () => {
    // A run stopped while its remaining participants were queued for a later start, or while a
    // desktop was starting, did not finish any more than one stopped mid-session did.
    for (const waiting of ["queued", "preparing", "running"]) {
      const bundle = { simulations: [{ status: "passed" }, { status: waiting }] };
      expect(runLiveness(RUN_ID, undefined, bundle, NOW)).toEqual({
        liveness: "interrupted",
        basis: "bundle",
      });
    }
    // A dry run's participants are contract_proof_only, which is how a dry run ends.
    const dryRun = { simulations: [{ status: "contract_proof_only" }] };
    expect(runLiveness(RUN_ID, undefined, dryRun, NOW).liveness).toBe("finished");
  });

  it("falls back to the bundle's participants when no status record names the run", () => {
    for (const unusable of [
      undefined,
      null,
      "{",
      status({ runId: "another-run" }),
      { state: "running" },
    ]) {
      expect(runLiveness(RUN_ID, unusable, running, NOW)).toEqual({
        liveness: "interrupted",
        basis: "bundle",
      });
      expect(runLiveness(RUN_ID, unusable, ended, NOW)).toEqual({
        liveness: "finished",
        basis: "bundle",
      });
    }
  });
});

describe("the liveness of a remote run whose run.json is not here", () => {
  const DEADLINE = "2026-08-19T11:00:00.000Z";
  const pending = {
    state: "pending" as const,
    provider: "e2b" as const,
    route: "computer-use",
    deadline: DEADLINE,
    startedAt: "2026-08-19T10:00:00.000Z",
  };
  const onRunner = { record: pending, reclaimed: false };

  it("reads a run on its runner as running until the runner's deadline, and interrupted from it", () => {
    expect(runLiveness(RUN_ID, undefined, {}, NOW, onRunner)).toEqual({
      basis: "remote",
      liveness: "running",
      remote: pending,
    });
    expect(runLiveness(RUN_ID, undefined, {}, Date.parse(DEADLINE), onRunner)).toEqual({
      basis: "remote",
      liveness: "interrupted",
      remote: pending,
    });
  });

  it("reads a pending record with no deadline as running", () => {
    const record = { state: "pending" as const, provider: "modal" as const };
    expect(runLiveness(RUN_ID, undefined, {}, NOW, { record, reclaimed: false })).toEqual({
      basis: "remote",
      liveness: "running",
      remote: record,
    });
  });

  it("reads a run reclaimed here as interrupted before its deadline", () => {
    expect(runLiveness(RUN_ID, undefined, {}, NOW, { record: pending, reclaimed: true })).toEqual({
      basis: "remote",
      liveness: "interrupted",
      remote: pending,
    });
  });

  it("reads run.json's outcome over the record, and the record over a status record or a bundle", () => {
    const finished = {
      state: "finished" as const,
      ok: true,
      execution: { succeeded: true, failures: [] },
    };
    expect(runLiveness(RUN_ID, undefined, { outcome: finished }, NOW, onRunner)).toMatchObject({
      basis: "outcome",
      liveness: "finished",
    });
    // A status.json copied from the runner holds the runner's pid and a heartbeat that stopped
    // when it was copied.
    const copied = status({ updatedAt: "2026-08-19T09:00:00.000Z" });
    for (const record of [copied, status(), status({ state: "interrupted" })])
      expect(runLiveness(RUN_ID, record, {}, NOW, onRunner)).toMatchObject({
        basis: "remote",
        liveness: "running",
      });
    expect(runLiveness(RUN_ID, undefined, ended, NOW, onRunner)).toMatchObject({
      basis: "remote",
      liveness: "running",
    });
  });
});

// Decision 0005: a state that more than one surface shows has one reader. For a run's liveness
// that holds only while no other module compares a heartbeat to the stale window itself. This
// catches a copy of the comparison that names the constant, in production code.
describe("the stale window of a run's heartbeat", () => {
  it("is read only by src/run/status.ts", async () => {
    const readers: string[] = [];
    for (const root of ["src", path.join("tui", "src"), "observer"]) {
      const files = (await readdir(root, { recursive: true })).filter(
        (file) =>
          /\.tsx?$/.test(file) &&
          !file.split(path.sep).some((part) => part === "node_modules" || part === "tests"),
      );
      for (const file of files) {
        // Comment lines name the constant without reading it.
        const code = (await readFile(path.join(root, file), "utf8"))
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
          .join("\n");
        if (/\bRUN_STATUS_STALE_MS\b/.test(code)) readers.push(path.join(root, file));
      }
    }
    expect(readers).toEqual([path.join("src", "run", "status.ts")]);
  });
});
