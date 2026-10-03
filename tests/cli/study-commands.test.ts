// `humanish study` replaced `humanish lab`, and `--study` replaced `--lab`. 0.108.0 ran the old
// spellings after a warning; 0.109.0 removed them, so each fails as an unknown command or option.
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommanderError, type Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { launchRun } from "../../src/tui/launch.js";

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

describe("a humanish.lab.v2 file", () => {
  // humanish no longer reads it. run and watch refuse it by name, naming the command that converts
  // it, and write nothing.
  const message =
    "humanish/labs/old-run.yaml is a humanish.lab.v2 file in humanish/labs/, which humanish no longer reads. Run humanish migrate humanish/labs/old-run.yaml to convert it and move it to humanish/studies/.";
  beforeEach(async () => {
    const v2 = await readFile(path.resolve("tests/fixtures/labs-v2/first-run.yaml"), "utf8");
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "labs", "old-run.yaml"),
      v2.replace(/^id: first-run$/m, "id: old-run"),
    );
  });

  it.each([[["run", "old-run"]], [["watch", "old-run", "--detach", "--no-open"]]])(
    "%j --json refuses it with HUMANISH_STUDY_V2_UNSUPPORTED",
    async (words) => {
      const result = await runCli([...words, "--cwd", cwd, "--json"]);
      expect(result.exitCode).toBe(2);
      expect((JSON.parse(result.stdout) as { error: unknown }).error).toEqual({
        code: "HUMANISH_STUDY_V2_UNSUPPORTED",
        message,
      });
      await expect(readdir(path.join(cwd, ".humanish", "runs"))).rejects.toThrow(/ENOENT/);
    },
  );

  it("reaches doctor --study, comms check and the TUI's launch with its fix", async () => {
    const doctor = JSON.parse(
      (await runCli(["doctor", "--study", "old-run", "--cwd", cwd, "--json"])).stdout,
    ) as {
      checks: { ok: boolean; message: string }[];
    };
    expect(doctor.checks.some((check) => !check.ok && check.message.includes(message))).toBe(true);

    const comms = await runCli(["comms", "check", "--study", "old-run", "--cwd", cwd, "--json"]);
    expect(comms.exitCode).toBe(2);
    expect((JSON.parse(comms.stdout) as { message: string }).message).toBe(message);

    const launched = await launchRun({
      cwd,
      study: "old-run",
      manifestPath: "humanish/labs/old-run.yaml",
      mode: "dry-run",
      spawn: (() => ({ pid: 1, unref() {}, on() {} })) as never,
    });
    expect(!launched.ok && launched.error).toEqual({
      code: "HUMANISH_LAUNCH_INVALID_STUDY",
      message,
    });
  });

  it("prints the refusal and its code on stderr in human mode", async () => {
    const result = await runCli(["run", "old-run", "--cwd", cwd]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `humanish run failed: ${message}\ncode: HUMANISH_STUDY_V2_UNSUPPORTED\n`,
    );
  });
});

describe("a study file's warnings", () => {
  it("reach run --json warnings[] as well as stderr", async () => {
    // A .yml name is accepted with a warning; run and watch queue it into their JSON result.
    await rename(
      path.join(cwd, "humanish", "studies", "first-run.yaml"),
      path.join(cwd, "humanish", "studies", "first-run.yml"),
    );
    const warning = "Prefer .yaml for study files; .yml is accepted for compatibility only.";
    const result = await runCli(["run", "first-run", "--no-open", "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`warning: ${warning}\n`);
    expect((JSON.parse(result.stdout) as { warnings: string[] }).warnings).toContain(warning);
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
