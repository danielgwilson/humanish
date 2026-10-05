// `run` is the one runner, and `watch` takes the same run flags through one helper. --sims, --lanes,
// watch --follow and `lab run` are gone.
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CommanderError, type Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { lab } from "../admission/fixtures.js";

const RUN_FLAGS = ["--scorer", "--rerun-failed-from", "--participants"];

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

/** The participant count in the bundle a run or watch result points at. */
async function bundleCount(cwd: string, stdout: string): Promise<unknown> {
  const result = JSON.parse(stdout) as { runId?: string; run?: string };
  const runId = result.runId ?? result.run ?? "";
  const bundle = JSON.parse(
    await readFile(path.join(cwd, ".humanish", "runs", runId, "run.json"), "utf8"),
  ) as { simCount?: unknown };
  return bundle.simCount;
}

function subcommand(names: string[]): Command {
  let command: Command = createProgram();
  for (const name of names) {
    const next = command.commands.find((candidate) => candidate.name() === name);
    if (next === undefined) throw new Error(`missing command: ${names.join(" ")}`);
    command = next;
  }
  return command;
}

/** Every command in the tree with its path, hidden ones included. */
function allCommands(
  command: Command = createProgram(),
  names: string[] = [],
): Array<[string[], Command]> {
  return command.commands.flatMap((sub) => {
    const subNames = [...names, sub.name()];
    return [[subNames, sub] as [string[], Command], ...allCommands(sub, subNames)];
  });
}

const isHidden = (command: Command): boolean =>
  (command as unknown as { _hidden?: boolean })._hidden === true;

describe("--count on every command that starts a run", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-command-"));
    await cp(path.resolve("humanish"), path.join(cwd, "humanish"), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // first-run is a preview lab that declares 4 participants, so a count of 2 shows the override.
  it.each([
    ["run without a lab", ["run", "--dry-run"]],
    ["run <lab>", ["run", "first-run"]],
    ["watch without a lab", ["watch", "--detach", "--no-open"]],
    ["watch <lab>", ["watch", "first-run", "--detach", "--no-open"]],
  ])("%s sets the participant count", async (_name, command) => {
    const result = await runCli([...command, "--count", "2", "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(await bundleCount(cwd, result.stdout)).toBe(2);
  });

  it.each([
    ["run <lab>", ["run", "first-run"], 4],
    ["watch without a lab", ["watch", "--detach", "--no-open"], 4],
    ["run with an empty lab argument", ["run", "", "--dry-run"], 1],
  ])("%s without --count keeps its own count", async (_name, command, expected) => {
    const result = await runCli([...command, "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(0);
    expect(await bundleCount(cwd, result.stdout)).toBe(expected);
  });

  it.each([
    [["run", "--sims", "2"]],
    [["watch", "--sims", "2"]],
    [["watch", "--follow"]],
    [["run", "--app-url", "http://127.0.0.1:3000"]],
    [["run", "first-run", "--lanes", "lane-01"]],
  ])("%j is an unknown option now", async (args) => {
    const result = await runCli([...args, "--cwd", cwd, "--json"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^error: unknown option '--(sims|follow|lanes|app-url)'/);
  });
});

describe("run takes the rerun and scorer flags", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-run-command-"));
    await writeFile(path.join(cwd, "package.json"), '{ "name": "run-command-fixture" }\n');
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    const raw = lab("cuAppUrl", { participants: [{ id: "lane-01" }, { id: "lane-02" }] });
    await writeFile(
      path.join(cwd, "humanish", "studies", "fanout.yaml"),
      stringify({ ...raw, id: "fanout" }),
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each([[["run"]]])(
    "%j reaches the rerun check with --rerun-failed-from and --participants",
    async (names) => {
      const result = await runCli([
        ...names,
        "fanout",
        "--dry-run",
        "--rerun-failed-from",
        "latest",
        "--participants",
        "lane-02",
        "--cwd",
        cwd,
        "--json",
      ]);
      expect(result.exitCode).toBe(2);
      // No earlier run exists, so the selection reaches the rerun check and stops there.
      expect(JSON.parse(result.stdout).error.code).toBe("HUMANISH_COMPUTER_USE_RERUN_INVALID");
    },
  );

  it("refuses the lab-only flags on a run without a lab", async () => {
    const result = await runCli([
      "run",
      "--scorer",
      "s.mjs",
      "--participants",
      "a",
      "--cwd",
      cwd,
      "--json",
    ]);
    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stdout).error).toEqual({
      code: "HUMANISH_RUN_OPTION_CONFLICT",
      message: "--scorer, --participants need a study: humanish run <study>.",
    });
  });
});

describe("one runner", () => {
  it("gives run and watch the same run flags, with the same help text", () => {
    const flags = (names: string[]) =>
      new Map(subcommand(names).options.map((option) => [option.flags, option.description]));
    const run = flags(["run"]);
    const watch = flags(["watch"]);
    for (const [flag, description] of run) expect(watch.get(flag), flag).toBe(description);
  });

  it("registers --scorer, --rerun-failed-from and --participants on run and watch only, among visible commands", () => {
    const owners = allCommands()
      .filter(([, command]) => !isHidden(command))
      .filter(([, command]) =>
        command.options.some((option) => RUN_FLAGS.includes(option.long ?? "")),
      )
      .map(([names]) => names.join(" "));
    expect(owners.sort()).toEqual(["run", "watch"]);
  });
});
