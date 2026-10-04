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
import { prepareRunArtifactPaths, type PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { RECLAIM_RECEIPT_ARTIFACT } from "../../src/run/reclaim.js";
import { sandboxOwnerTags } from "../../src/run/sandbox-creates.js";
import {
  appendSandboxReceipt,
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "../../src/run/sandbox-receipts.js";
import type { RunInterruptSignal } from "../../src/run/status.js";
import { acquireE2BDesktopSandbox } from "../../src/substrates/e2b/sandbox.js";
import type {
  E2BDesktopModule,
  E2BDesktopSandbox,
  E2BListedSandbox,
} from "../../src/substrates/e2b/sdk.js";

// The run command's handler: the first signal says it is stopping, refuses further creates, marks
// the run interrupted, reclaims the sandboxes its receipts, its in-flight creates and its E2B tags
// name, and exits 128+n; a second prints the reclaim command and exits at once; analysis takes
// the signals over.
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

/** A fake @e2b/desktop module: creates resolve when the test says, kills and lists record. */
function fakeE2B(options: {
  kill?: (sandboxId: string) => Promise<boolean>;
  listed?: (paths: PreparedRunArtifactPaths) => E2BListedSandbox[];
  paths?: PreparedRunArtifactPaths;
  /** Holds every list request open until it resolves. */
  listGate?: Promise<void>;
}) {
  const killed: string[] = [];
  let lists = 0;
  const created: unknown[] = [];
  const pendingCreates: Array<(result: { sandboxId: string } | Error) => void> = [];
  const module = {
    Sandbox: {
      create: (...args: unknown[]) => {
        created.push(args);
        return new Promise<E2BDesktopSandbox>((resolve, reject) => {
          pendingCreates.push((result) =>
            result instanceof Error ? reject(result) : resolve(result as E2BDesktopSandbox),
          );
        });
      },
      kill: async (sandboxId: string) => {
        killed.push(sandboxId);
        return (options.kill ?? (async () => true))(sandboxId);
      },
      list: () => {
        let read = false;
        return {
          get hasNext() {
            return !read;
          },
          nextItems: async () => {
            read = true;
            lists += 1;
            await options.listGate;
            return options.listed && options.paths ? options.listed(options.paths) : [];
          },
        };
      },
    },
  } as unknown as E2BDesktopModule;
  /** Resolve (or fail) the oldest create still waiting. */
  const finishCreate = (result: { sandboxId: string } | Error) => pendingCreates.shift()?.(result);
  return { module, killed, created, finishCreate, lists: () => lists };
}

async function setup(options: {
  runId?: string;
  interrupted?: boolean;
  interrupt?: () => Promise<boolean>;
  kill?: (sandboxId: string) => Promise<boolean>;
  listed?: (paths: PreparedRunArtifactPaths) => E2BListedSandbox[];
  listGate?: Promise<void>;
  deadlineMs?: number;
}) {
  const runId = options.runId ?? RUN;
  const interrupt = vi.fn(
    async (_signal: RunInterruptSignal) =>
      (await options.interrupt?.()) ?? options.interrupted ?? true,
  );
  const paths = await prepareRunArtifactPaths(cwd, runId);
  cleanups.push(registerActiveRun({ cwd, runId, paths, status: { interrupt } }));
  const e2b = fakeE2B({
    ...(options.kill === undefined ? {} : { kill: options.kill }),
    ...(options.listed === undefined ? {} : { listed: options.listed }),
    ...(options.listGate === undefined ? {} : { listGate: options.listGate }),
    paths,
  });
  const exit = vi.fn();
  let stderr = "";
  const phase = beginRunSignalPhase(
    { writeErr: (text) => (stderr += text) },
    {
      signalTarget: target,
      exit,
      reclaim: { loadModule: async () => e2b.module },
      ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    },
  );
  cleanups.push(phase.end);
  return { interrupt, ...e2b, exit, phase, paths, stderr: () => stderr };
}

/** The command the handler prints for this test's run, whose cwd is a temporary directory. */
const reclaimCommand = (runId: string) => `humanish reclaim --run ${runId} --cwd ${cwd}`;

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
        source: "receipt",
        state: "killed",
      },
    ]);
    expect(run.stderr().split("\n")).toEqual([
      `humanish: SIGTERM: stopping run ${RUN} and reclaiming its sandboxes (up to 10 s); a second SIGTERM exits without waiting.`,
      `humanish: SIGTERM: run ${RUN} marked interrupted; sandboxes clean: 1 killed; E2B lists none still tagged with this run.`,
      "",
    ]);
  });

  it("says it is stopping before it awaits anything", async () => {
    const run = await setup({});
    target.emit("SIGINT");
    expect(run.stderr()).toContain(`humanish: SIGINT: stopping run ${RUN}`);
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(130));
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
    // The terminal says what was left undone and the exact command that finishes it.
    expect(run.stderr()).toContain(
      `humanish: second SIGINT: exiting before run ${RUN}'s sandboxes were confirmed stopped; run \`${reclaimCommand(RUN)}\` to stop what is left.`,
    );
  });

  it("exits after the deadline and names the reclaim command", async () => {
    const run = await setup({ kill: () => new Promise<boolean>(() => undefined), deadlineMs: 50 });
    target.emit("SIGHUP");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(129));
    expect(run.stderr()).toContain("sandboxes unknown");
    expect(run.stderr()).toContain(`\`${reclaimCommand(RUN)}\``);
  });

  it("kills twelve sandboxes at once under a slow kill and names the unconfirmed one on timeout", async () => {
    for (let index = 2; index <= 12; index += 1)
      await appendSandboxReceipt(await prepareRunArtifactPaths(cwd, RUN), {
        at: `t${index}`,
        laneId: "lane-01",
        sandboxId: `fake-sb-${index}`,
      });
    // Each kill takes 100 ms, one at a time that is 1.2 s; the newest never answers.
    const run = await setup({
      kill: (sandboxId) =>
        sandboxId === "fake-sb-12"
          ? new Promise<boolean>(() => undefined)
          : new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 100)),
      deadlineMs: 600,
    });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(run.killed).toHaveLength(12);
    expect(run.killed).toContain("fake-sb-12");
    const receipt = JSON.parse(
      await readFile(path.join(run.paths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT), "utf8"),
    ) as { state: string; outcomes: { sandboxIdDigest: string; state: string }[] };
    expect(receipt.state).toBe("unknown");
    expect(receipt.outcomes.filter((outcome) => outcome.state === "killed")).toHaveLength(11);
    expect(receipt.outcomes.filter((outcome) => outcome.state === "pending")).toEqual([
      expect.objectContaining({ sandboxIdDigest: sandboxIdDigest("fake-sb-12") }),
    ]);
  });

  it("leaves a run that had already finished to its route", async () => {
    const run = await setup({ interrupted: false });
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    expect(run.killed).toEqual([]);
    expect(run.stderr()).not.toContain("marked interrupted");
  });

  it("takes no signal after end", async () => {
    const run = await setup({});
    run.phase.end();
    expect(target.listenerCount("SIGTERM")).toBe(0);
    target.emit("SIGTERM");
    expect(run.exit).not.toHaveBeenCalled();
  });
});

// A sandbox exists on E2B before its create returns, and so before its receipt. These cover a
// signal that lands in that window.
describe("the run command's signal handler during a sandbox create", () => {
  async function creating(run: Awaited<ReturnType<typeof setup>>, participantId = "p1") {
    const acquired = acquireE2BDesktopSandbox({
      module: run.module,
      options: { apiKey: "synthetic", timeoutMs: 60_000 },
      receipt: { root: run.paths, participantId },
    });
    // Returned in an object: an async function would otherwise wait for the create to return.
    acquired.catch(() => undefined);
    await vi.waitFor(() => expect(run.created).toHaveLength(1));
    return { acquired };
  }

  it("kills a sandbox whose create returns after the signal, before its receipt was written", async () => {
    const run = await setup({});
    const { acquired } = await creating(run);
    target.emit("SIGINT");
    // The create is still waiting on E2B: only the journaled sandbox is named yet.
    await vi.waitFor(() => expect(run.killed).toEqual(["fake-sb-1"]));
    run.finishCreate({ sandboxId: "fake-sb-late" });
    await acquired;
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(130));
    expect(run.killed.sort()).toEqual(["fake-sb-1", "fake-sb-late"]);
    const receipt = JSON.parse(
      await readFile(path.join(run.paths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT), "utf8"),
    ) as { state: string; outcomes: { sandboxIdDigest: string; source: string; state: string }[] };
    expect(receipt.state).toBe("clean");
    expect(receipt.outcomes).toContainEqual(
      expect.objectContaining({
        sandboxIdDigest: sandboxIdDigest("fake-sb-late"),
        source: "create",
        state: "killed",
      }),
    );
    expect(run.stderr()).toContain("sandboxes clean: 2 killed");
  });

  it("tags the create with the run's owner tags before it reaches E2B", async () => {
    const run = await setup({});
    await creating(run);
    const [options] = run.created[0] as [{ metadata?: Record<string, string> }];
    expect(options.metadata).toEqual(sandboxOwnerTags(run.paths));
    expect(options.metadata?.runId).toBe(RUN);
    run.finishCreate({ sandboxId: "fake-sb-tagged" });
  });

  it("refuses a create that starts after the signal, before any call to E2B", async () => {
    const run = await setup({
      kill: () => new Promise<boolean>(() => undefined),
      deadlineMs: 300,
    });
    target.emit("SIGTERM");
    await expect(
      acquireE2BDesktopSandbox({
        module: run.module,
        options: { apiKey: "synthetic" },
        receipt: { root: run.paths, participantId: "p2" },
      }),
    ).rejects.toThrow("The run is stopping");
    expect(run.created).toEqual([]);
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
  });

  it("finds a sandbox whose id never reached the process by the run's E2B tags", async () => {
    // The create threw after E2B allocated, so only E2B knows the sandbox exists.
    const run = await setup({
      listed: (paths) => [
        {
          sandboxId: "fake-sb-orphan",
          metadata: { ...sandboxOwnerTags(paths), participantId: "p1" },
        },
      ],
    });
    const { acquired } = await creating(run);
    target.emit("SIGINT");
    run.finishCreate(new Error("Response data is missing"));
    await expect(acquired).rejects.toThrow("Response data is missing");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(130));
    expect(run.killed.sort()).toEqual(["fake-sb-1", "fake-sb-orphan"]);
    expect(run.stderr()).toContain("sandboxes clean: 2 killed");
  });

  it("kills a sandbox whose create returns while the tag search is still running", async () => {
    let releaseList!: () => void;
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    // A 3 s deadline gives in-flight creates 1.5 s before the search starts.
    const run = await setup({ deadlineMs: 3_000, listGate });
    await creating(run);
    target.emit("SIGINT");
    await vi.waitFor(() => expect(run.lists()).toBe(1), { timeout: 5_000 });
    run.finishCreate({ sandboxId: "fake-sb-during-search" });
    await vi.waitFor(() => expect(run.killed).toContain("fake-sb-during-search"));
    releaseList();
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(130));
    const receipt = JSON.parse(
      await readFile(path.join(run.paths.absoluteRunRoot, RECLAIM_RECEIPT_ARTIFACT), "utf8"),
    ) as { outcomes: { sandboxIdDigest: string; state: string }[] };
    expect(receipt.outcomes).toContainEqual(
      expect.objectContaining({
        sandboxIdDigest: sandboxIdDigest("fake-sb-during-search"),
        state: "killed",
      }),
    );
  });

  it("does not kill again a sandbox its route already released", async () => {
    const run = await setup({});
    const { acquired } = await creating(run);
    run.finishCreate({ sandboxId: "fake-sb-released" });
    const { allocation } = await acquired;
    await allocation.close();
    expect(run.killed).toEqual(["fake-sb-released"]);
    target.emit("SIGTERM");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(143));
    // The receipt journal names it too; the route's confirmed release is what skips it.
    expect(
      parseSandboxReceipts(
        await readFile(path.join(run.paths.absoluteRunRoot, SANDBOX_RECEIPTS_ARTIFACT), "utf8"),
      ).map((receipt) => receipt.sandboxId),
    ).toContain("fake-sb-released");
    expect(run.killed).toEqual(["fake-sb-released", "fake-sb-1"]);
  });

  it("says unknown, with the command that searches by tag, when a create outlasts the deadline", async () => {
    const run = await setup({ deadlineMs: 200 });
    await creating(run);
    target.emit("SIGINT");
    await vi.waitFor(() => expect(run.exit).toHaveBeenCalledWith(130));
    expect(run.stderr()).toContain("sandboxes unknown");
    expect(run.stderr()).toContain("1 sandbox create");
    expect(run.stderr()).toContain(`\`${reclaimCommand(RUN)}\``);
    expect(run.stderr()).not.toContain("clean");
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
