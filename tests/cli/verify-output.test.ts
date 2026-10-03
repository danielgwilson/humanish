// `humanish verify` in human mode: one line for a pass, only the failing checks for a failure, and
// every check under --verbose. The ratchet below holds each check to two different sentences: one
// for what a pass found and one for what a failure found, so a failing row never prints its rule.
import { CommanderError, type Command } from "commander";
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { verifyRun, type VerifyResult } from "../../src/verify/verify.js";

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  let exitCode = 0;
  const stdout: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: () => {},
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
  return { exitCode, stdout: stdout.join("") };
}

describe("humanish verify output", () => {
  let cwd: string;
  let runId: string;
  let runDir: string;
  let pristine: Map<string, string>;

  /** Applies `damage` to the run directory, runs `body`, then restores every file. */
  async function damaged<T>(damage: () => Promise<void>, body: () => Promise<T>): Promise<T> {
    await damage();
    try {
      return await body();
    } finally {
      for (const name of await readdir(runDir))
        if (!pristine.has(name) && name.endsWith(".json")) await unlink(path.join(runDir, name));
      for (const [name, text] of pristine) await writeFile(path.join(runDir, name), text);
    }
  }

  const editRunJson = (edit: (bundle: Record<string, unknown>) => void) => async () => {
    const file = path.join(runDir, "run.json");
    const bundle = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    edit(bundle);
    await writeFile(file, JSON.stringify(bundle));
  };

  beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-verify-output-"));
    expect((await runCli(["init", "--yes", "--cwd", cwd])).exitCode).toBe(0);
    expect((await runCli(["run", "first-run", "--cwd", cwd])).exitCode).toBe(0);
    runId = (await readdir(path.join(cwd, ".humanish", "runs"))).find((name) =>
      name.startsWith("dryrun-"),
    )!;
    runDir = path.join(cwd, ".humanish", "runs", runId);
    pristine = new Map();
    for (const name of ["run.json", "review.json", "review.md"])
      pristine.set(name, await readFile(path.join(runDir, name), "utf8"));
  }, 120_000);

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("prints one line for a pass, with latest resolved to the run id", async () => {
    const result = await runCli(["verify", "--cwd", cwd]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`verified ${runId} · share_ready · 16 checks passed\n`);
  });

  it("lists only the failing checks, each as what it found", async () => {
    const damage = async () => {
      await editRunJson((bundle) => {
        bundle.schema = "humanish.run-bundle.v0";
        (bundle.redaction as Record<string, unknown>).status = "pending";
      })();
      await unlink(path.join(runDir, "review.md"));
    };
    const result = await damaged(damage, () => runCli(["verify", "--cwd", cwd]));
    expect(result.exitCode).toBe(2);
    expect(result.stdout.split("\n")).toEqual([
      `verify failed: ${runId} · blocked · 4 of 16 checks failed`,
      "- run.json declares humanish.run-bundle.v0; verify reads humanish.run-bundle.v1",
      "- sections not checked, because the schema differs",
      "- redaction did not pass (status: pending)",
      "- review.md is missing",
      `every check: humanish verify --run ${runId} --cwd ${cwd} --verbose`,
      "",
    ]);
  });

  it("prints every check under --verbose", async () => {
    const result = await runCli(["verify", "--cwd", cwd, "--verbose"]);
    expect(result.stdout).toContain(`run: ${runId}\n`);
    expect(result.stdout).toContain("- ok run.json exists: run.json is present\n");
    expect(result.stdout.match(/^- ok /gm)).toHaveLength(16);
  });

  it("says a content check was not run when run.json fails its shape check", async () => {
    const result = await damaged(
      editRunJson((bundle) => delete bundle.events),
      () => verifyRun(cwd, runId),
    );
    const row = (name: string) => result.checks.find((check) => check.name === name);
    expect(row("run bundle shape")).toMatchObject({
      ok: false,
      message: "run.json is missing events",
    });
    for (const name of [
      "local evidence artifacts exist",
      "codex app-server evidence",
      "rerun lineage",
    ])
      expect(row(name), name).toMatchObject({
        ok: true,
        message: "not checked, because run.json failed the shape check",
      });
  });

  it("prints only the missing run, with no share-safety line", async () => {
    const result = await runCli(["verify", "--run", "nope", "--cwd", cwd]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toMatch(/^verify failed: .*nope.*\n$/);
    expect(result.stdout).not.toContain("share-safety");
  });

  it("gives every check that flips a different sentence on each side", async () => {
    const secret = ["ghp", "_", "a".repeat(30)].join("");
    const cleanup = async (ok: boolean | "malformed") => {
      expect((await runCli(["cleanup", "--cwd", cwd])).exitCode).toBe(0);
      const file = path.join(runDir, "cleanup.json");
      const receipt = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      if (ok === "malformed") delete receipt.schema;
      else receipt.ok = ok;
      await writeFile(file, JSON.stringify(receipt));
    };
    const damages: Array<() => Promise<void>> = [
      () => unlink(path.join(runDir, "run.json")),
      () => writeFile(path.join(runDir, "run.json"), "{"),
      editRunJson((bundle) => (bundle.schema = "humanish.run-bundle.v0")),
      editRunJson((bundle) => delete bundle.events),
      editRunJson((bundle) => (bundle.lifecycle = "wrong")),
      editRunJson((bundle) => ((bundle.redaction as Record<string, unknown>).status = "failed")),
      () => unlink(path.join(runDir, "review.md")),
      () => unlink(path.join(runDir, "review.json")),
      () => writeFile(path.join(runDir, "review.md"), `token ${secret}\n`),
      () => cleanup(false),
      () => cleanup("malformed"),
    ];
    const passing = await verifyRun(cwd, runId);
    expect(passing.ok).toBe(true);
    const passMessage = new Map(passing.checks.map((check) => [check.name, check.message]));
    const failMessages = new Map<string, Set<string>>();
    for (const damage of damages) {
      const failed: VerifyResult = await damaged(damage, () => verifyRun(cwd, runId));
      for (const check of failed.checks.filter((row) => !row.ok))
        failMessages.set(
          check.name,
          (failMessages.get(check.name) ?? new Set()).add(check.message),
        );
    }
    // The damages above flip these checks; a check that stops flipping drops out of the ratchet.
    expect([...failMessages.keys()].sort()).toEqual([
      "cleanup receipt",
      "local evidence artifacts exist",
      "public-safety scan",
      "redaction passed",
      "review artifacts exist",
      "run bundle shape",
      "run schema",
      "run.json exists",
    ]);
    for (const [name, messages] of failMessages)
      for (const message of messages) expect(message, name).not.toBe(passMessage.get(name));
  });
});
