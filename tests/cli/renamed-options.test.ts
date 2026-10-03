import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { lab } from "../admission/fixtures.js";

const SIMS_NOTE = "warning: --sims is deprecated and is removed in the next minor. Use --count.\n";
const LANES_NOTE =
  "warning: --lanes is deprecated and is removed in the next minor. Use --participants.\n";

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
  program.exitOverride();
  await program.parseAsync(["node", "humanish", ...args], { from: "node" });
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

describe("--count and its older spelling --sims", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-renamed-options-"));
    await cp(path.resolve("humanish"), path.join(cwd, "humanish"), { recursive: true });
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  // first-run is a preview lab that declares 4 participants, so a count of 2 shows the override.
  it.each([
    ["run without a lab", ["run", "--dry-run"]],
    ["run <lab>", ["run", "first-run"]],
    ["lab run", ["lab", "run", "first-run"]],
    ["watch without a lab", ["watch", "--detach", "--no-open"]],
    ["watch <lab>", ["watch", "first-run", "--detach", "--no-open"]],
  ])("%s takes either spelling, and --sims prints one note", async (_name, command) => {
    const count = await runCli([...command, "--count", "2", "--cwd", cwd, "--json"]);
    const sims = await runCli([...command, "--sims", "2", "--cwd", cwd, "--json"]);

    for (const result of [count, sims]) {
      expect(result.exitCode).toBe(0);
      expect(await bundleCount(cwd, result.stdout)).toBe(2);
    }
    expect(count.stderr).not.toContain("--sims");
    expect(sims.stderr.split(SIMS_NOTE)).toHaveLength(2);
  });

  it("names --count when --sims is not a positive integer", async () => {
    const sims = await runCli(["run", "--sims", "0", "--cwd", cwd, "--json"]);

    expect(sims.exitCode).toBe(2);
    expect(JSON.parse(sims.stdout).error).toEqual({
      code: "HUMANISH_INVALID_SIM_COUNT",
      message: "--count must be a positive integer.",
    });
    expect(sims.stderr).toBe(SIMS_NOTE);
  });

  it.each([[["run"]], [["lab", "run"]], [["watch"]]])("%j --help lists --count only", (names) => {
    const help = subcommand(names).helpInformation();
    expect(help).toContain("--count <count>");
    expect(help).not.toContain("--sims");
  });
});

describe("--participants and its older spelling --lanes", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-renamed-options-"));
    await writeFile(path.join(cwd, "package.json"), '{ "name": "renamed-options-fixture" }\n');
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    const raw = lab("cuAppUrl", {}, { lanes: [{ id: "lane-01" }, { id: "lane-02" }] });
    await writeFile(
      path.join(cwd, "humanish", "labs", "fanout.yaml"),
      stringify({ ...raw, id: "fanout" }),
    );
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const base = () => ["lab", "run", "fanout", "--dry-run", "--cwd", cwd, "--json"];

  it("reaches the rerun check from either spelling, and --lanes prints one note", async () => {
    const rerun = ["--rerun-failed-from", "latest"];
    const participants = await runCli([...base(), ...rerun, "--participants", "lane-02"]);
    const lanes = await runCli([...base(), ...rerun, "--lanes", "lane-02"]);

    for (const result of [participants, lanes]) {
      expect(result.exitCode).toBe(2);
      // No earlier run exists, so the selection reaches the rerun check and stops there.
      expect(JSON.parse(result.stdout).error.code).toBe("HUMANISH_COMPUTER_USE_RERUN_INVALID");
    }
    expect(participants.stderr).not.toContain("--lanes");
    expect(lanes.stderr.split(LANES_NOTE)).toHaveLength(2);
  });

  it("refuses --lanes without --rerun-failed-from, naming --participants", async () => {
    const lanes = await runCli([...base(), "--lanes", "lane-02"]);

    expect(lanes.exitCode).toBe(2);
    expect(lanes.stderr).toBe(`${LANES_NOTE}error: --participants requires --rerun-failed-from.\n`);
  });

  it("lab run --help lists --participants only", () => {
    const help = subcommand(["lab", "run"]).helpInformation();
    expect(help).toContain("--participants <ids>");
    expect(help).not.toContain("--lanes");
  });
});
