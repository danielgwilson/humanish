// Failing commands in --json mode: the exact JSON and exit code each prints, pinned byte for byte
// with the project path masked. Human-mode error output may change shape; this JSON may not.
import { realpath, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommanderError, type Command } from "commander";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[]): Promise<CliRun> {
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

// Each fails before any run starts, on an empty project, with no network.
const FAILURES: ReadonlyArray<readonly [name: string, args: string[]]> = [
  ["verify-missing-run", ["verify", "--run", "nope"]],
  ["review-missing-run", ["review", "--run", "nope"]],
  ["cleanup-missing-run", ["cleanup", "--run", "nope"]],
  ["export-missing-run", ["export", "--run", "nope"]],
  ["feedback-missing-run", ["feedback", "draft", "--run", "nope"]],
  ["run-missing-lab", ["run", "nope-lab"]],
  ["run-bad-count", ["run", "--count", "0"]],
  ["lab-inspect-missing", ["lab", "inspect", "nope-lab"]],
  ["stats-bad-since", ["stats", "--since", "last tuesday"]],
  ["observe-bad-port", ["observe", "--port", "99999"]],
  ["serve-bad-port", ["serve", "--port", "99999"]],
  ["doctor-missing-env-file", ["doctor", "--env-file", "missing.env"]],
];

describe("failing commands in --json mode", () => {
  let cwd: string;
  let physical: string;
  const runs = new Map<string, CliRun>();
  const mask = (text: string) =>
    text
      .split(physical)
      .join("[cwd]")
      .split(cwd)
      .join("[cwd]")
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "[time]");

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-error-output-"));
    physical = await realpath(cwd);
    for (const [name, args] of FAILURES)
      runs.set(name, await runCli([...args, "--cwd", cwd, "--json"]));
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(FAILURES.map(([name]) => name))("%s keeps its JSON and exit code", async (name) => {
    const run = runs.get(name)!;
    expect(run.exitCode).toBe(2);
    await expect(
      `${JSON.stringify({ exitCode: run.exitCode }, null, 2)}\n${mask(run.stdout)}`,
    ).toMatchFileSnapshot(`../golden/cli-errors/${name}.json`);
  });
});
