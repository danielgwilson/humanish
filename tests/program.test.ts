import { CommanderError } from "commander";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram, followObserver } from "../src/program.js";

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
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
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
  it("cleans up attached Observer watches on package-manager style termination signals", async () => {
    let exitCode = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const signalTarget = new EventEmitter();
    let closed = 0;
    let cleanupCalls = 0;

    const promise = followObserver(
      {
        writeOut: (text) => stdout.push(text),
        writeErr: (text) => stderr.push(text),
        setExitCode: (code) => {
          exitCode = code;
        }
      },
      {
        schema: "mimetic.observer-result.v1",
        ok: true,
        cwd: "/tmp/mimetic",
        observerPath: ".mimetic/runs/run/observer/index.html",
        run: "run",
        warnings: []
      },
      {
        opened: false,
        url: "http://127.0.0.1:1234/observer/index.html",
        close: async () => {
          closed += 1;
        }
      },
      {
        onStop: async () => {
          cleanupCalls += 1;
          return ["E2B sandbox cleanup killed 1, skipped 0."];
        },
        signalTarget,
        signals: ["SIGTERM"]
      }
    );

    signalTarget.emit("SIGTERM");
    signalTarget.emit("SIGTERM");
    await promise;

    expect(exitCode).toBe(143);
    expect(closed).toBe(1);
    expect(cleanupCalls).toBe(1);
    expect(stderr.join("")).toBe("");
    expect(stdout.join("")).toContain("watch cleanup: E2B sandbox cleanup killed 1, skipped 0.");
    expect(stdout.join("")).toContain("watch stopped");
  });

  it("prints useful Commander help", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Usage: mimetic [options] [command]");
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("feedback");
    expect(result.stdout).toContain("Public-safety boundary");
  });

  it("reports the package version", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const result = await runCli(["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
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
      await expect(stat(path.join(cwd, "mimetic/labs/first-run.yaml"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, ".mimetic/runs"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, ".mimetic/local/labs"))).resolves.toBeTruthy();

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
      expect(packageJson.scripts["mimetic:watch"]).toBe("mimetic watch");
      expect(packageJson.scripts["mimetic:watch:ci"]).toBe("mimetic watch --json --no-open");
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
      expect(packageJson.scripts["mimetic:run"]).toBe("mimetic run --dry-run");
      expect(packageJson.scripts["mimetic:watch"]).toBe("mimetic watch");
    });
  });

  it("lists and inspects lab manifests from the CLI", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      "mimetic/labs/first-run.yaml": [
        "schema: mimetic.lab.v1",
        "id: first-run",
        "kind: synthetic",
        "title: First run",
        "sims: 2"
      ].join("\n")
    }, async (cwd) => {
      const list = await runCli(["lab", "list", "--cwd", cwd]);
      const inspect = await runCli(["lab", "inspect", "first-run", "--cwd", cwd, "--json"]);

      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("mimetic labs");
      expect(list.stdout).toContain("first-run synthetic committed");

      const envelope = JSON.parse(inspect.stdout) as {
        ok: boolean;
        manifest: { id: string; kind: string; sims: number };
      };
      expect(inspect.exitCode).toBe(0);
      expect(envelope.ok).toBe(true);
      expect(envelope.manifest).toEqual(expect.objectContaining({
        id: "first-run",
        kind: "synthetic",
        sims: 2
      }));
    });
  });

  it("runs a synthetic lab manifest through run and watch", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      "mimetic/labs/first-run.yaml": [
        "schema: mimetic.lab.v1",
        "id: first-run",
        "kind: synthetic",
        "sims: 2",
        "defaults:",
        "  dryRun: true"
      ].join("\n")
    }, async (cwd) => {
      const run = await runCli([
        "run",
        "first-run",
        "--cwd",
        cwd,
        "--run-id",
        "lab-run-test",
        "--json"
      ]);
      const watch = await runCli([
        "watch",
        "first-run",
        "--cwd",
        cwd,
        "--run-id",
        "lab-watch-test",
        "--json",
        "--no-open"
      ]);

      expect(run.exitCode).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(expect.objectContaining({
        ok: true,
        runId: "lab-run-test",
        simCount: 2
      }));

      const watchEnvelope = JSON.parse(watch.stdout) as {
        ok: boolean;
        run: string;
        observerPath: string;
      };
      expect(watch.exitCode).toBe(0);
      expect(watchEnvelope.ok).toBe(true);
      expect(watchEnvelope.run).toBe("lab-watch-test");
      expect(watchEnvelope.observerPath).toContain("observer/index.html");
    });
  });

  it("fails closed when direct run-only options are mixed with lab manifests", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      "mimetic/labs/first-run.yaml": [
        "schema: mimetic.lab.v1",
        "id: first-run",
        "kind: synthetic"
      ].join("\n")
    }, async (cwd) => {
      const result = await runCli([
        "run",
        "first-run",
        "--app-url",
        "http://127.0.0.1:3000",
        "--cwd",
        cwd,
        "--json"
      ]);

      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(result.exitCode).toBe(2);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("MIMETIC_APP_URL_OPTION_CONFLICT");
      expect(envelope.error.message).toContain("lab-compatible options");
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
