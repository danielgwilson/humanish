// `observe` is the one viewer: one run by default, the run library with --all. 0.109.0 removed
// `serve` and `watch --run`, which 0.108.0 kept as deprecated aliases.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommanderError, type Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

async function runCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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

const help = (name: string): string =>
  createProgram()
    .commands.find((command) => command.name() === name)!
    .helpInformation();

describe("one viewer", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-one-viewer-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("refuses serve and watch --run, and points serve at observe", async () => {
    const serve = await runCli(["serve", "--cwd", cwd, "--json"]);
    expect(serve.exitCode).toBe(1);
    expect(serve.stderr).toContain("error: unknown command 'serve'. Did you mean 'observe'?");
    expect(serve.stdout).toBe("");
    const watch = await runCli(["watch", "--run", "latest", "--cwd", cwd, "--json"]);
    expect(watch.exitCode).toBe(1);
    expect(watch.stderr).toContain("error: unknown option '--run'");
    expect(watch.stdout).toBe("");
  });

  it("refuses the library flags on a one-run observe", async () => {
    const result = await runCli(["observe", "--safe", "--expose", "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "HUMANISH_OBSERVE_OPTION_CONFLICT",
      message: "--safe, --expose need --all: humanish observe --all --safe --expose.",
    });
  });

  it("keeps serve and watch --run out of help, and lists observe --all", () => {
    const root = createProgram().helpInformation();
    expect(root).not.toMatch(/^\s+serve\b/m);
    expect(root).toMatch(/^\s+observe\b/m);
    expect(help("watch")).not.toContain("--run <id>");
    expect(help("observe")).toContain("--all");
  });
});
