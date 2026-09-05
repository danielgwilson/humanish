import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { createProgram } from "../src/program.js";

// #513: humanish.dev/llms.txt documented four commands while the CLI shipped eighteen. The whole
// premise of this product is that a coding agent sets it up for someone, and llms.txt is the
// surface those agents read. Missing from it were the entire `lab` system, which is how anything
// real is run, and `tui`, which is the human surface an agent is supposed to hand off to.
//
// This test builds the command table from the program itself, so the file cannot silently drift
// as commands are added.

/** Commands that are deliberately absent from llms.txt, each with the reason. */
const INTENTIONALLY_OMITTED = new Map<string, string>([
  ["help", "commander's built-in, not ours"],
  ["humanish", "the root command is the binary name, not an entry"],
  ["lab oss", "maintainer-only meta-lab alias"],
  ["lab oss-smoke", "maintainer-only smoke harness"]
]);

function walk(command: Command, trail: string[] = []): string[] {
  const names: string[] = [];
  for (const child of command.commands) {
    const here = [...trail, child.name()];
    const isGroup = child.commands.length > 0;
    // A pure group (`feedback`, `keys`) is documented through its subcommands, so only leaves
    // and groups that are themselves runnable need an entry.
    if (!isGroup) names.push(here.join(" "));
    names.push(...walk(child, here));
    if (isGroup) names.push(here.join(" "));
  }
  return names;
}

describe("llms.txt documents the CLI that actually ships (#513)", () => {
  it("mentions every command and subcommand", async () => {
    const text = await readFile(
      path.resolve(import.meta.dirname, "..", "site", "public", "llms.txt"),
      "utf8"
    );
    const program = createProgram({});
    const all = walk(program).filter((name) => !INTENTIONALLY_OMITTED.has(name));

    // Sanity: a broken walk must not vacuously pass.
    expect(all.length).toBeGreaterThan(15);

    const missing = all.filter((name) => !text.includes(`humanish ${name}`));
    expect(missing).toEqual([]);
  });

  it("names both credentials a live study needs, and how to set each", async () => {
    const text = await readFile(
      path.resolve(import.meta.dirname, "..", "site", "public", "llms.txt"),
      "utf8"
    );
    // Three live last-mile runs showed agents reaching these two facts by exploration. Stating
    // them is the cheapest thing we can do for the last mile.
    expect(text).toContain("E2B_API_KEY");
    expect(text).toContain("OPENAI_API_KEY");
    expect(text).toContain("humanish keys set e2b");
    expect(text).toContain("humanish doctor");
  });

  it("tells an agent that tui is for a human", async () => {
    const text = await readFile(
      path.resolve(import.meta.dirname, "..", "site", "public", "llms.txt"),
      "utf8"
    );
    // #495 measured an agent handed a human-shaped job and neither half of the handoff worked.
    const tuiRow = text.split("\n").find((line) => line.startsWith("- `humanish tui`:"))!;
    expect(tuiRow).toMatch(/human/i);
    expect(tuiRow).toMatch(/refuses detected agent sessions/i);
    expect(tuiRow).toContain("non-TTY");
    for (const command of ["humanish lab list --json", "humanish lab inspect <lab> --json", "humanish runs --json"]) {
      expect(tuiRow).toContain(command);
    }
    expect(text).toContain("HUMANISH_TUI_AGENT_SESSION");
    expect(text).toContain("HUMANISH_TUI_REQUIRES_TTY");
  });
});
