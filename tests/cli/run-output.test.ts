import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Command, CommanderError } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { analysisOutcomeText } from "../../src/cli/io.js";
import { runNotFoundMessage } from "../../src/run/run-not-found.js";

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

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});
const freshProject = async () => (dir = await mkdtemp(path.join(tmpdir(), "humanish-run-output-")));

describe("a run's review in human mode", () => {
  it("prints the verdict, summary, gaps and path, not JSON", async () => {
    const cwd = await freshProject();
    await runCli(["init", "--yes", "--cwd", cwd]);
    await runCli(["run", "first-run", "--cwd", cwd]);
    const { exitCode, output } = await runCli(["review", "--cwd", cwd]);
    expect(exitCode).toBe(0);
    expect(output).toMatch(
      /^humanish review dryrun-\S+: no verdict; no product behavior was tested\n/,
    );
    expect(output).toContain("\ngaps:\n- No browser was launched.\n");
    expect(output).toMatch(/\nreview: \.humanish\/runs\/dryrun-\S+\/review\.json\n$/);
    expect(output).not.toContain("{");
  });
});

describe("a run that is not there", () => {
  it("says how to start one in an empty project, and how to list them otherwise", async () => {
    const cwd = await freshProject();
    expect(await runNotFoundMessage(cwd, "latest")).toBe(
      `No runs in ${cwd} yet; start one with humanish run first-run.`,
    );
    const verify = await runCli(["verify", "--run", "nope", "--cwd", cwd]);
    expect(verify.output).toContain(
      `No runs in ${cwd} yet; start one with humanish run first-run.`,
    );
    await runCli(["init", "--yes", "--cwd", cwd]);
    expect((await runCli(["run", "first-run", "--cwd", cwd])).exitCode).toBe(0);
    expect(await runNotFoundMessage(cwd, "nope")).toBe("No run nope; humanish runs lists them.");
  });

  it("is built in one place", async () => {
    const offenders: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(file);
        else if (file.endsWith(".ts") && (await readFile(file, "utf8")).includes("Run not found:"))
          offenders.push(file);
      }
    };
    await walk("src");
    expect(offenders).toEqual([]);
  });
});

describe("lab run output", () => {
  it("names the command that ran, never a `humanish lab <route>` command that does not exist", async () => {
    const source = await readFile("src/cli/commands/lab-format.ts", "utf8");
    expect(
      source.match(/`humanish lab (cua|terminal|scripted|concurrent-shared-world) /g),
    ).toBeNull();
  });

  it("says what bare `humanish run` needs and where to go next", async () => {
    const cwd = await freshProject();
    const { exitCode, output } = await runCli(["run", "--cwd", cwd]);
    expect(exitCode).toBe(2);
    expect(output).toContain(
      "humanish run needs a lab. List labs with humanish lab list, or run humanish run --dry-run for a sample bundle.",
    );
  });
});

describe("the automatic analysis line", () => {
  it("has a sentence for every reason the analysis records", async () => {
    const reasons = new Set<string>();
    for (const name of await readdir("src/analysis"))
      if (name.endsWith(".ts"))
        for (const match of (await readFile(path.join("src/analysis", name), "utf8")).matchAll(
          /"(AUTOMATIC_ANALYSIS_[A-Z_]+)"/g,
        ))
          reasons.add(match[1]!);
    expect(reasons.size).toBeGreaterThan(15);
    for (const reason of reasons)
      expect(analysisOutcomeText({ state: "skipped", reason }), reason).not.toContain(reason);
    expect(analysisOutcomeText({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_DRY_RUN" })).toBe(
      "skipped for dry runs",
    );
    // An unmapped reason still prints, with its state.
    expect(analysisOutcomeText({ state: "failed", reason: "SOMETHING_NEW" })).toBe(
      "failed (SOMETHING_NEW)",
    );
  });
});
