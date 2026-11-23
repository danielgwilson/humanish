import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { reclaimRunSandboxes } from "../../src/run/reclaim.js";
import { readRunIndex, RunIndexCache } from "../../src/run/run-index.js";
import { computeStats } from "../../src/run/stats.js";
import { listRuns } from "../../src/run/stored-runs.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";
import { writeFixtureRun } from "../helpers/run-fixtures.js";

// A remote run executes in a runner sandbox, and until its copy back its directory here holds only
// the runner's receipt and remote.json. Each surface that lists runs reads that record.

const STARTED = "2026-11-23T10:00:00.000Z";
const runPath = (runId: string) => path.join(".humanish", "runs", runId);

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-remote-runs-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/**
 * A fake E2B module whose kill answers as given and whose tag search lists nothing. No request
 * leaves this process.
 */
function fakeE2B(kill: (sandboxId: string) => Promise<boolean>): E2BDesktopModule {
  return {
    Sandbox: {
      async create() {
        throw new Error("no sandbox is created here");
      },
      kill,
      async getInfo(sandboxId: string) {
        return { sandboxId, state: "running" };
      },
      list() {
        let read = false;
        return {
          get hasNext() {
            return !read;
          },
          async nextItems() {
            read = true;
            return [];
          },
        };
      },
    },
  } as unknown as E2BDesktopModule;
}

/** `humanish reclaim --run`, against a fake E2B whose kill answers as given. */
function reclaimHere(runId: string, kill: (sandboxId: string) => Promise<boolean>, check = false) {
  return reclaimRunSandboxes(cwd, runId, {
    loadModule: async () => fakeE2B(kill),
    env: { E2B_API_KEY: "synthetic-e2b" },
    requestTimeoutMs: 1_000,
    check,
  });
}

/** What `humanish runs` prints for the project. */
async function runsOutput(): Promise<string> {
  const out: string[] = [];
  const program = createProgram({
    writeOut: (text) => out.push(text),
    writeErr: () => undefined,
    setExitCode: () => undefined,
  });
  await program.parseAsync(["node", "humanish", "runs", "--cwd", cwd], { from: "node" });
  return out.join("");
}

/** Reclaim stops the runner and leaves remote.json as it was. */
const reclaimedHere = (runId: string) => reclaimHere(runId, async () => true);

describe("humanish runs lists a remote run that is on its runner", () => {
  it("shows it as a live run that is running, from its remote record", async () => {
    await writeFixtureRun(
      cwd,
      { runId: "cua-remote", state: "remote", startedAt: STARTED },
      Date.now(),
    );

    expect((await listRuns(cwd)).runs).toEqual([
      {
        runId: "cua-remote",
        createdAt: STARTED,
        mode: "live",
        path: runPath("cua-remote"),
        display: { state: "running", label: "running", tone: "live" },
        livenessBasis: "remote",
      },
    ]);
  });

  it("prints it as a live run that is running, and names the command that follows it", async () => {
    await writeFixtureRun(
      cwd,
      { runId: "cua-remote", state: "remote", startedAt: STARTED },
      Date.now(),
    );

    const lines = (await runsOutput()).split("\n");

    expect(lines).toContainEqual(
      expect.stringMatching(
        /^- cua-remote live running \d+ \w+ 2026-11-23T10:00:00\.000Z \.humanish\/runs\/cua-remote$/,
      ),
    );
    expect(lines.slice(-3, -1)).toEqual([
      `1 run is on its runner. Follow it and copy it back with humanish observe --run cua-remote --cwd ${cwd}.`,
      expect.stringMatching(/^1 run, /),
    ]);
  });

  it("names the command once for several runs on their runners, and not for one past its deadline", async () => {
    for (const runId of ["cua-first", "cua-second"])
      await writeFixtureRun(cwd, { runId, state: "remote" }, Date.now());
    const deadline = new Date(Date.now() - 60_000).toISOString();
    await writeFixtureRun(cwd, { runId: "cua-expired", state: "remote", deadline }, Date.now());

    const lines = (await runsOutput()).split("\n");

    expect(lines.slice(-3, -1)).toEqual([
      `2 runs are on their runners. Follow one and copy it back with humanish observe --run <run id> --cwd ${cwd}.`,
      expect.stringMatching(/^3 runs, /),
    ]);
  });

  it("shows it as interrupted once its runner's deadline has passed", async () => {
    const deadline = new Date(Date.now() - 60_000).toISOString();
    await writeFixtureRun(cwd, { runId: "cua-expired", state: "remote", deadline }, Date.now());

    const [run] = (await listRuns(cwd)).runs;

    expect(run?.display).toEqual({ state: "interrupted", label: "interrupted", tone: "warn" });
    expect(run?.livenessBasis).toBe("remote");
  });

  it("shows it as interrupted once it was reclaimed here", async () => {
    await writeFixtureRun(cwd, { runId: "cua-reclaimed", state: "remote" }, Date.now());
    await reclaimedHere("cua-reclaimed");

    const [run] = (await listRuns(cwd)).runs;

    expect(run?.display).toEqual({ state: "interrupted", label: "interrupted", tone: "warn" });
    expect(run?.livenessBasis).toBe("remote");
  });

  it("lists a local run that left only receipts as it did before, with no display", async () => {
    await writeFixtureRun(cwd, { runId: "r-orphan", state: "orphan" }, Date.now());

    expect((await listRuns(cwd)).runs).toEqual([
      { runId: "r-orphan", createdAt: null, mode: null, path: runPath("r-orphan") },
    ]);
  });

  it("reads a run whose run.json has arrived by its own files, whatever remote.json says", async () => {
    // A copy that stopped partway leaves the record pending beside the run's small files.
    const runDir = await writeFixtureRun(cwd, { runId: "cua-partway", state: "finished" });
    await writeFile(
      path.join(runDir, "remote.json"),
      JSON.stringify({ schema: "humanish.remote-run.v1", provider: "e2b", copyPending: true }),
    );

    const [run] = (await listRuns(cwd)).runs;
    const [entry] = (await readRunIndex(cwd)).runs;

    expect([run?.display?.state, run?.livenessBasis]).toEqual(["passed", "status"]);
    expect([entry?.derivedFrom, entry?.liveness]).toEqual(["status", "finished"]);
  });
});

// The run index is what `humanish stats` and the TUI list runs from.
describe("the run index reads a remote run that is on its runner", () => {
  const NOW = Date.parse("2026-11-23T10:30:00.000Z");
  const DEADLINE = "2026-11-23T11:00:00.000Z";

  it("as a live run that is running, from its remote record", async () => {
    await writeFixtureRun(cwd, {
      runId: "cua-remote",
      state: "remote",
      startedAt: STARTED,
      deadline: DEADLINE,
    });

    expect((await readRunIndex(cwd, { nowMs: NOW })).runs).toEqual([
      {
        runId: "cua-remote",
        derivedFrom: "remote",
        liveness: "running",
        mode: "live",
        startedAt: STARTED,
      },
    ]);
  });

  it("as interrupted from its runner's deadline, and once it was reclaimed here", async () => {
    await writeFixtureRun(cwd, { runId: "cua-remote", state: "remote", deadline: DEADLINE });
    const cache = new RunIndexCache();

    const before = await readRunIndex(cwd, { nowMs: NOW, cache });
    const after = await readRunIndex(cwd, { nowMs: Date.parse(DEADLINE), cache });

    expect(before.runs.map((run) => run.liveness)).toEqual(["running"]);
    expect(after.runs.map((run) => run.liveness)).toEqual(["interrupted"]);

    await reclaimedHere("cua-remote");
    const reclaimed = await readRunIndex(cwd, { nowMs: NOW, cache });
    expect(reclaimed.runs.map((run) => [run.derivedFrom, run.liveness])).toEqual([
      ["remote", "interrupted"],
    ]);
  });

  it("reads a local run that left only receipts as it did before", async () => {
    await writeFixtureRun(cwd, { runId: "r-orphan", state: "orphan" });

    expect((await readRunIndex(cwd, { nowMs: NOW })).runs).toEqual([
      { runId: "r-orphan", derivedFrom: "directory", liveness: "interrupted" },
    ]);
  });

  it("is counted by stats as one live run that is running, and no interrupted outcome", async () => {
    await writeFixtureRun(cwd, { runId: "cua-remote", state: "remote", deadline: DEADLINE });

    const stats = await computeStats(cwd, { nowMs: NOW });
    if (!stats.ok) throw new Error(stats.error.message);

    expect(stats.totals).toMatchObject({ runs: 1, live: 1, running: 1 });
    expect(stats.totals.outcomes).toEqual({ running: 1 });
  });
});

// Reclaim writes its receipt before its first kill, so a receipt alone does not say the runner
// stopped. The run reads interrupted only when the receipt records every sandbox gone.
describe("a remote run reclaimed here", () => {
  async function surfaces() {
    const [run] = (await listRuns(cwd)).runs;
    const [entry] = (await readRunIndex(cwd)).runs;
    const stats = await computeStats(cwd);
    if (!stats.ok) throw new Error(stats.error.message);
    return {
      runs: [run?.runId, run?.display?.state, run?.livenessBasis],
      index: [entry?.runId, entry?.derivedFrom, entry?.liveness],
      outcomes: stats.totals.outcomes,
    };
  }

  it("reads interrupted once the reclaim records its runner gone", async () => {
    await writeFixtureRun(cwd, { runId: "cua-stopped", state: "remote" }, Date.now());
    expect((await reclaimHere("cua-stopped", async () => true)).outcomes).toMatchObject([
      { state: "killed" },
    ]);

    expect(await surfaces()).toEqual({
      runs: ["cua-stopped", "interrupted", "remote"],
      index: ["cua-stopped", "remote", "interrupted"],
      outcomes: { interrupted: 1 },
    });
  });

  it("reads running when the reclaim could not kill its runner", async () => {
    await writeFixtureRun(cwd, { runId: "cua-unreached", state: "remote" }, Date.now());
    const result = await reclaimHere("cua-unreached", async () => {
      throw new Error("network unreachable");
    });
    expect([result.state, result.outcomes.map((outcome) => outcome.state)]).toEqual([
      "unconfirmed",
      ["kill-failed"],
    ]);

    expect(await surfaces()).toEqual({
      runs: ["cua-unreached", "running", "remote"],
      index: ["cua-unreached", "remote", "running"],
      outcomes: { running: 1 },
    });
  });

  it("reads running after `reclaim --check`, which writes no receipt", async () => {
    await writeFixtureRun(cwd, { runId: "cua-checked", state: "remote" }, Date.now());
    await reclaimHere("cua-checked", async () => true, true);

    expect(await surfaces()).toEqual({
      runs: ["cua-checked", "running", "remote"],
      index: ["cua-checked", "remote", "running"],
      outcomes: { running: 1 },
    });
  });

  it("reads running beside a receipt that names another run or records no sandbox", async () => {
    const runDir = await writeFixtureRun(cwd, { runId: "cua-other", state: "remote" }, Date.now());
    for (const receipt of [
      { runId: "cua-elsewhere", state: "clean", outcomes: [{ sandboxId: "x", state: "killed" }] },
      { runId: "cua-other", state: "clean", outcomes: [] },
      "{ not json",
    ]) {
      await writeFile(
        path.join(runDir, "reclaim-receipt.json"),
        typeof receipt === "string" ? receipt : JSON.stringify(receipt),
      );
      expect((await surfaces()).runs).toEqual(["cua-other", "running", "remote"]);
    }
  });
});

// A final copy that stopped partway can leave the runner's status.json here without its run.json.
describe("a remote run whose status.json arrived before its run.json", () => {
  const runnerStatus = (runId: string, fields: Record<string, unknown>) => ({
    schema: "humanish.run-status.v1",
    runId,
    mode: "live",
    pid: 4242,
    startedAt: "2026-11-23T10:05:00.000Z",
    updatedAt: "2026-11-23T10:20:00.000Z",
    ...fields,
  });

  async function partway(runId: string, status: Record<string, unknown>, deadline?: string) {
    const runDir = await writeFixtureRun(
      cwd,
      { runId, state: "remote", ...(deadline === undefined ? {} : { deadline }) },
      Date.now(),
    );
    await writeFile(path.join(runDir, "status.json"), JSON.stringify(runnerStatus(runId, status)));
  }

  it("reads a finished status record as it would with no remote record", async () => {
    await partway("cua-done", { state: "finished", completedAt: "2026-11-23T10:20:00.000Z" });

    expect((await listRuns(cwd)).runs).toEqual([
      { runId: "cua-done", createdAt: null, mode: null, path: runPath("cua-done") },
    ]);
    expect((await readRunIndex(cwd)).runs).toMatchObject([
      { runId: "cua-done", derivedFrom: "status", liveness: "finished", mode: "live" },
    ]);
  });

  it("reads an interrupted status record by that record", async () => {
    await partway("cua-stopped", {
      state: "interrupted",
      signal: "SIGTERM",
      completedAt: "2026-11-23T10:20:00.000Z",
    });

    expect((await listRuns(cwd)).runs).toEqual([
      {
        runId: "cua-stopped",
        createdAt: "2026-11-23T10:05:00.000Z",
        mode: "live",
        path: runPath("cua-stopped"),
        display: { state: "interrupted", label: "interrupted", tone: "warn" },
        livenessBasis: "status",
      },
    ]);
    expect((await readRunIndex(cwd)).runs).toMatchObject([
      { runId: "cua-stopped", derivedFrom: "status", liveness: "interrupted", mode: "live" },
    ]);
  });

  it("reads a running status record, whose heartbeat stopped at the copy, by the remote record", async () => {
    await partway("cua-going", { state: "running" });

    const [run] = (await listRuns(cwd)).runs;
    const [entry] = (await readRunIndex(cwd)).runs;

    expect([run?.display?.state, run?.livenessBasis, run?.createdAt]).toEqual([
      "running",
      "remote",
      "2026-08-19T10:00:00.000Z",
    ]);
    expect([entry?.derivedFrom, entry?.liveness]).toEqual(["remote", "running"]);
  });
});

describe("a remote record written before startedAt", () => {
  it("lists its run with no start, or the start a running status record gives", async () => {
    const runDir = await writeFixtureRun(cwd, { runId: "cua-older", state: "remote" }, Date.now());
    const deadline = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(
      path.join(runDir, "remote.json"),
      JSON.stringify({
        schema: "humanish.remote-run.v1",
        provider: "e2b",
        deadline,
        copyPending: true,
      }),
    );
    expect((await listRuns(cwd)).runs.map((run) => [run.createdAt, run.livenessBasis])).toEqual([
      [null, "remote"],
    ]);

    await writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({
        schema: "humanish.run-status.v1",
        runId: "cua-older",
        state: "running",
        mode: "live",
        pid: 4242,
        startedAt: "2026-11-23T10:05:00.000Z",
        updatedAt: "2026-11-23T10:20:00.000Z",
      }),
    );
    expect((await listRuns(cwd)).runs.map((run) => [run.createdAt, run.livenessBasis])).toEqual([
      ["2026-11-23T10:05:00.000Z", "remote"],
    ]);
  });
});

describe("a remote.json this version cannot read", () => {
  it("lists its run as a run with no remote record, and never throws", async () => {
    const runDir = await writeFixtureRun(cwd, { runId: "cua-newer", state: "remote" }, Date.now());
    for (const text of [
      '{ "copyPending": tr',
      JSON.stringify({ schema: "humanish.remote-run.v2", copyPending: true }),
    ]) {
      await writeFile(path.join(runDir, "remote.json"), text);

      expect((await listRuns(cwd)).runs).toEqual([
        { runId: "cua-newer", createdAt: null, mode: null, path: runPath("cua-newer") },
      ]);
      expect((await readRunIndex(cwd)).runs).toEqual([
        { runId: "cua-newer", derivedFrom: "directory", liveness: "interrupted" },
      ]);
    }
  });
});
