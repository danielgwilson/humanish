// `humanish study` replaces `humanish lab`, and `--study` replaces `--lab`. The old spellings run for
// one minor. Each prints one warning on stderr and puts the same message first in the JSON
// result's `warnings`, so a caller reading only stdout sees it.
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

const deprecation = (old: string, replacement: string): string =>
  `${old} is deprecated and is removed in the next minor. Use ${replacement}.`;

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

/** The old spelling gives the new one's result, with one warning on stderr and in `warnings`. */
async function expectSameWithWarning(current: string[], old: string[], message: string) {
  const now = await runCli([...current, "--cwd", cwd, "--json"]);
  const before = await runCli([...old, "--cwd", cwd, "--json"]);
  const result = JSON.parse(now.stdout) as { warnings?: string[] };
  expect(before.exitCode).toBe(now.exitCode);
  expect(before.stderr).toBe(`warning: ${message}\n${now.stderr}`);
  // A result without a warnings array gains one.
  expect(JSON.parse(before.stdout)).toEqual({
    ...result,
    warnings: [message, ...(result.warnings ?? [])],
  });
}

describe("the lab group", () => {
  it.each([
    [["study", "list"], ["lab", "list"], "humanish study list"],
    [
      ["study", "show", "first-run"],
      ["lab", "inspect", "first-run"],
      "humanish study show <study>",
    ],
    [
      ["study", "check", "first-run"],
      ["lab", "preflight", "first-run"],
      "humanish study check <study>",
    ],
  ])("%j: the old command gives the same result after a warning", async (current, old, use) => {
    await expectSameWithWarning(
      current,
      old,
      deprecation(`humanish ${old.slice(0, 2).join(" ")}`, use),
    );
  });

  it("is hidden from the root help, which lists study", () => {
    const help = createProgram().helpInformation();
    expect(help).toMatch(/^ {2}study {2,}List, show and check studies/m);
    expect(help).not.toMatch(/^ {2}lab\b/m);
  });

  it("names each replacement in lab --help", () => {
    const lab = createProgram().commands.find((command) => command.name() === "lab")!;
    expect(lab.helpInformation()).toContain("Deprecated: use humanish study list.");
    expect(lab.helpInformation()).toContain("Deprecated: use humanish study show <study>.");
    expect(lab.helpInformation()).toContain("Deprecated: use humanish study check <study>.");
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
  it.each([
    [["doctor"], "doctor"],
    [["stats"], "stats"],
    [["comms", "check"], "comms check"],
    [["comms", "configure"], "comms configure"],
  ])("%j --lab gives the --study result after a warning", async (words, name) => {
    await expectSameWithWarning(
      [...words, "--study", "first-run"],
      [...words, "--lab", "first-run"],
      deprecation(`humanish ${name} --lab`, `humanish ${name} --study <study>`),
    );
  });

  it("starts watch's study after a warning", async () => {
    const message = deprecation("humanish watch --lab", "humanish watch --study <study>");
    const watch = await runCli([
      "watch",
      "--lab",
      "first-run",
      "--detach",
      "--no-open",
      "--cwd",
      cwd,
      "--json",
    ]);
    expect(watch.exitCode).toBe(0);
    expect(watch.stderr.split(`warning: ${message}\n`)).toHaveLength(2);
    const result = JSON.parse(watch.stdout) as { warnings: string[]; bundlePath: string };
    expect(result.warnings[0]).toBe(message);
    const bundle = JSON.parse(await readFile(path.join(cwd, result.bundlePath), "utf8")) as {
      lab?: { id?: string };
    };
    expect(bundle.lab?.id).toBe("first-run");
  });

  it("is refused together with --study", async () => {
    const both = await runCli(["doctor", "--study", "first-run", "--lab", "first-run"]);
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain("cannot be used with option '--study <study>'");
  });

  it("keeps comms configure's source required under either spelling", async () => {
    const neither = await runCli(["comms", "configure", "--cwd", cwd, "--json"]);
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain("error: required option '--study <path>' not specified\n");
  });

  it("is hidden from each command's help", () => {
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
