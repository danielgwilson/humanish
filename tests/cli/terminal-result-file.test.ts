import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { type Command, CommanderError } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { createProgram } from "../../src/cli/program.js";
import { lab } from "../admission/fixtures.js";

// A remote run's launcher waits for the runner's `watch --result-file` to write the run's result,
// so every route the runner can run has to write it.
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-terminal-result-file-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function watch(args: string[]): Promise<number> {
  let exitCode = 0;
  const program = createProgram({
    writeOut: () => undefined,
    writeErr: () => undefined,
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
    await program.parseAsync(["node", "humanish", "watch", ...args, "--cwd", cwd], {
      from: "node",
    });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    exitCode = error.exitCode;
  }
  return exitCode;
}

describe("watch --result-file on a terminal study", () => {
  it("writes the run's exit code and result for the launcher", async () => {
    const raw = lab("terminal", {});
    await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
    await writeFile(
      path.join(cwd, "humanish", "studies", `${String(raw.id)}.yaml`),
      stringify(raw),
    );
    const file = path.join(cwd, "result.json");
    const exitCode = await watch([String(raw.id), "--dry-run", "--json", "--result-file", file]);
    const written = JSON.parse(await readFile(file, "utf8")) as {
      exitCode: number;
      result: { route: string; ok: boolean; runId: string };
    };
    expect(written.exitCode).toBe(exitCode);
    expect(written.result).toMatchObject({ route: "terminal", ok: true });
    expect(written.result.runId).toMatch(/^terminal-/);
  });
});
