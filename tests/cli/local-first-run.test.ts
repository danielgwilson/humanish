// A first-time user's path through a local multi-participant study: init, doctor, study check and a
// watch that asks for a rerun. Each step's message says what happened and what to run next.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommanderError, type Command } from "commander";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import { localCapacity } from "../../src/substrates/local/capacity.js";

const GiB = 1024 ** 3;
const seams = vi.hoisted(() => ({ runtimeStatus: vi.fn() }));
vi.mock("../../src/substrates/local/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/substrates/local/runtime.js")>()),
  localRuntimeStatus: seams.runtimeStatus,
}));
vi.mock("../../src/analysis/restricted-codex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/analysis/restricted-codex.js")>()),
  checkRestrictedCodexAnalysisReadiness: async () => ({ ready: true, errorCode: null }),
}));

import { createProgram } from "../../src/cli/program.js";

async function runCli(args: string[]) {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  const override = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(override);
  };
  override(program);
  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return { exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
}

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-first-run-"));
  const init = await runCli([
    "init",
    "--yes",
    "--local-browser",
    "http://127.0.0.1:3000",
    "--local-mission",
    "Save a synthetic note",
    "--cwd",
    cwd,
  ]);
  expect(init.exitCode).toBe(0);
  // Three participants, all at once: what the user set up.
  const file = path.join(cwd, "humanish", "studies", "local-browser.yaml");
  const study = parse(await readFile(file, "utf8")) as Record<string, Record<string, unknown>>;
  delete study.execution!.concurrency;
  await writeFile(file, stringify({ ...study, participants: 3 }));
}, 60_000);
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("a fresh project with a local study of three participants", () => {
  it("doctor leads with runtime setup before the runtime is set up", async () => {
    seams.runtimeStatus.mockResolvedValue({
      ok: true,
      installed: false,
      message:
        "Run humanish runtime setup to create the humanish Lima host and install the browser runtime.",
      capacity: localCapacity(
        "lima-vm",
        { memoryBytes: 13 * GiB, cpus: 8 },
        { planned: true, machine: { memoryBytes: 64 * GiB, cpus: 16 } },
      ),
    });
    const run = await runCli(["doctor", "--study", "local-browser", "--cwd", cwd]);
    const lines = run.stdout.split("\n");
    expect(lines[1]).toMatch(/^next: .*runtime setup/);
    expect(
      JSON.parse(
        (await runCli(["doctor", "--study", "local-browser", "--cwd", cwd, "--json"])).stdout,
      ).next,
    ).toContain("runtime setup");
  });

  it.each(["metadata", "public-preview", "sandbox-loopback", "prepared-host"])(
    "study check --reachability %s passes and names what checks the rest",
    async (mode) => {
      const run = await runCli([
        "study",
        "check",
        "local-browser",
        "--reachability",
        mode,
        "--cwd",
        cwd,
        "--json",
      ]);
      expect(run.exitCode).toBe(0);
      const result = JSON.parse(run.stdout) as {
        ok: boolean;
        checks: { name: string; ok: boolean; checked?: boolean; message: string }[];
      };
      expect(result.ok).toBe(true);
      const unchecked = result.checks.filter((check) => check.checked === false);
      expect(unchecked.length).toBeGreaterThan(0);
      expect(unchecked.map((check) => check.message).join(" ")).toContain(
        "doctor --study local-browser",
      );
    },
  );

  it("watch --rerun-failed-from latest names the run it read, why, and what to run instead", async () => {
    const before = await runCli([
      "watch",
      "local-browser",
      "--rerun-failed-from",
      "latest",
      "--cwd",
      cwd,
      "--json",
    ]);
    const none = JSON.parse(before.stdout) as { error: { code: string; message: string } };
    expect(none.error.code).toBe("HUMANISH_COMPUTER_USE_RERUN_INVALID");
    expect(none.error.message).toContain("no runs yet");
    expect(none.error.message).toContain("watch local-browser");

    // init's first next step is the dry-run study, which moves `latest`.
    expect((await runCli(["run", "first-run", "--cwd", cwd, "--json"])).exitCode).toBe(0);
    const latest = JSON.parse(await readFile(path.join(cwd, ".humanish/runs/latest.json"), "utf8"))
      .runId as string;
    const after = await runCli([
      "watch",
      "local-browser",
      "--rerun-failed-from",
      "latest",
      "--cwd",
      cwd,
      "--json",
    ]);
    const dry = JSON.parse(after.stdout) as { error: { code: string; message: string } };
    expect(dry.error.code).toBe("HUMANISH_COMPUTER_USE_RERUN_INVALID");
    expect(dry.error.message).toContain(latest);
    expect(dry.error.message).toContain("dry run");
    expect(dry.error.message).toContain("watch local-browser");
  });
});
