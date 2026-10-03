// `humanish reclaim --env-file` loads the file the way `run` and `doctor` do, so the E2B_API_KEY in
// it reaches the provider client that kills the run's sandboxes. The fake @e2b/desktop module is
// kill-only, as in tests/run/reclaim.test.ts, and records the key it saw at each kill.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { appendSandboxReceipt } from "../../src/run/sandbox-receipts.js";
import { runTerminalProductStudy } from "../../src/routes/terminal/route.js";
import { parseStudyDocument } from "../../src/study/config.js";
import { V2_SCHEMA, type StudyConfig } from "../../src/study/types.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

const CANARY = "synthetic-reclaim-e2b-canary";
const seenKeys: Array<string | undefined> = [];
const loadModule = vi.fn(
  async (): Promise<E2BDesktopModule> =>
    ({
      Sandbox: {
        async create() {
          throw new Error("reclaim never creates sandboxes");
        },
        async kill() {
          seenKeys.push(process.env.E2B_API_KEY);
          return true;
        },
      },
    }) as unknown as E2BDesktopModule,
);

vi.mock("../../src/substrates/e2b/sdk.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/substrates/e2b/sdk.js")>()),
  loadE2BDesktopModule: () => loadModule(),
}));

function dryRunConfig(): StudyConfig {
  const parsed = parseStudyDocument({
    schema: V2_SCHEMA,
    id: "reclaim-env-fixture",
    subject: {
      source: "terminal-product",
      product: { name: "example-cli", publicSurfaces: ["https://example.test"] },
    },
    actors: [{ type: "codex-exec", mission: "Contract only." }],
    execution: {
      target: "e2b-terminal",
      runtimeAuth: "openai-env",
      terminal: { transport: "exec-stream", stdin: "disabled" },
    },
    scenario: { mode: "dry-run", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 5 } },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

async function runCli(args: string[]): Promise<{ exitCode: number; output: string }> {
  let exitCode = 0;
  const output: string[] = [];
  const program = createProgram({
    writeOut: (text) => output.push(text),
    writeErr: (text) => output.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
    keyDiscovery: async () => [],
  });
  program.exitOverride();
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, output: output.join("") };
}

describe("humanish reclaim --env-file", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-reclaim-env-"));
    vi.stubEnv("E2B_API_KEY", undefined);
    vi.stubEnv("E2B_DEBUG", undefined);
    seenKeys.length = 0;
    loadModule.mockClear();
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
      provider: "e2b",
      sandboxId: "fake-sb-left-running",
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(cwd, { recursive: true, force: true });
  });

  it("passes the file's E2B_API_KEY to the provider client and never prints it", async () => {
    await writeFile(path.join(cwd, "local.env"), `E2B_API_KEY=${CANARY}\n`);
    const result = await runCli(["reclaim", "--cwd", cwd, "--env-file", "local.env", "--json"]);
    expect(seenKeys).toEqual([CANARY]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toMatchObject({ ok: true });
    expect(result.output).not.toContain(CANARY);
  });

  it("stops with exit 2 before loading the provider when the file is missing", async () => {
    const result = await runCli(["reclaim", "--cwd", cwd, "--env-file", "missing.env", "--json"]);
    expect(result.exitCode).toBe(2);
    expect(loadModule).not.toHaveBeenCalled();
  });
});
