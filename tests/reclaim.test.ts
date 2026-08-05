import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// #358 salvage tier: interrupted runs fail cheap. The run journals every created sandbox id to
// disk the moment create returns; `humanish reclaim` kills by those EXACT recorded ids — never by
// enumerating the account — and records honestly what happened to each. These tests drive the
// REAL run-dir resolution chain (a $0 dry-run creates the managed dir + latest pointer) with a
// fake @e2b/desktop module, so the containment discipline is exercised, not mocked away.
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";
import { resolveRunPath } from "../src/run.js";
import { appendSandboxReceipt, parseSandboxReceipts, SANDBOX_RECEIPTS_ARTIFACT } from "../src/sandbox-receipts.js";
import { RECLAIM_RECEIPT_ARTIFACT, reclaimRunSandboxes } from "../src/reclaim.js";
import type { E2BDesktopModule } from "../src/e2b-desktop-launch.js";

function dryRunConfig(): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "reclaim-fixture",
    subject: { source: "terminal-product", product: { name: "example-cli", publicSurfaces: ["https://example.test"] } },
    actors: [{ type: "codex-exec", mission: "Contract only." }],
    execution: { target: "e2b-terminal", runtimeAuth: "openai-env", terminal: { transport: "exec-stream", stdin: "disabled" } },
    scenario: { mode: "dry-run", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 5 } }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** A kill-only fake module: records every id it is asked about; never exposes list. */
function fakeModule(behavior: Record<string, "ok" | "gone" | "not-found-throw" | "boom">, killedIds: string[]): E2BDesktopModule {
  return {
    Sandbox: {
      async create() {
        throw new Error("reclaim never creates sandboxes");
      },
      async kill(sandboxId: string) {
        killedIds.push(sandboxId);
        const mode = behavior[sandboxId] ?? "gone";
        if (mode === "ok") return true;
        if (mode === "gone") return false;
        if (mode === "not-found-throw") throw new Error(`SandboxNotFoundError: sandbox ${sandboxId} does not exist`);
        throw new Error("provider exploded");
      }
    }
  } as unknown as E2BDesktopModule;
}

describe("sandbox receipts + humanish reclaim (#358 salvage)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("parseSandboxReceipts keeps valid lines and drops a torn final line", () => {
    const text = `${JSON.stringify({ at: "t", laneId: "lane-01", sandboxId: "sb-1", timeoutMs: 5 })}\n{"laneId":"lane-02","sandbo`;
    expect(parseSandboxReceipts(text)).toEqual([{ at: "t", laneId: "lane-01", sandboxId: "sb-1", timeoutMs: 5 }]);
  });

  it("reclaims by recorded exact id: kills the living, reports the gone, fails loud on a provider error, dedupes racing receipts", async () => {
    const run = await runTerminalProductLab({ cwd, config: dryRunConfig(), dryRun: true, open: false });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    expect(runPaths).not.toBeNull();

    await appendSandboxReceipt(runPaths!, { at: "t1", laneId: "lane-01", sandboxId: "sb-alive" });
    await appendSandboxReceipt(runPaths!, { at: "t2", laneId: "lane-02", sandboxId: "sb-gone" });
    await appendSandboxReceipt(runPaths!, { at: "t3", laneId: "lane-03", sandboxId: "sb-broken" });
    await appendSandboxReceipt(runPaths!, { at: "t4", laneId: "lane-01", sandboxId: "sb-alive" }); // raced duplicate

    const killedIds: string[] = [];
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({ "sb-alive": "ok", "sb-gone": "not-found-throw", "sb-broken": "boom" }, killedIds)
    });

    // One attempt per unique id, exactly the journaled ids, nothing else — and no list call exists
    // on the fake to begin with (the module type never offers one to reclaim).
    expect(killedIds.sort()).toEqual(["sb-alive", "sb-broken", "sb-gone"]);
    expect(result.receiptCount).toBe(4);
    const states = Object.fromEntries(result.outcomes.map((o) => [o.sandboxId, o.state]));
    expect(states).toEqual({ "sb-alive": "killed", "sb-gone": "already-gone", "sb-broken": "kill-failed" });
    // A kill-failed means the reclaim did NOT fully succeed — exit honest, TTL is the backstop.
    expect(result.ok).toBe(false);

    // The reclaim record lands next to the run it cleaned.
    const receipt = JSON.parse(await readFile(path.join(cwd, ".humanish", "runs", result.runId, RECLAIM_RECEIPT_ARTIFACT), "utf8"));
    expect(receipt.outcomes).toHaveLength(3);
  });

  it("a run with no receipts reclaims ok with an honest warning (nothing to act on, no scan pretended)", async () => {
    const run = await runTerminalProductLab({ cwd, config: dryRunConfig(), dryRun: true, open: false });
    expect(run.ok).toBe(true);
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, [])
    });
    expect(result.ok).toBe(true);
    expect(result.receiptCount).toBe(0);
    expect(result.warnings.join("\n")).toContain("Nothing to reclaim by id");
  });

  it("an unknown run fails closed with RUN_NOT_FOUND", async () => {
    const result = await reclaimRunSandboxes(cwd, "no-such-run", {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_RECLAIM_RUN_NOT_FOUND");
  });

  it(`the receipts artifact name is stable public surface (${SANDBOX_RECEIPTS_ARTIFACT})`, () => {
    expect(SANDBOX_RECEIPTS_ARTIFACT).toBe("sandbox-receipts.ndjson");
  });
});
