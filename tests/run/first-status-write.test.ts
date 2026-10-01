import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { parseLabConfig } from "../../src/lab/config.js";
import { runLab } from "../../src/run-lab.js";
import { LAB_CONFIG_SCHEMA, type LabConfig } from "../../src/lab/types.js";
import { RUN_STATUS_FILE } from "../../src/run/status.js";
import type { E2BDesktopModule } from "../../src/substrates/e2b/sdk.js";

// The first status.json write of each run lands late. A route that acquires a sandbox without
// awaiting it reaches Sandbox.create before the record exists; under load that is what left a run
// killed after its sandbox receipt with no status record.
const delayed = vi.hoisted(() => ({ roots: new WeakSet<object>(), ms: 1_000 }));
vi.mock("../../src/run/contained-output.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/contained-output.js")>();
  return {
    ...actual,
    writeContainedOutputFile: async (
      ...args: Parameters<typeof actual.writeContainedOutputFile>
    ): Promise<void> => {
      const [root, relativePath] = args;
      if (relativePath === "status.json" && typeof root === "object" && !delayed.roots.has(root)) {
        delayed.roots.add(root);
        await new Promise((resolve) => setTimeout(resolve, delayed.ms));
      }
      return actual.writeContainedOutputFile(...args);
    },
  };
});

const ROOT = path.resolve(import.meta.dirname, "../..");
const RUN_ID = "run-status-before-sandbox";
const env = { OPENAI_API_KEY: "synthetic-openai", E2B_API_KEY: "synthetic-e2b" };

function parsed(input: unknown): LabConfig {
  const result = parseLabConfig(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.config;
}

const clone = {
  source: "clone",
  repos: ["example-org/example-app"],
  serve: { start: "pnpm start --host 0.0.0.0", url: "http://127.0.0.1:3000/" },
};

/** Records whether the run's status.json existed at each create, then refuses the create. */
function statusCheckingModule(runDir: string, seen: boolean[]): E2BDesktopModule {
  return {
    Sandbox: {
      async create() {
        seen.push(existsSync(path.join(runDir, RUN_STATUS_FILE)));
        throw new Error("synthetic: the test stops at the first sandbox create");
      },
      async kill() {
        return true;
      },
    },
  } as unknown as E2BDesktopModule;
}

describe("a live route records its status before acquiring a sandbox", () => {
  let cwd: string;
  let runDir: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-status-first-"));
    runDir = path.join(cwd, ".humanish", "runs", RUN_ID);
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("computer use", async () => {
    const seen: boolean[] = [];
    await runLab(
      parsed({
        schema: LAB_CONFIG_SCHEMA,
        id: "status-first-cua",
        subject: clone,
        actors: [{ type: "openai-computer-use" }],
        execution: { target: "e2b-desktop", timeoutMs: 60_000 },
        scenario: { mode: "live" },
      }),
      {
        cwd,
        dryRun: false,
        runId: RUN_ID,
        cuaHooks: { env, loadDesktopModule: async () => statusCheckingModule(runDir, seen) },
      },
    );
    expect(seen).toEqual([true]);
  });

  it("concurrent shared world", async () => {
    const lab = parse(
      await readFile(path.join(ROOT, "humanish/labs/shared-world-concurrent-live.yaml"), "utf8"),
    ) as Record<string, unknown>;
    const seen: boolean[] = [];
    await runLab(parsed({ ...lab, scenario: { mode: "live" } }), {
      cwd,
      dryRun: false,
      runId: RUN_ID,
      sharedWorldHooks: { env, loadDesktopModule: async () => statusCheckingModule(runDir, seen) },
    });
    expect(seen[0]).toBe(true);
  });

  it("scripted browser on a provisioned clone", async () => {
    await mkdir(path.join(cwd, "humanish", "scenarios"), { recursive: true });
    await copyFile(
      path.join(ROOT, "humanish/scenarios/scripted-first-run.yaml"),
      path.join(cwd, "humanish/scenarios/scripted-first-run.yaml"),
    );
    const seen: boolean[] = [];
    await runLab(
      parsed({
        schema: LAB_CONFIG_SCHEMA,
        id: "status-first-scripted",
        subject: {
          ...clone,
          exposure: "synthetic",
          state: { seed: [{ name: "seed", command: "pnpm db:seed" }] },
        },
        actors: [{ type: "scripted-browser", count: 1 }],
        scenario: { ref: "scripted-first-run", mode: "live" },
        execution: { target: "e2b-desktop", timeoutMs: 60_000 },
      }),
      {
        cwd,
        dryRun: false,
        runId: RUN_ID,
        scriptedHooks: { env, loadDesktopModule: async () => statusCheckingModule(runDir, seen) },
      },
    );
    expect(seen).toEqual([true]);
  });
});
