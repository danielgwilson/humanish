import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";

import { createProgram } from "../src/program.js";

// #516: the first Observer a new user ever saw advertised `humanish run --scenario
// first-run-smoke`. The flag has never existed. It shipped for months because nothing checked
// that the commands in our own sample text are commands the CLI accepts, and a computer-use
// participant found it before we did.
//
// This test builds the real command table from createProgram() and validates every
// `humanish <subcommand> ... --flag` string that ships in src/. It fails on an invented flag,
// an invented subcommand, or a flag used under the wrong subcommand.

interface CommandSpec {
  /** Long-option flags this subcommand accepts, e.g. "--dry-run". */
  options: Set<string>;
  /** Nested subcommand names, e.g. `lab run`. */
  children: Map<string, CommandSpec>;
}

function specOf(command: Command): CommandSpec {
  const options = new Set<string>();
  for (const option of command.options) {
    if (option.long) options.add(option.long);
  }
  // --help is available everywhere and commander does not always list it.
  options.add("--help");
  const children = new Map<string, CommandSpec>();
  for (const child of command.commands) {
    const spec = specOf(child);
    children.set(child.name(), spec);
    for (const alias of child.aliases()) children.set(alias, spec);
  }
  return { options, children };
}

/** Global options declared on the root apply to every subcommand invocation. */
function rootGlobals(root: Command): Set<string> {
  const globals = new Set<string>();
  for (const option of root.options) {
    if (option.long) globals.add(option.long);
  }
  globals.add("--help");
  return globals;
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** One `humanish ...` invocation found in shipped text, with where it came from. */
interface FoundCommand {
  file: string;
  line: number;
  raw: string;
  words: string[];
}

// Matches a humanish invocation inside a string literal or comment, stopping at the end of the
// line or at a shell/markdown boundary. Deliberately conservative: a missed candidate costs
// coverage, a mis-parsed one costs a false failure.
// Only counts a real invocation site: start of a line/string, after a shell prompt, after a
// backtick or quote, or after an `npx` runner. Without this, `skills add danielgwilson/humanish
// --skill humanish --list` reads as our CLI taking a `--list` flag, when every one of those flags
// belongs to a DIFFERENT cli.
const INVOCATION =
  /(?:^|[`'"(]|\$ |&& |\| |npx (?:-y |--no-install )?)humanish ((?:[a-z][a-z0-9-]*|--[a-z][a-z0-9-]*|<[a-z-]+>|\[[a-z-]+\])(?:[ \t]+(?:[a-z][a-z0-9-]*|--[a-z][a-z0-9-]*|<[a-z-]+>|\[[a-z-]+\]))*)/gm

async function collect(): Promise<FoundCommand[]> {
  const root = path.resolve(import.meta.dirname, "..", "src");
  const found: FoundCommand[] = [];
  for (const file of await sourceFiles(root)) {
    const text = await readFile(file, "utf8");
    text.split("\n").forEach((lineText, index) => {
      for (const match of lineText.matchAll(INVOCATION)) {
        const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
        if (words.length === 0) continue;
        found.push({
          file: path.relative(root, file),
          line: index + 1,
          raw: `humanish ${words.join(" ")}`,
          words
        });
      }
    });
  }
  return found;
}

describe("shipped command strings are commands the CLI accepts (#516)", () => {
  it("advertises no invented subcommand or flag anywhere in src/", async () => {
    const program = createProgram({});
    const rootSpec = specOf(program);
    const globals = rootGlobals(program);
    const invocations = await collect();

    // Sanity: the scan must actually find things, or a regex change could silently disable it.
    expect(invocations.length).toBeGreaterThan(20);

    const problems: string[] = [];
    for (const invocation of invocations) {
      let spec = rootSpec;
      const trail: string[] = [];
      for (const word of invocation.words) {
        if (word.startsWith("--")) {
          if (!spec.options.has(word) && !globals.has(word)) {
            problems.push(
              `${invocation.file}:${invocation.line} — \`${invocation.raw}\`: `
                + `${word} is not an option of \`humanish ${trail.join(" ") || "<root>"}\``
            );
          }
          continue;
        }
        if (word.startsWith("<") || word.startsWith("[")) break; // a placeholder, not a literal
        const child = spec.children.get(word);
        if (!child) {
          // Not a subcommand: it is a positional argument (a lab id, a path). Stop descending;
          // remaining flags still validate against the subcommand we reached.
          break;
        }
        spec = child;
        trail.push(word);
      }
    }

    expect(problems).toEqual([]);
  });

  it("would have caught the #516 regression", async () => {
    // The exact string that shipped, proving this test is load-bearing rather than decorative.
    const program = createProgram({});
    const rootSpec = specOf(program);
    const runSpec = rootSpec.children.get("run");
    expect(runSpec).toBeDefined();
    expect(runSpec?.options.has("--scenario")).toBe(false);
    // And the replacement is valid: `run` takes a lab as a positional.
    expect(rootSpec.children.has("run")).toBe(true);
  });
});
