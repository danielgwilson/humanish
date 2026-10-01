import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../../src/lab/types.js";
import { parseLabConfig } from "../../../src/lab/config.js";
import { runTerminalProductLab } from "../../../src/routes/terminal/route.js";
import { reclaimRunSandboxes } from "../../../src/run/reclaim.js";
import { SANDBOX_RECEIPTS_ARTIFACT } from "../../../src/run/sandbox-receipts.js";
import { classifyRunStatus, RUN_STATUS_STALE_MS } from "../../../src/run/status.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule } from "../../../src/substrates/e2b/sdk.js";

// The acquisition boundary of the shared sandbox module, exercised through the terminal route:
// B1 the receipt write fails, B2 the process dies after the receipt lands, B3 the provider
// allocates but never hands the id back. The fake SDK stands in for E2B; no provider is called.

const RUN_ID = "run-acquisition-boundary";

const labInput = {
  schema: LAB_CONFIG_SCHEMA,
  id: "terminal-acquisition-boundary",
  subject: {
    source: "terminal-product",
    product: { name: "example-cli", publicSurfaces: ["https://example.test/cli"] },
  },
  actors: [{ type: "codex-exec", mission: "Discover example-cli from its public surface." }],
  execution: {
    target: "e2b-terminal",
    runtimeAuth: "openai-env",
    timeoutMs: 600_000,
    terminal: { transport: "exec-stream", stdin: "disabled" },
  },
  scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 10 } },
  policies: {
    allowPrivateRepoAccess: false,
    allowProviderCredentials: false,
    allowPaymentCredentials: false,
    allowGitHubMutation: false,
  },
};

function labConfig(): LabConfig {
  const parsed = parseLabConfig(labInput);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

const env = { OPENAI_API_KEY: "synthetic-runtime-value", E2B_API_KEY: "synthetic-e2b-value" };

interface FakeProvider {
  module: E2BDesktopModule;
  /** Every sandbox the provider allocated, with the options it was created under. */
  allocated: { sandboxId: string; options: E2BDesktopCreateOptions }[];
  killed: string[];
}

function fakeProvider(behavior: {
  afterAllocate?: (sandboxId: string) => Promise<void>;
  rejectAfterAllocate?: boolean;
  /** The first command rewrites the handle's id, as a misbehaving hook or SDK could. */
  rewriteHandleId?: boolean;
}): FakeProvider {
  const allocated: FakeProvider["allocated"] = [];
  const killed: string[] = [];
  const module = {
    Sandbox: {
      async create(options: E2BDesktopCreateOptions) {
        const sandboxId = `sb-boundary-${allocated.length + 1}`;
        allocated.push({ sandboxId, options });
        await behavior.afterAllocate?.(sandboxId);
        if (behavior.rejectAfterAllocate)
          throw new Error("provider response lost after allocation");
        const handle = {
          sandboxId,
          commands: {
            run: async () => {
              if (behavior.rewriteHandleId) handle.sandboxId = "sb-unrelated";
              return { exitCode: 1, stdout: "", stderr: "synthetic failure" };
            },
          },
          files: { write: async () => undefined },
        };
        return handle;
      },
      async kill(sandboxId: string) {
        killed.push(sandboxId);
        return true;
      },
    },
  } as unknown as E2BDesktopModule;
  return { module, allocated, killed };
}

/**
 * Run the live terminal route in a child process whose every exec hangs, wait until the sandbox
 * receipt lands, then SIGKILL the child. Resolves with how the child exited.
 */
async function killRouteAfterReceipt(
  cwd: string,
  runDir: string,
): Promise<NodeJS.Signals | number | null> {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const script = `
    const { runTerminalProductLab } = await import(${JSON.stringify(path.join(root, "src/routes/terminal/route.ts"))});
    const { parseLabConfig } = await import(${JSON.stringify(path.join(root, "src/lab/config.ts"))});
    const parsed = parseLabConfig(JSON.parse(process.env.BOUNDARY_LAB));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const module = {
      Sandbox: {
        async create() {
          return {
            sandboxId: "sb-boundary-orphan",
            // Every exec hangs on an open handle, as a stuck provider socket would, so the run
            // is inside the sandbox when it is killed.
            commands: { run: () => new Promise(() => setInterval(() => {}, 60_000)) },
            files: { write: async () => undefined },
          };
        },
        async kill() { return true; },
      },
    };
    await runTerminalProductLab({
      cwd: process.env.BOUNDARY_CWD,
      config: parsed.config,
      dryRun: false,
      open: false,
      runId: process.env.BOUNDARY_RUN_ID,
      hooks: { loadModule: async () => module, env: ${JSON.stringify(env)} },
    });
  `;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: root,
      env: {
        ...process.env,
        BOUNDARY_CWD: cwd,
        BOUNDARY_RUN_ID: RUN_ID,
        BOUNDARY_LAB: JSON.stringify(labInput),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ?? code));
  });
  let exitedEarly = false;
  void exited.then(() => {
    exitedEarly = true;
  });
  try {
    // No clock of its own: the wait ends when the receipt lands or the route exits, and the test
    // timeout bounds a hang, so a slow tsx start under load cannot end it early.
    const receipts = path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT);
    const landed = async (): Promise<boolean> =>
      (await readFile(receipts, "utf8").catch(() => "")).includes(
        '"sandboxId":"sb-boundary-orphan"',
      );
    while (!(await landed())) {
      if (exitedEarly) throw new Error(`The route exited before its receipt landed: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    child.kill("SIGKILL");
  }
  return exited;
}

describe("terminal sandbox acquisition boundary", () => {
  let cwd: string;
  let runDir: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-acquisition-"));
    runDir = path.join(cwd, ".humanish", "runs", RUN_ID);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("B1: a failed receipt write keeps the run going and the in-process teardown kills by id", async () => {
    const provider = fakeProvider({
      // The receipt path becomes a directory after the run directory exists, so the append fails.
      afterAllocate: async () => {
        await mkdir(path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT));
      },
    });

    const result = await runTerminalProductLab({
      cwd,
      config: labConfig(),
      dryRun: false,
      open: false,
      runId: RUN_ID,
      hooks: { loadModule: async () => provider.module, env },
    });

    expect(result.runId).toBe(RUN_ID);
    expect(provider.allocated.map((sandbox) => sandbox.sandboxId)).toEqual(["sb-boundary-1"]);
    expect(provider.killed).toEqual(["sb-boundary-1"]);
    expect((await stat(path.join(runDir, "run.json"))).isFile()).toBe(true);
    // A best-effort receipt is not durable registration: reclaim has nothing to act on.
    const loadModule = vi.fn(async () => provider.module);
    const reclaim = await reclaimRunSandboxes(cwd, RUN_ID, { loadModule });
    expect(reclaim.receiptCount).toBe(0);
    expect(reclaim.outcomes).toEqual([]);
    expect(loadModule).not.toHaveBeenCalled();
  });

  it("tears down the id captured at create, not whatever the handle says later", async () => {
    const provider = fakeProvider({ rewriteHandleId: true });

    await runTerminalProductLab({
      cwd,
      config: labConfig(),
      dryRun: false,
      open: false,
      runId: RUN_ID,
      hooks: { loadModule: async () => provider.module, env },
    });

    expect(provider.killed).toEqual(["sb-boundary-1"]);
  });

  it("B2: after the receipt lands and the process dies, reclaim kills the recorded id", async () => {
    expect(await killRouteAfterReceipt(cwd, runDir)).toBe("SIGKILL");

    const provider = fakeProvider({});
    const reclaim = await reclaimRunSandboxes(cwd, RUN_ID, {
      loadModule: async () => provider.module,
    });
    expect(provider.allocated).toEqual([]);
    expect(provider.killed).toEqual(["sb-boundary-orphan"]);
    expect(reclaim.outcomes).toEqual([
      { sandboxId: "sb-boundary-orphan", laneId: "terminal", state: "killed" },
    ]);
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      state: "running" | "finished";
      updatedAt: string;
    };
    expect(status.state).toBe("running");
    expect(classifyRunStatus(status, Date.now() + RUN_STATUS_STALE_MS + 1)).toBe("interrupted");
  }, 60_000);

  it("B3: an allocation whose id never reaches the run has no receipt and keeps its TTL", async () => {
    const provider = fakeProvider({ rejectAfterAllocate: true });

    const result = await runTerminalProductLab({
      cwd,
      config: labConfig(),
      dryRun: false,
      open: false,
      runId: RUN_ID,
      hooks: { loadModule: async () => provider.module, env },
    });

    expect(result.ok).toBe(false);
    expect(provider.allocated).toHaveLength(1);
    expect(provider.killed).toEqual([]);
    await expect(stat(path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT))).rejects.toThrow("ENOENT");
    const reclaim = await reclaimRunSandboxes(cwd, RUN_ID, {
      loadModule: async () => provider.module,
    });
    expect(reclaim.receiptCount).toBe(0);
    // The provider-side backstop: the sandbox kills itself when its create-time timeout ends.
    const [created] = provider.allocated;
    expect(created?.options.timeoutMs).toBeGreaterThan(0);
    expect(created?.options.lifecycle).toEqual({ onTimeout: "kill" });
  });
});
