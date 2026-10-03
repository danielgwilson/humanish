// `humanish study` replaced `humanish lab`, and `--study` replaced `--lab`. 0.108.0 ran the old
// spellings after a warning; 0.109.0 removed them, so each fails as an unknown command or option.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommanderError, type Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-study-commands-"));
  await writeFile(path.join(cwd, "package.json"), '{ "name": "study-commands-fixture" }\n');
  await cp(path.resolve("humanish", "studies"), path.join(cwd, "humanish", "studies"), {
    recursive: true,
  });
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("the lab group", () => {
  it.each([
    [["lab", "list"]],
    [["lab", "inspect", "first-run"]],
    [["lab", "preflight", "first-run"]],
    [["lab", "run", "first-run"]],
  ])("%j is an unknown command", async (words) => {
    const result = await runCli([...words, "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error: unknown command 'lab'");
    expect(result.stdout).toBe("");
  });

  it("is gone from the root help, which lists study", () => {
    const help = createProgram().helpInformation();
    expect(help).toMatch(/^ {2}study {2,}List, show and check studies/m);
    expect(help).not.toMatch(/^ {2}lab\b/m);
    expect(createProgram().commands.some((command) => command.name() === "lab")).toBe(false);
  });
});

describe("a study file's warnings", () => {
  // A v2 file under labs/ warns about 0.109; run and watch put that warning in their JSON too.
  const migrateLine =
    "humanish/labs/old-run.yaml is a humanish.lab.v2 file in humanish/labs/, and 0.109 reads neither. Run humanish migrate to convert it and move it to humanish/studies/.";
  beforeEach(async () => {
    const v2 = await readFile(path.resolve("tests/fixtures/labs-v2/first-run.yaml"), "utf8");
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "labs", "old-run.yaml"),
      v2.replace(/^id: first-run$/m, "id: old-run"),
    );
  });

  it.each([[["run", "old-run"]], [["watch", "old-run", "--detach", "--no-open"]]])(
    "%j --json puts the v2 warning in warnings and on stderr",
    async (words) => {
      const result = await runCli([...words, "--cwd", cwd, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain(`warning: ${migrateLine}\n`);
      expect((JSON.parse(result.stdout) as { warnings: string[] }).warnings).toContain(migrateLine);
    },
  );

  it("prints the v2 warning once in human mode, on stderr and not on stdout", async () => {
    const result = await runCli(["run", "old-run", "--cwd", cwd]);
    expect(result.stderr.split(`warning: ${migrateLine}\n`)).toHaveLength(2);
    expect(result.stdout).not.toContain(migrateLine);
  });
});

describe("--lab", () => {
  it.each([[["doctor"]], [["stats"]], [["comms", "check"]], [["watch", "--detach", "--no-open"]]])(
    "%j --lab is an unknown option",
    async (words) => {
      const result = await runCli([...words, "--lab", "first-run", "--cwd", cwd, "--json"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("error: unknown option '--lab'");
      expect(result.stdout).toBe("");
    },
  );

  it("keeps comms configure's --study required", async () => {
    const neither = await runCli(["comms", "configure", "--cwd", cwd, "--json"]);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain("error: required option '--study <path>' not specified\n");
  });

  it("is absent from each command's help", () => {
    const program = createProgram();
    const find = (words: string[]) =>
      words.reduce<Command>(
        (command, word) => command.commands.find((child) => child.name() === word)!,
        program,
      );
    for (const words of [
      ["doctor"],
      ["stats"],
      ["comms", "check"],
      ["comms", "configure"],
      ["watch"],
    ]) {
      const help = find(words).helpInformation();
      expect(help).toContain("--study");
      expect(help).not.toContain("--lab");
    }
  });
});
