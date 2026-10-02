import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Command, CommanderError } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT_HELP_EXAMPLES, createProgram } from "../../src/cli/program.js";

async function runCli(args: string[]) {
  let exitCode = 0;
  const out: string[] = [];
  const program = createProgram({
    writeOut: (text) => out.push(text),
    writeErr: (text) => out.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  // Subcommands copy settings when created, so override each one's exit, not just the root's.
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
  return { exitCode, output: out.join("") };
}

// Examples that cannot simply run to exit 0 in a test, and why. Every other example must.
const NOT_RUN: Record<string, string> = {
  "humanish observe --run latest --open": "serves the Observer until Ctrl-C",
  "humanish run try-live": "starts a live study on an E2B desktop",
  // Its exit code reports this machine's readiness; the lab it names must still exist.
  "humanish doctor --lab try-live": "readiness",
};

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("the root help's examples", () => {
  it("each pass on a freshly initialized project, in order", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-root-examples-"));
    for (const example of ROOT_HELP_EXAMPLES) {
      const args = [...example.split(" ").slice(1), "--cwd", dir];
      if (NOT_RUN[example] === "readiness") {
        const { output } = await runCli([...args, "--json"]);
        expect(output, example).not.toContain("HUMANISH_LAB_NOT_FOUND");
        continue;
      }
      if (NOT_RUN[example] !== undefined) continue;
      const { exitCode, output } = await runCli(args);
      expect({ example, exitCode }, output).toEqual({ example, exitCode: 0 });
    }
  });

  it("classifies every example it does not run", () => {
    for (const example of Object.keys(NOT_RUN))
      expect(ROOT_HELP_EXAMPLES as readonly string[]).toContain(example);
  });
});

describe("a mistyped command", () => {
  it("names the closest command in place of the help", async () => {
    const { exitCode, output } = await runCli(["verfy"]);
    expect(exitCode).toBe(1);
    expect(output).toBe("error: unknown command 'verfy'. Did you mean 'verify'?\n");
    expect((await runCli(["zzzz"])).output).toBe(
      "error: unknown command 'zzzz'. humanish --help lists the commands.\n",
    );
  });

  it("leaves subcommands strict about extra arguments", async () => {
    const { exitCode, output } = await runCli(["verify", "extra"]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain("too many arguments");
  });
});

describe("doctor's project rows", () => {
  it("say what they found, and a failing row names the command that fixes it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "humanish-doctor-rows-"));
    const before = await runCli(["doctor", "--cwd", dir, "--json"]);
    await runCli(["init", "--yes", "--cwd", dir]);
    const after = await runCli(["doctor", "--cwd", dir, "--json"]);
    const rows = (result: { output: string }) =>
      new Map(
        (
          JSON.parse(result.output.slice(result.output.indexOf("{"))) as {
            checks: { name: string; ok: boolean; message: string }[];
          }
        ).checks.map((check) => [check.name, check]),
      );
    const failed = rows(before),
      passed = rows(after);
    for (const name of ["humanish source", "runtime ignore"]) {
      expect(failed.get(name)?.ok, name).toBe(false);
      expect(passed.get(name)?.ok, name).toBe(true);
      expect(failed.get(name)?.message, name).toContain("run humanish init --yes");
    }
    // Every row whose verdict flipped says something different on each side.
    for (const [name, row] of failed)
      if (passed.has(name) && passed.get(name)!.ok !== row.ok)
        expect(passed.get(name)!.message, name).not.toBe(row.message);
  });
});
