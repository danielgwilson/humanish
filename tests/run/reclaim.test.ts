import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Salvage tier: interrupted runs fail cheap. The run journals every created sandbox id to
// disk the moment create returns; `humanish reclaim` kills by those exact recorded ids, never by
// enumerating the account, and records what happened to each. These tests drive the
// real run-dir resolution chain (a $0 dry-run creates the managed dir + latest pointer) with a
// fake @e2b/desktop module, so the containment discipline is exercised, not mocked away.
import { STUDY_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import { parseStudy } from "../../src/study/config.js";
import { runTerminalProductStudy } from "../../src/routes/terminal/route.js";
import { resolveRunPath } from "../../src/run/locate.js";
import {
  appendSandboxReceipt,
  parseSandboxReceipts,
  SANDBOX_RECEIPTS_ARTIFACT,
} from "../../src/run/sandbox-receipts.js";
import { createProgram } from "../../src/cli/program.js";
import { runIdOf } from "../../src/run/paths.js";
import { RECLAIM_RECEIPT_ARTIFACT, reclaimRunSandboxes } from "../../src/run/reclaim.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

function dryRunConfig(): StudyConfig {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "reclaim-fixture",
    route: "terminal",
    mode: "dry-run",
    subject: {
      source: "terminal-product",
      product: { name: "example-cli", publicSurfaces: ["https://example.test"] },
    },
    actor: { type: "codex-exec", mission: "Contract only." },
    caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 5 },
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** A kill-only fake module: records every id it is asked about; never exposes list. */
function fakeModule(
  behavior: Record<string, "ok" | "gone" | "not-found-throw" | "boom">,
  killedIds: string[],
): E2BDesktopModule {
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
        if (mode === "not-found-throw")
          throw Object.assign(new Error(`sandbox ${sandboxId} is gone`), {
            name: "SandboxNotFoundError",
          });
        throw new Error("provider exploded");
      },
    },
  } as unknown as E2BDesktopModule;
}

describe("sandbox receipts + humanish reclaim", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("parseSandboxReceipts keeps valid lines and drops a torn final line", () => {
    const text = `${JSON.stringify({ at: "t", laneId: "lane-01", sandboxId: "fake-sb-1", timeoutMs: 5 })}\n{"laneId":"lane-02","sandbo`;
    expect(parseSandboxReceipts(text)).toEqual([
      { at: "t", laneId: "lane-01", provider: "e2b", sandboxId: "fake-sb-1", timeoutMs: 5 },
    ]);
  });

  it("parseSandboxReceipts keeps a recorded provider, including one it does not know", () => {
    const lines = [
      { at: "t1", laneId: "lane-01", provider: "e2b", sandboxId: "fake-sb-1" },
      { at: "t2", laneId: "lane-02", provider: "example-cloud", sandboxId: "fake-sb-2" },
      { at: "t3", laneId: "lane-03", provider: 7, sandboxId: "fake-sb-3" },
    ];
    expect(parseSandboxReceipts(lines.map((line) => JSON.stringify(line)).join("\n"))).toEqual([
      { at: "t1", laneId: "lane-01", provider: "e2b", sandboxId: "fake-sb-1" },
      { at: "t2", laneId: "lane-02", provider: "example-cloud", sandboxId: "fake-sb-2" },
    ]);
  });

  it("reports a receipt from an unknown provider without loading or calling E2B", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    await writeFile(
      path.join(runPaths!.absoluteRunRoot, SANDBOX_RECEIPTS_ARTIFACT),
      `${JSON.stringify({ at: "t1", laneId: "lane-01", provider: "example-cloud", sandboxId: "fake-sb-elsewhere" })}\n`,
    );
    const loadModule = vi.fn(async () => fakeModule({}, []));

    const result = await reclaimRunSandboxes(cwd, "latest", { loadModule });

    expect(loadModule).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.outcomes).toEqual([
      {
        sandboxId: "fake-sb-elsewhere",
        laneId: "lane-01",
        state: "unsupported-provider",
        detail: expect.stringContaining('"example-cloud"'),
      },
    ]);
  });

  it("kills an old receipt with no provider and a new e2b one through the same E2B path", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    await appendSandboxReceipt(runPaths!, {
      at: "t1",
      laneId: "lane-01",
      sandboxId: "fake-sb-old",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t2",
      laneId: "lane-02",
      provider: "e2b",
      sandboxId: "fake-sb-new",
    });
    const killedIds: string[] = [];

    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({ "fake-sb-old": "ok", "fake-sb-new": "ok" }, killedIds),
    });

    expect(killedIds).toEqual(["fake-sb-old", "fake-sb-new"]);
    expect(result.ok).toBe(true);
  });

  it("reclaims by recorded exact id: kills the living, reports the gone, fails loud on a provider error, dedupes racing receipts", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    expect(runPaths).not.toBeNull();

    await appendSandboxReceipt(runPaths!, {
      at: "t1",
      laneId: "lane-01",
      sandboxId: "fake-sb-alive",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t2",
      laneId: "lane-02",
      sandboxId: "fake-sb-gone",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t3",
      laneId: "lane-03",
      sandboxId: "fake-sb-broken",
    });
    await appendSandboxReceipt(runPaths!, {
      at: "t4",
      laneId: "lane-01",
      sandboxId: "fake-sb-alive",
    }); // raced duplicate

    const killedIds: string[] = [];
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () =>
        fakeModule(
          { "fake-sb-alive": "ok", "fake-sb-gone": "not-found-throw", "fake-sb-broken": "boom" },
          killedIds,
        ),
    });

    // One attempt per unique id, exactly the journaled ids, nothing else, and no list call exists
    // on the fake to begin with (the module type never offers one to reclaim).
    expect(killedIds.sort()).toEqual(["fake-sb-alive", "fake-sb-broken", "fake-sb-gone"]);
    expect(result.receiptCount).toBe(4);
    const states = Object.fromEntries(result.outcomes.map((o) => [o.sandboxId, o.state]));
    expect(states).toEqual({
      "fake-sb-alive": "killed",
      "fake-sb-gone": "already-gone",
      "fake-sb-broken": "kill-failed",
    });
    // A kill-failed means the reclaim did not fully succeed: the exit says so, and the TTL is the
    // backstop.
    expect(result.ok).toBe(false);

    // The reclaim record lands next to the run it cleaned.
    const receipt = JSON.parse(
      await readFile(
        path.join(cwd, ".humanish", "runs", result.runId, RECLAIM_RECEIPT_ARTIFACT),
        "utf8",
      ),
    );
    expect(receipt.outcomes).toHaveLength(3);
  });

  it("a run with no receipts reclaims ok with a warning that it had nothing to act on (no scan pretended)", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const result = await reclaimRunSandboxes(cwd, "latest", {
      loadModule: async () => fakeModule({}, []),
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

describe("reclaim of unreadable receipts", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-unreadable-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // Root reads a mode-000 file anyway, so this case needs an unprivileged user.
  it.skipIf(process.getuid?.() === 0)(
    "reports receipts it cannot read instead of claiming there are none",
    async () => {
      const run = await runTerminalProductStudy({
        cwd,
        config: dryRunConfig(),
        dryRun: true,
        open: false,
      });
      expect(run.ok).toBe(true);
      const runPaths = await resolveRunPath(cwd, "latest");
      await appendSandboxReceipt(runPaths!, {
        at: "t1",
        laneId: "lane-01",
        sandboxId: "fake-sb-hidden",
      });
      await chmod(path.join(runPaths!.absoluteRunRoot, SANDBOX_RECEIPTS_ARTIFACT), 0o000);
      const killedIds: string[] = [];

      const result = await reclaimRunSandboxes(cwd, "latest", {
        loadModule: async () => fakeModule({}, killedIds),
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("HUMANISH_RECLAIM_RECEIPTS_UNREADABLE");
      expect(result.warnings.join("\n")).not.toContain("No sandbox-receipts.ndjson");
      expect(killedIds).toEqual([]);
    },
  );
});

describe("reclaim with E2B_DEBUG=true", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-debug-"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses before loading the SDK and keeps the receipts", async () => {
    const run = await runTerminalProductStudy({
      cwd,
      config: dryRunConfig(),
      dryRun: true,
      open: false,
    });
    expect(run.ok).toBe(true);
    const runPaths = await resolveRunPath(cwd, "latest");
    if (!runPaths) throw new Error("dry run left no run");
    await appendSandboxReceipt(runPaths, {
      at: "t1",
      laneId: "lane-01",
      sandboxId: "fake-sb-alive",
    });
    vi.stubEnv("E2B_DEBUG", "true");
    const killedIds: string[] = [];
    const loadModule = vi.fn(async () => fakeModule({ "fake-sb-alive": "ok" }, killedIds));

    const result = await reclaimRunSandboxes(cwd, "latest", { loadModule });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_RECLAIM_E2B_DEBUG");
    expect(result.error?.message).toContain("E2B_DEBUG");
    expect(result.outcomes).toEqual([]);
    expect(loadModule).not.toHaveBeenCalled();
    expect(killedIds).toEqual([]);
    const runDir = path.join(cwd, ".humanish", "runs", runIdOf(runPaths));
    await expect(readFile(path.join(runDir, RECLAIM_RECEIPT_ARTIFACT))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      parseSandboxReceipts(await readFile(path.join(runDir, SANDBOX_RECEIPTS_ARTIFACT), "utf8")),
    ).toHaveLength(1);
  });

  it("exits 2 from the CLI with the refusal code", async () => {
    vi.stubEnv("E2B_DEBUG", "True");
    let out = "";
    let exitCode: number | undefined;
    const program = createProgram({
      writeOut: (text) => {
        out += text;
      },
      writeErr: () => undefined,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    await program.parseAsync(["node", "humanish", "reclaim", "--cwd", cwd, "--json"], {
      from: "node",
    });
    expect(exitCode).toBe(2);
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: { code: "HUMANISH_RECLAIM_E2B_DEBUG" },
    });
  });
});
