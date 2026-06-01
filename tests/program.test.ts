import { CommanderError } from "commander";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram } from "../src/program.js";

interface CliResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function runCli(args: string[]): Promise<CliResult> {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    }
  });

  program.exitOverride();

  try {
    await program.parseAsync(["node", "mimetic", ...args], { from: "node" });
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      return {
        exitCode: 0,
        stderr: stderr.join(""),
        stdout: stdout.join("")
      };
    }

    throw error;
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join("")
  };
}

async function withTempApp<T>(
  files: Record<string, string>,
  callback: (cwd: string) => Promise<T>
): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "mimetic-init-test-"));

  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const filePath = path.join(cwd, relativePath);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, contents, "utf8");
    }

    return await callback(cwd);
  } finally {
    await rm(cwd, { force: true, recursive: true });
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

describe("mimetic CLI scaffold", () => {
  it("prints useful Commander help", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic [options] [command]");
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("feedback");
    expect(result.stdout).toContain("Public-safety boundary");
  });

  it("plans init changes without mutating files during JSON dry-run", async () => {
    await withTempApp({
      ".gitignore": "node_modules/\n.env.example\n!.env.example\n",
      "package.json": JSON.stringify({ name: "fixture-app", scripts: { dev: "vite" } }, null, 2)
    }, async (cwd) => {
      const result = await runCli(["init", "--dry-run", "--json", "--cwd", cwd]);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");

      const envelope = JSON.parse(result.stdout) as {
        schema: string;
        ok: boolean;
        mode: string;
        changes: Array<{ action: string; path: string }>;
      };

      expect(envelope.schema).toBe("mimetic.init-result.v1");
      expect(envelope.ok).toBe(true);
      expect(envelope.mode).toBe("dry-run");
      expect(envelope.changes.some((change) => change.path === "mimetic/config.ts")).toBe(true);

      await expect(stat(path.join(cwd, "mimetic"))).rejects.toMatchObject({ code: "ENOENT" });
      const packageJson = await readJson(path.join(cwd, "package.json")) as {
        scripts: Record<string, string>;
      };
      expect(packageJson.scripts).toEqual({ dev: "vite" });
    });
  });

  it("applies init safely and preserves .env.example exceptions", async () => {
    await withTempApp({
      ".gitignore": "node_modules/\n.env.example\n!.env.example\n",
      "package.json": JSON.stringify({ name: "fixture-app", scripts: { dev: "vite" } }, null, 2)
    }, async (cwd) => {
      const result = await runCli(["init", "--yes", "--json", "--cwd", cwd]);

      expect(result.exitCode).toBe(0);

      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        mode: string;
        changes: Array<{ action: string; path: string }>;
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.mode).toBe("applied");
      expect(envelope.changes.some((change) => change.path === ".mimetic/runs" && change.action === "mkdir")).toBe(true);

      await expect(stat(path.join(cwd, "mimetic/personas/synthetic-new-user.yaml"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, ".mimetic/runs"))).resolves.toBeTruthy();

      const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
      expect(gitignore).toContain(".mimetic/");
      expect(gitignore).toContain(".env*");
      expect(gitignore).toContain("!.env.example");
      expect(gitignore.lastIndexOf("!.env.example")).toBeGreaterThan(gitignore.lastIndexOf(".env*"));

      const packageJson = await readJson(path.join(cwd, "package.json")) as {
        scripts: Record<string, string>;
      };
      expect(packageJson.scripts.dev).toBe("vite");
      expect(packageJson.scripts.mimetic).toBe("mimetic");
      expect(packageJson.scripts["mimetic:verify"]).toBe("mimetic verify");
    });
  });

  it("makes dry-run win over yes", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2)
    }, async (cwd) => {
      const result = await runCli(["init", "--dry-run", "--yes", "--json", "--cwd", cwd]);

      const envelope = JSON.parse(result.stdout) as { mode: string };
      expect(result.exitCode).toBe(0);
      expect(envelope.mode).toBe("dry-run");
      await expect(stat(path.join(cwd, "mimetic"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not overwrite existing starter files or conflicting scripts", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app", scripts: { mimetic: "custom command" } }, null, 2),
      "mimetic/README.md": "# Existing harness\n"
    }, async (cwd) => {
      const result = await runCli(["init", "--yes", "--json", "--cwd", cwd]);

      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        changes: Array<{ action: string; path: string; reason: string }>;
        warnings: string[];
      };
      expect(result.exitCode).toBe(0);
      expect(envelope.ok).toBe(true);
      expect(envelope.changes).toContainEqual(expect.objectContaining({
        action: "skip",
        path: "mimetic/README.md"
      }));
      expect(envelope.changes).toContainEqual(expect.objectContaining({
        action: "update",
        path: "package.json",
        reason: expect.stringContaining("add scripts")
      }));
      expect(envelope.warnings.join("\n")).toContain("Skipped existing mimetic/README.md");
      expect(envelope.warnings.join("\n")).toContain("Preserved existing script values");
      expect(await readFile(path.join(cwd, "mimetic/README.md"), "utf8")).toBe("# Existing harness\n");
      const packageJson = await readJson(path.join(cwd, "package.json")) as {
        scripts: Record<string, string>;
      };
      expect(packageJson.scripts.mimetic).toBe("custom command");
      expect(packageJson.scripts["mimetic:run"]).toBe("mimetic run");
    });
  });

  it("fails closed for invalid target cwd and invalid package.json", async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "mimetic-missing-root-"));
    const missing = path.join(missingRoot, "missing");
    await rm(missingRoot, { force: true, recursive: true });
    const missingResult = await runCli(["init", "--dry-run", "--json", "--cwd", missing]);
    const missingEnvelope = JSON.parse(missingResult.stdout) as {
      ok: boolean;
      error: { code: string };
    };

    expect(missingResult.exitCode).toBe(2);
    expect(missingEnvelope.ok).toBe(false);
    expect(missingEnvelope.error.code).toBe("MIMETIC_INVALID_CWD");

    await withTempApp({
      "package.json": "{ nope"
    }, async (cwd) => {
      const result = await runCli(["init", "--yes", "--json", "--cwd", cwd]);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string };
      };

      expect(result.exitCode).toBe(2);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("MIMETIC_INVALID_PACKAGE_JSON");
      await expect(stat(path.join(cwd, "mimetic"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("fails closed for feedback issue output when no run bundle exists", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2)
    }, async (cwd) => {
      const result = await runCli([
        "feedback",
        "issue",
        "--run",
        "latest",
        "--repo",
        "example/app",
        "--format",
        "markdown",
        "--cwd",
        cwd,
        "--json"
      ]);

      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string };
        schema: string;
      };

      expect(result.exitCode).toBe(2);
      expect(envelope.schema).toBe("mimetic.feedback-result.v1");
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("MIMETIC_RUN_NOT_FOUND");
    });
  });

  it("keeps feedback draft fail-closed without a run bundle", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2)
    }, async (cwd) => {
      const result = await runCli(["feedback", "draft", "--run", "latest", "--cwd", cwd]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("MIMETIC_RUN_NOT_FOUND");
      expect(result.stderr).toBe("");
    });
  });
});
