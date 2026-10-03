import { describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";

// Clig.dev, "Subcommands": be consistent across subcommands, and do not have ambiguous or
// similarly-named commands. `humanish lab run <lab>` is a hidden alias of `humanish run <lab>` for
// one minor; both register their flags through one helper (src/cli/commands/run-command.ts).

function flagsOf(argv: readonly string[]): string[] {
  let command: any = createProgram({
    writeOut: () => {},
    writeErr: () => {},
    setExitCode: () => {},
  });
  for (const name of argv) {
    command = command.commands.find((candidate: any) => candidate.name() === name);
    expect(command, `missing command: ${argv.join(" ")}`).toBeDefined();
  }
  return command.options
    .map((option: any) => option.long)
    .filter(Boolean)
    .sort();
}

describe("the hidden lab run alias", () => {
  it("takes exactly the flags of humanish run", () => {
    expect(flagsOf(["lab", "run"])).toEqual(flagsOf(["run"]));
  });
});

describe("every command a program might drive answers in JSON", () => {
  it("carries --json wherever there is a result to parse", () => {
    for (const argv of [
      ["run"],
      ["runs"],
      ["verify"],
      ["review"],
      ["doctor"],
      ["init"],
      ["observe"],
      ["reclaim"],
      ["cleanup"],
    ]) {
      expect(flagsOf(argv), `${argv.join(" ")} has no --json`).toContain("--json");
    }
  });

  it("carries --cwd wherever it acts on a project", () => {
    // An agent runs these from wherever it happens to be; --cwd is how it says where the project is.
    for (const argv of [
      ["run"],
      ["runs"],
      ["verify"],
      ["review"],
      ["doctor"],
      ["init"],
      ["lab", "run"],
      ["lab", "list"],
    ]) {
      expect(flagsOf(argv), `${argv.join(" ")} has no --cwd`).toContain("--cwd");
    }
  });
});
