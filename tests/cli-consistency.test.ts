import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";

// CLIG.dev, "Subcommands": be consistent across subcommands, and do not have ambiguous or
// similarly-named commands. `humanish run <lab>` and `humanish lab run <lab>` are the SAME
// operation on the same dispatcher — a participant reached for `humanish run … --no-open`, which
// its sibling accepts, and got a bare "unknown option".

function flagsOf(argv: readonly string[]): string[] {
  let command: any = createProgram({ writeOut: () => {}, writeErr: () => {}, setExitCode: () => {} });
  for (const name of argv) {
    command = command.commands.find((candidate: any) => candidate.name() === name);
    expect(command, `missing command: ${argv.join(" ")}`).toBeDefined();
  }
  return command.options.map((option: any) => option.long).filter(Boolean).sort();
}

describe("the two ways to run a lab agree", () => {
  it("every flag `humanish run` needs to share with `lab run` is present on both", () => {
    const run = new Set(flagsOf(["run"]));
    const labRun = new Set(flagsOf(["lab", "run"]));
    // The ones that mean the same thing on both. `lab run` also carries fan-out knobs (repos,
    // lanes, scorer) that are manifest-specific and genuinely do not belong on the short form.
    for (const shared of ["--cwd", "--dry-run", "--env-file", "--json", "--open", "--no-open", "--detach", "--port", "--run-id", "--sims"]) {
      expect(run.has(shared), `humanish run is missing ${shared}`).toBe(true);
      expect(labRun.has(shared), `humanish lab run is missing ${shared}`).toBe(true);
    }
  });

  it("says which one is the everyday command, so the pair is not ambiguous", () => {
    const program: any = createProgram({ writeOut: () => {}, writeErr: () => {}, setExitCode: () => {} });
    const run = program.commands.find((c: any) => c.name() === "run");
    const lab = program.commands.find((c: any) => c.name() === "lab");
    const labRun = lab.commands.find((c: any) => c.name() === "run");
    expect(run.description()).toContain("everyday");
    // The long form points at the short one rather than describing itself as a separate thing.
    expect(labRun.description()).toContain("humanish run");
  });
});

describe("every command a program might drive answers in JSON", () => {
  it("carries --json wherever there is a result to parse", () => {
    for (const argv of [["run"], ["runs"], ["verify"], ["review"], ["doctor"], ["init"], ["observe"], ["reclaim"], ["cleanup"]]) {
      expect(flagsOf(argv), `${argv.join(" ")} has no --json`).toContain("--json");
    }
  });

  it("carries --cwd wherever it acts on a project", () => {
    // An agent runs these from wherever it happens to be; --cwd is how it says where the project is.
    for (const argv of [["run"], ["runs"], ["verify"], ["review"], ["doctor"], ["init"], ["lab", "run"], ["lab", "list"]]) {
      expect(flagsOf(argv), `${argv.join(" ")} has no --cwd`).toContain("--cwd");
    }
  });
});
