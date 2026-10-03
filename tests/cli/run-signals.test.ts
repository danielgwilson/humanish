import { REDACTED_SANDBOX_ID, sandboxIdDigest } from "../../src/evidence/redaction.js";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cliAnalysisOptions } from "../../src/cli/commands/analysis-signals.js";
import {
  beginRunSignalPhase,
  handOverRunSignals,
  onRunShutdown,
} from "../../src/cli/commands/run-signals.js";
import { registerActiveRun } from "../../src/run/active-runs.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { prepareRunArtifactPaths } from "../../src/run/paths.js";
import { RECLAIM_RECEIPT_ARTIFACT } from "../../src/run/reclaim.js";
import { appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import type { RunInterruptSignal } from "../../src/run/status.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

// The run command's handler: the first signal marks the run interrupted, reclaims the sandboxes
// its receipts name and exits 128+n; a second exits at once; analysis takes the signals over.
let cwd: string;
let target: EventEmitter;
let cleanups: Array<() => void>;
const RUN = "cua-2026-10-01T00-00-00-000Z-5191a1ed";

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-signals-"));
  target = new EventEmitter();
  cleanups = [];
  expect((await runDryRun({ cwd, dryRun: true, runId: RUN })).ok).toBe(true);
  const runPaths = await resolveRunPath(cwd, RUN);
  if (!runPaths) throw new Error("dry run left no run");
  await appendSandboxReceipt(runPaths, { at: "t1", laneId: "lane-01", sandboxId: "fake-sb-1" });
});
afterEach(async () => {
  for (const cleanup of cleanups) cleanup();
  await rm(cwd, { recursive: true, force: true });
});

async function setup(options: {
  runId?: string;
  interrupted?: boolean;
  interrupt?: () => Promise<boolean>;
  kill?: (sandboxId: string) => Promise<boolean>;
  deadlineMs?: number;
}) {
  const runId = options.runId ?? RUN;
  const interrupt = vi.fn(
    async (_signal: RunInterruptSignal) =>
      (await options.interrupt?.()) ?? options.interrupted ?? true,
  );
  const paths = await prepareRunArtifactPaths(cwd, runId);
  cleanups.push(registerActiveRun({ cwd, runId, paths, status: { interrupt } }));
  const killed: string[] = [];
  const module = {
    Sandbox: {
      create: async () => {
        throw new Error("reclaim never creates sandboxes");
      },
      kill: async (sandboxId: string) => {
        killed.push(sandboxId);
        return (options.kill ?? (async () => true))(sandboxId);
      },
    },
  } as unknown as E2BDesktopModule;
  const exit = vi.fn();
  let stderr = "";
  const phase = beginRunSignalPhase(
    { writeErr: (text) => (stderr += text) },
    {
      signalTarget: target,
      exit,
      reclaim: { loadModule: async () => module },
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    },
  );
  cleanups.push(phase.end);
  return { interrupt, killed, exit, phase, stderr: () => stderr };
}

describe("the run command's signal handler", () => {
  it("marks the run interrupted, reclaims its receipts and exits 128+n", async () => {
    const run = await setup({});
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(run.interrupt).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(run.killed).toEqual(["fake-sb-1"]);
    const receipt = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", RUN, RECLAIM_RECEIPT_ARTIFACT), "utf8"),
    ) as { outcomes: unknown[] };
    // The receipt names the sandbox by digest; the raw id stays in sandbox-receipts.ndjson.
    expect(receipt.outcomes).toEqual([
      {
        sandboxId: REDACTED_SANDBOX_ID,
        sandboxIdDigest: sandboxIdDigest("fake-sb-1"),
        laneId: "lane-01",
        state: "killed",
      },
    ]);
    expect(run.stderr()).toBe(
      `humanish: SIGTERM: run ${RUN} marked interrupted; sandboxes: 1 killed.\n`,
    );
  });

  it("exits at once on a second signal while reclaim is still waiting", async () => {
    const run = await setup({
      kill: () => new Promise<boolean>(() => undefined),
      deadlineMs: 2_000,
    });
    target.emit("SIGINT");
    await vi.waitFor(() => expect(run.killed).toEqual(["fake-sb-1"]));
    expect(run.exit).not.toHaveBeenCalled();
    target.emit("SIGINT");
    expect(run.exit).toHaveBeenCalledExactlyOnceWith(130);
  });

  it("exits after the deadline and names the reclaim command", async () => {
    const run = await setup({ kill: () => new Promise<boolean>(() => undefined), deadlineMs: 50 });
    target.emit("SIGHUP");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(129));
    expect(run.stderr()).toContain(`run \`humanish reclaim --run ${RUN}\``);
  });

  it("leaves a run that had already finished to its route", async () => {
    const run = await setup({ interrupted: false });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(run.killed).toEqual([]);
    expect(run.stderr()).toBe("");
  });

  it("takes no signal after end", async () => {
    const run = await setup({});
    run.phase.end();
    expect(target.listenerCount("SIGTERM")).toBe(0);
    target.emit("SIGTERM");
    expect(run.exit).not.toHaveBeenCalled();
  });
});

// Shutdown edges: aliases, stalled writes, the run returning or analysis starting mid-shutdown.
describe("the run command's signal handler at shutdown edges", () => {
  it("reclaims the run it registered even when its id is an alias", async () => {
    // A run named `latest`, then another run that moves the latest pointer to itself.
    expect((await runDryRun({ cwd, dryRun: true, runId: "latest" })).ok).toBe(true);
    const named = await prepareRunArtifactPaths(cwd, "latest");
    await appendSandboxReceipt(named, { at: "t1", laneId: "lane-01", sandboxId: "fake-sb-named" });
    const other = "cua-2026-10-01T00-00-01-000Z-0be70a1d";
    expect((await runDryRun({ cwd, dryRun: true, runId: other })).ok).toBe(true);
    const otherPaths = await resolveRunPath(cwd, "latest");
    expect(otherPaths?.absoluteRunRoot.endsWith(other)).toBe(true);
    await appendSandboxReceipt(otherPaths!, {
      at: "t2",
      laneId: "lane-01",
      sandboxId: "fake-sb-other",
    });

    const run = await setup({ runId: "latest" });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(run.killed).toEqual(["fake-sb-named"]);
  });

  it("keeps second-signal exit when analysis starts after shutdown began", async () => {
    const run = await setup({
      kill: () => new Promise<boolean>(() => undefined),
      deadlineMs: 2_000,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.killed).toEqual(["fake-sb-1"]));
    // The route published its bundle meanwhile and analysis starts.
    handOverRunSignals();
    target.emit("SIGTERM");
    expect(run.exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  it("never prints a reclaim command that would resolve another run", async () => {
    expect((await runDryRun({ cwd, dryRun: true, runId: "latest" })).ok).toBe(true);
    const named = await prepareRunArtifactPaths(cwd, "latest");
    await appendSandboxReceipt(named, { at: "t1", laneId: "lane-01", sandboxId: "fake-sb-named" });
    const run = await setup({
      runId: "latest",
      kill: () => new Promise<boolean>(() => undefined),
      deadlineMs: 50,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(run.stderr()).not.toContain("reclaim --run latest");
    expect(run.stderr()).toContain(
      path.join(".humanish", "runs", "latest", "sandbox-receipts.ndjson"),
    );
  });

  it("exits at the deadline even when the status write never settles", async () => {
    const run = await setup({
      interrupt: () => new Promise<boolean>(() => undefined),
      deadlineMs: 50,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(run.killed).toEqual([]);
    expect(run.stderr()).toContain("stopping did not finish within 0.05 s");
  });

  it("keeps second-signal exit when the run returns after shutdown began", async () => {
    const run = await setup({
      kill: () => new Promise<boolean>(() => undefined),
      deadlineMs: 2_000,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.killed).toEqual(["fake-sb-1"]));
    // The run returned; the run command releases its handling before presentation.
    run.phase.release();
    target.emit("SIGTERM");
    expect(run.exit).toHaveBeenCalledExactlyOnceWith(143);
  });

  it("finishes the registered shutdown cleanups before it exits", async () => {
    const order: string[] = [];
    cleanups.push(
      onRunShutdown(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("tunnel closed");
      }),
    );
    const run = await setup({});
    run.exit.mockImplementation(() => order.push("exit"));
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(order).toEqual(["tunnel closed", "exit"]);
  });

  it("hands the signals to analysis cancellation when analysis starts", () => {
    const exit = vi.fn();
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const before = new Map(signals.map((signal) => [signal, process.listeners(signal)]));
    const phase = beginRunSignalPhase({ writeErr: () => undefined }, { exit });
    cleanups.push(phase.end);
    const analysis = cliAnalysisOptions({ writeErr: () => undefined });
    void analysis.onEvent?.({ type: "analysis-started" });
    // Only the analysis listener is new: the run's handlers left when analysis started. Calling
    // the listeners directly keeps the test runner's own signal handling out of it.
    for (const signal of signals) {
      const added = process.listeners(signal).filter((l) => !before.get(signal)?.includes(l));
      expect(added).toHaveLength(1);
      for (const listener of added) (listener as (received: string) => void)(signal);
    }
    expect(analysis.analysisSignal?.aborted).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    void analysis.onEvent?.({ type: "analysis-finished" });
    for (const signal of signals) expect(process.listeners(signal)).toEqual(before.get(signal));
  });
});
