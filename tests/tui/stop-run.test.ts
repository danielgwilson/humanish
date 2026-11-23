import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stopRun } from "../../src/tui/actions.js";
import { writeFixtureRun } from "../helpers/run-fixtures.js";

// The fixture's status record names pid 4242. No test here lets a signal reach a real process.
const PID = 4242;

describe("the TUI's Stop signals only a run whose heartbeat is fresh", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-tui-stop-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it("signals the process group of a run whose heartbeat is fresh", async () => {
    await writeFixtureRun(cwd, { runId: "r-live", state: "running" }, Date.now());
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await stopRun(cwd, "r-live");

    expect(result.ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(-PID, "SIGTERM");
  });

  it("sends no signal to the pid of a record whose heartbeat stopped", async () => {
    // The run list shows this run as interrupted and offers Reclaim, not Stop. Its pid may by now
    // belong to another process, whose whole group a signal would end.
    await writeFixtureRun(cwd, { runId: "r-stopped", state: "stale" }, Date.now());
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await stopRun(cwd, "r-stopped");

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Reclaim/);
    expect(kill).not.toHaveBeenCalled();
  });

  it("sends no signal to the pid of a record dated ahead of this machine's clock", async () => {
    // A run directory copied from a machine whose clock runs ahead: its pid names nothing here.
    const runDir = await writeFixtureRun(cwd, { runId: "r-ahead", state: "running" }, Date.now());
    const file = path.join(runDir, "status.json");
    const record = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    record.updatedAt = new Date(Date.now() + 3_600_000).toISOString();
    await writeFile(file, JSON.stringify(record));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = await stopRun(cwd, "r-ahead");

    expect(result.ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  });
});
