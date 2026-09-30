import { cp, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli/program.js";

// When the route returns, the run under test is swapped for a same-id copy that holds a valid
// bundle and no observer/index.html. The CLI used to render the Observer again by run id at that
// point, which cannot tell the copy from the run just written, so it rendered the copy. A command
// that shows the Observer its route rendered through FinishedRun renders nothing more.
const RUN_ID = "swapped";
const swap = vi.hoisted(() => ({ cwd: "", done: false }));

async function swapRunDirectory(runId: string | undefined): Promise<void> {
  if (runId !== RUN_ID || swap.done) return;
  swap.done = true;
  const runDir = path.join(swap.cwd, ".humanish", "runs", RUN_ID);
  const moved = path.join(swap.cwd, "moved-run");
  await rename(runDir, moved);
  await cp(moved, runDir, { recursive: true });
  await rm(path.join(runDir, "observer", "index.html"), { force: true });
}

vi.mock("../../src/run/dry-run.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/run/dry-run.js")>();
  return {
    ...actual,
    runDryRun: async (...args: Parameters<typeof actual.runDryRun>) => {
      const result = await actual.runDryRun(...args);
      await swapRunDirectory(result.runId);
      return result;
    },
  };
});

vi.mock("../../src/lab/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lab/engine.js")>();
  return {
    ...actual,
    runLab: async (...args: Parameters<typeof actual.runLab>) => {
      const outcome = await actual.runLab(...args);
      await swapRunDirectory(outcome.result.runId);
      return outcome;
    },
  };
});

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => undefined,
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  program.exitOverride();
  await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  return { exitCode, stdout: stdout.join("") };
}

describe("a CLI command shows the Observer its run rendered", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-finished-observer-"));
    await cp(path.resolve("humanish"), path.join(cwd, "humanish"), { recursive: true });
    swap.cwd = cwd;
    swap.done = false;
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const expectCopyUnrendered = async (): Promise<void> => {
    expect(swap.done).toBe(true);
    const observerDir = path.join(cwd, ".humanish", "runs", RUN_ID, "observer");
    expect(await readdir(observerDir)).not.toContain("index.html");
  };

  it("humanish run", async () => {
    const run = ["run", "--dry-run", "--run-id", RUN_ID, "--cwd", cwd, "--json"];
    const { exitCode, stdout } = await runCli(run);

    expect(exitCode).toBe(0);
    await expectCopyUnrendered();
    expect(JSON.parse(stdout).observer.ok).toBe(true);
  });

  it("humanish watch --sims", async () => {
    const watch = ["watch", "--sims", "2", "--run-id", RUN_ID, "--cwd", cwd, "--json"];
    const { exitCode } = await runCli(watch);

    expect(exitCode).toBe(0);
    await expectCopyUnrendered();
  });

  it.each([
    ["preview", "first-run", "run"],
    ["preview", "first-run", "watch"],
    ["scripted", "scripted-demo", "watch"],
    ["terminal", "terminal-product-demo", "watch"],
    ["computer use", "fanout-demo", "watch"],
    ["concurrent shared world", "shared-world-concurrent-demo", "watch"],
  ] as const)("%s (%s), lab %s", async (_route, labId, mode) => {
    const command = mode === "run" ? ["lab", "run", labId, "--json"] : ["watch", labId, "--detach"];
    const { exitCode } = await runCli([...command, "--dry-run", "--run-id", RUN_ID, "--cwd", cwd]);

    expect(exitCode).toBe(0);
    await expectCopyUnrendered();
  });
});
