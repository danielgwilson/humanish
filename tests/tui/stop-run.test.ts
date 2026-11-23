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

  describe("a run that executes in a runner sandbox", () => {
    // Its pid, when a status record names one, belongs to the runner, never to this machine.
    const onRunner = (runId: string) =>
      `this run executes in a runner sandbox on E2B, so no process here was signalled. To stop it and keep its evidence, run \`humanish observe --run ${runId} --cwd ${cwd}\` and press Ctrl-C there once it says the run is running; \`humanish reclaim --run ${runId} --cwd ${cwd}\` stops its runner at once and loses what has not been copied back`;
    const record = (copyPending: boolean) =>
      JSON.stringify({
        schema: "humanish.remote-run.v1",
        provider: "e2b",
        route: "computer-use",
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
        ...(copyPending ? { copyPending: true } : {}),
      });

    it("sends no signal while its record is pending and no status record is here", async () => {
      await writeFixtureRun(cwd, { runId: "cua-remote", state: "remote" }, Date.now());
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      const result = await stopRun(cwd, "cua-remote");

      expect(result).toEqual({
        schema: "humanish.tui-action.v1",
        ok: false,
        message: onRunner("cua-remote"),
      });
      expect(kill).not.toHaveBeenCalled();
    });

    it("sends no signal to the pid in a fresh running status record beside a pending record", async () => {
      const runDir = await writeFixtureRun(
        cwd,
        { runId: "cua-partway", state: "running" },
        Date.now(),
      );
      await writeFile(path.join(runDir, "remote.json"), record(true));
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      const result = await stopRun(cwd, "cua-partway");

      expect(result.message).toBe(onRunner("cua-partway"));
      expect(kill).not.toHaveBeenCalled();
    });

    it("sends no signal to the pid in a fresh running status record beside a copied record", async () => {
      const runDir = await writeFixtureRun(
        cwd,
        { runId: "cua-copied", state: "running" },
        Date.now(),
      );
      await writeFile(path.join(runDir, "remote.json"), record(false));
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      const result = await stopRun(cwd, "cua-copied");

      expect(result).toEqual({
        schema: "humanish.tui-action.v1",
        ok: false,
        message:
          "this run's directory holds a remote.json, so it ran in a runner sandbox and no process on this machine is its own; no signal was sent",
      });
      expect(kill).not.toHaveBeenCalled();
    });

    it("keeps the message for a status record that says the run already stopped", async () => {
      const runDir = await writeFixtureRun(
        cwd,
        { runId: "cua-ended", state: "running" },
        Date.now(),
      );
      const file = path.join(runDir, "status.json");
      const status = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      await writeFile(file, JSON.stringify({ ...status, state: "interrupted", signal: "SIGTERM" }));
      await writeFile(path.join(runDir, "remote.json"), record(true));
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

      const result = await stopRun(cwd, "cua-ended");

      expect(result.message).toBe(
        "this run already stopped (SIGTERM); Reclaim releases any sandbox it left",
      );
      expect(kill).not.toHaveBeenCalled();
    });
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
