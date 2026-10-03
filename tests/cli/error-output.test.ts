// Failing commands. In --json mode each prints the exact JSON and exit code pinned here byte for
// byte, with the project path masked. In human mode the error goes to stderr in one shape,
// "<command> failed: <message>", "code: <CODE>" and a "next:" command when one is known, and
// stdout carries no error code.
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
// The command path is the first `depth` arguments.
const FAILURES: ReadonlyArray<readonly [name: string, args: string[], depth: number]> = [
  ["verify-missing-run", ["verify", "--run", "nope"], 1],
  ["review-missing-run", ["review", "--run", "nope"], 1],
  ["cleanup-missing-run", ["cleanup", "--run", "nope"], 1],
  ["export-missing-run", ["export", "--run", "nope"], 1],
  ["feedback-missing-run", ["feedback", "draft", "--run", "nope"], 2],
  ["run-missing-lab", ["run", "nope-lab"], 1],
  ["run-bad-count", ["run", "--count", "0"], 1],
  ["lab-inspect-missing", ["lab", "inspect", "nope-lab"], 2],
  ["stats-bad-since", ["stats", "--since", "last tuesday"], 1],
  ["observe-bad-port", ["observe", "--port", "99999"], 1],
  ["serve-bad-port", ["serve", "--port", "99999"], 1],
  ["doctor-missing-env-file", ["doctor", "--env-file", "missing.env"], 1],
  ["verify-verbose-missing-run", ["verify", "--run", "nope", "--verbose"], 1],
  ["analyze-bad-timeout", ["analyze", "--timeout-ms", "0"], 1],
  ["keys-set-bad-name", ["keys", "set", "bad-name"], 2],
  ["comms-check-missing-lab", ["comms", "check", "--lab", "nope-lab"], 2],
];

// keys acts on the user key store, not a project, so it takes no --cwd.
const NO_CWD = new Set(["keys-set-bad-name"]);
const withCwd = (name: string, args: string[], cwd: string) =>
  NO_CWD.has(name) ? args : [...args, "--cwd", cwd];

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

  const savedConfigHome = process.env.XDG_CONFIG_HOME;

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-error-output-"));
    physical = await realpath(cwd);
    // keys reports the user store path; keep it inside the masked project.
    process.env.XDG_CONFIG_HOME = path.join(cwd, "user-config");
    for (const [name, args] of FAILURES)
      runs.set(name, await runCli([...withCwd(name, args, cwd), "--json"]));
  });

  afterAll(async () => {
    if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedConfigHome;
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(FAILURES)("%s prints its error on stderr in human mode", async (name, args, depth) => {
    // keys and comms results carry a message and no error code.
    const json = JSON.parse(runs.get(name)!.stdout) as {
      message?: string;
      error?: { code: string; message: string };
    };
    const human = await runCli(withCwd(name, args, cwd));
    expect(human.exitCode).toBe(2);
    const label = `humanish ${args.slice(0, depth).join(" ")}`;
    const message = json.error?.message ?? json.message ?? "";
    const code = json.error === undefined ? "" : `code: ${json.error.code}\n`;
    expect(human.stderr).toContain(`${label} failed: ${message}\n${code}`);
    expect(human.stdout).not.toContain(message);
  });

  it("names the next command for an error whose message does not", async () => {
    const human = await runCli(["run", "nope-lab", "--cwd", cwd]);
    expect(human.stderr).toBe(
      "humanish run failed: Lab not found: nope-lab. Look in humanish/studies/ or humanish/labs/, or pass a .yaml path.\ncode: HUMANISH_STUDY_NOT_FOUND\nnext: humanish lab list\n",
    );
    expect(human.stdout).toBe("");
  });

  it.each(FAILURES.map(([name]) => name))("%s keeps its JSON and exit code", async (name) => {
    const run = runs.get(name)!;
    expect(run.exitCode).toBe(2);
    await expect(
      `${JSON.stringify({ exitCode: run.exitCode }, null, 2)}\n${mask(run.stdout)}`,
    ).toMatchFileSnapshot(`../golden/cli-errors/${name}.json`);
  });
});
