// `observe` is the one viewer: one run by default, the run library with --all. `serve` is a hidden
// alias of `observe --all` for one minor, and `watch --run` a hidden, deprecated option.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommanderError, type Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

const SERVE_NOTE =
  "warning: humanish serve is deprecated and is removed in the next minor. Use humanish observe --all.\n";
const WATCH_RUN_NOTE =
  "warning: humanish watch --run is deprecated and is removed in the next minor. Use humanish observe --run <id>.\n";

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

  // An invalid port fails before any server binds, so these calls return.
  it("runs serve as observe --all, with one note on stderr and in warnings", async () => {
    const args = ["--port", "99999", "--cwd", cwd, "--json"];
    const observe = await runCli(["observe", "--all", ...args]);
    const serve = await runCli(["serve", ...args]);
    expect(observe.exitCode).toBe(2);
    const expected = JSON.parse(observe.stdout) as { error: { code: string }; warnings: string[] };
    expect(expected.error.code).toBe("HUMANISH_INVALID_PORT");
    expect(serve.exitCode).toBe(observe.exitCode);
    expect(serve.stderr).toBe(SERVE_NOTE);
    expect(JSON.parse(serve.stdout)).toEqual({
      ...expected,
      warnings: [SERVE_NOTE.slice("warning: ".length, -1), ...expected.warnings],
    });
  });

  it("refuses the library flags on a one-run observe", async () => {
    const result = await runCli(["observe", "--safe", "--expose", "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "HUMANISH_OBSERVE_OPTION_CONFLICT",
      message: "--safe, --expose need --all: humanish observe --all --safe --expose.",
    });
  });

  it("prints the watch --run deprecation once", async () => {
    const result = await runCli([
      "watch",
      "--run",
      "latest",
      "--port",
      "99999",
      "--cwd",
      cwd,
      "--json",
    ]);
    expect(result.stderr).toBe(WATCH_RUN_NOTE);
    expect(JSON.parse(result.stdout).error.code).toBe("HUMANISH_INVALID_PORT");
  });

  it("keeps serve and watch --run out of help, and lists observe --all", () => {
    const root = createProgram().helpInformation();
    expect(root).not.toMatch(/^\s+serve\b/m);
    expect(root).toMatch(/^\s+observe\b/m);
    expect(help("watch")).not.toContain("--run <id>");
    expect(help("observe")).toContain("--all");
  });
});
