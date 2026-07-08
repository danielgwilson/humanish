import { CommanderError } from "commander";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createProgram, followObserver, writeResult } from "../src/program.js";
import * as homunIndex from "../src/index.js";

// process.getuid is POSIX-only and absent under Node's typings on some platforms;
// treat "no getuid" the same as "not root" (permission fault injection still works).
function isRunningAsRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

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
    await program.parseAsync(["node", "homun", ...args], { from: "node" });
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), "homun-init-test-"));

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

describe("homun CLI scaffold", () => {
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
        schema: "homun.observer-result.v1",
        ok: true,
        cwd: "/tmp/homun",
        observerPath: ".homun/runs/run/observer/index.html",
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
    expect(result.stdout).toContain("Usage: homun [options] [command]");
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

      expect(envelope.schema).toBe("homun.init-result.v1");
      expect(envelope.ok).toBe(true);
      expect(envelope.mode).toBe("dry-run");
      expect(envelope.changes.some((change) => change.path === "homun/config.ts")).toBe(true);

      await expect(stat(path.join(cwd, "homun"))).rejects.toMatchObject({ code: "ENOENT" });
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
      expect(envelope.changes.some((change) => change.path === ".homun/runs" && change.action === "mkdir")).toBe(true);

      await expect(stat(path.join(cwd, "homun/personas/synthetic-new-user.yaml"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, "homun/labs/first-run.yaml"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, ".homun/runs"))).resolves.toBeTruthy();
      await expect(stat(path.join(cwd, ".homun/local/labs"))).resolves.toBeTruthy();

      const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
      expect(gitignore).toContain(".homun/");
      expect(gitignore).toContain(".env*");
      expect(gitignore).toContain("!.env.example");
      expect(gitignore.lastIndexOf("!.env.example")).toBeGreaterThan(gitignore.lastIndexOf(".env*"));

      const packageJson = await readJson(path.join(cwd, "package.json")) as {
        scripts: Record<string, string>;
      };
      expect(packageJson.scripts.dev).toBe("vite");
      expect(packageJson.scripts.homun).toBe("homun");
      expect(packageJson.scripts["homun:watch"]).toBe("homun watch");
      expect(packageJson.scripts["homun:watch:ci"]).toBe("homun watch --json --no-open");
      expect(packageJson.scripts["homun:verify"]).toBe("homun verify");
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
      await expect(stat(path.join(cwd, "homun"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("does not overwrite existing starter files or conflicting scripts", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app", scripts: { homun: "custom command" } }, null, 2),
      "homun/README.md": "# Existing harness\n"
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
        path: "homun/README.md"
      }));
      expect(envelope.changes).toContainEqual(expect.objectContaining({
        action: "update",
        path: "package.json",
        reason: expect.stringContaining("add scripts")
      }));
      expect(envelope.warnings.join("\n")).toContain("Skipped existing homun/README.md");
      expect(envelope.warnings.join("\n")).toContain("Preserved existing script values");
      expect(await readFile(path.join(cwd, "homun/README.md"), "utf8")).toBe("# Existing harness\n");
      const packageJson = await readJson(path.join(cwd, "package.json")) as {
        scripts: Record<string, string>;
      };
      expect(packageJson.scripts.homun).toBe("custom command");
      expect(packageJson.scripts["homun:run"]).toBe("homun run --dry-run");
      expect(packageJson.scripts["homun:watch"]).toBe("homun watch");
    });
  });

  it("lists and inspects lab manifests from the CLI", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      "homun/labs/first-run.yaml": [
        "schema: homun.lab.v2",
        "id: first-run",
        "title: First run",
        "subject:",
        "  source: this-repo",
        "actors:",
        "  - type: synthetic-persona",
        "    count: 2"
      ].join("\n")
    }, async (cwd) => {
      const list = await runCli(["lab", "list", "--cwd", cwd]);
      const inspect = await runCli(["lab", "inspect", "first-run", "--cwd", cwd, "--json"]);

      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain("homun labs");
      expect(list.stdout).toContain("first-run this-repo committed");

      const envelope = JSON.parse(inspect.stdout) as {
        ok: boolean;
        config: { id: string; subject: { source: string }; actors: Array<{ type: string; count?: number }> };
      };
      expect(inspect.exitCode).toBe(0);
      expect(envelope.ok).toBe(true);
      expect(envelope.config).toEqual(expect.objectContaining({
        id: "first-run",
        subject: { source: "this-repo" }
      }));
      expect(envelope.config.actors[0]).toEqual(expect.objectContaining({ type: "synthetic-persona", count: 2 }));
    });
  });

  it("runs a synthetic lab manifest through run and watch", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      "homun/labs/first-run.yaml": [
        "schema: homun.lab.v2",
        "id: first-run",
        "subject:",
        "  source: this-repo",
        "actors:",
        "  - type: synthetic-persona",
        "    count: 2",
        "scenario:",
        "  mode: dry-run"
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

  it("fails closed when rerun flags are used on a non-CUA lab", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      "homun/labs/first-run.yaml": [
        "schema: homun.lab.v2",
        "id: first-run",
        "subject:",
        "  source: this-repo",
        "actors:",
        "  - type: synthetic-persona",
        "scenario:",
        "  mode: dry-run"
      ].join("\n")
    }, async (cwd) => {
      const result = await runCli([
        "lab",
        "run",
        "first-run",
        "--cwd",
        cwd,
        "--rerun-failed-from",
        "latest",
        "--json"
      ]);

      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(result.exitCode).toBe(2);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("HOMUN_UNSUPPORTED_RERUN_FLAGS");
      expect(envelope.error.message).toContain("CUA fan-out");
      expect(envelope.error.message).toContain("synthetic");
    });
  });

  it("fails closed when direct run-only options are mixed with lab manifests", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      "homun/labs/first-run.yaml": [
        "schema: homun.lab.v2",
        "id: first-run",
        "subject:",
        "  source: this-repo",
        "actors:",
        "  - type: synthetic-persona"
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
      expect(envelope.error.code).toBe("HOMUN_APP_URL_OPTION_CONFLICT");
      expect(envelope.error.message).toContain("lab-compatible options");
    });
  });

  it("fails closed for invalid target cwd and invalid package.json", async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "homun-missing-root-"));
    const missing = path.join(missingRoot, "missing");
    await rm(missingRoot, { force: true, recursive: true });
    const missingResult = await runCli(["init", "--dry-run", "--json", "--cwd", missing]);
    const missingEnvelope = JSON.parse(missingResult.stdout) as {
      ok: boolean;
      error: { code: string };
    };

    expect(missingResult.exitCode).toBe(2);
    expect(missingEnvelope.ok).toBe(false);
    expect(missingEnvelope.error.code).toBe("HOMUN_INVALID_CWD");

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
      expect(envelope.error.code).toBe("HOMUN_INVALID_PACKAGE_JSON");
      await expect(stat(path.join(cwd, "homun"))).rejects.toMatchObject({ code: "ENOENT" });
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
      expect(envelope.schema).toBe("homun.feedback-result.v1");
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("HOMUN_RUN_NOT_FOUND");
    });
  });

  it("keeps feedback draft fail-closed without a run bundle", async () => {
    await withTempApp({
      "package.json": JSON.stringify({ name: "fixture-app" }, null, 2)
    }, async (cwd) => {
      const result = await runCli(["feedback", "draft", "--run", "latest", "--cwd", cwd]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain("HOMUN_RUN_NOT_FOUND");
      expect(result.stderr).toBe("");
    });
  });

  it("catches an unexpected fs error at the command boundary and emits a single HOMUN_UNEXPECTED envelope (issue #262 repro A)", async () => {
    await withTempApp({}, async (cwd) => {
      // .homun/runs as a FILE (not a directory) makes the unguarded mkdir inside
      // runDryRun reject with ENOTDIR. Before the command-boundary catch-all this
      // crashed raw to stderr with a Node stack trace and zero stdout.
      await mkdir(path.join(cwd, ".homun"), { recursive: true });
      await writeFile(path.join(cwd, ".homun", "runs"), "", "utf8");

      const result = await runCli(["run", "--dry-run", "--cwd", cwd, "--json"]);

      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout) as {
        schema: string;
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(result.exitCode).toBe(2);
      expect(envelope.schema).toBe("homun.cli-response.v1");
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("HOMUN_UNEXPECTED");
      expect(envelope.error.message).toContain("ENOTDIR");
      expect(envelope.error.message).not.toContain(cwd);
    });
  });

  it("emits a concise HOMUN_UNEXPECTED stderr line (not a raw stack trace) without --json", async () => {
    await withTempApp({}, async (cwd) => {
      await mkdir(path.join(cwd, ".homun"), { recursive: true });
      await writeFile(path.join(cwd, ".homun", "runs"), "", "utf8");

      const result = await runCli(["run", "--dry-run", "--cwd", cwd]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("HOMUN_UNEXPECTED:");
      expect(result.stderr).toContain("ENOTDIR");
      expect(result.stderr).not.toContain("at async");
    });
  });

  it("never appends a second JSON document to stdout when the command boundary catch-all fires after a successful writeResult (issue #262 repro C)", async () => {
    // Repro: `codex app-server --keep-open --json` calls writeResult to flush a
    // success envelope, then awaits further work that can still reject
    // (controller.completion; see codex-app-server-ui.ts's persistState()).
    // Before this guard, the catch-all appended a second homun.cli-response.v1
    // document to the same stdout stream and JSON.parse(stdout) broke for every
    // --json consumer. This reproduces that shape directly at the command
    // boundary: a scratch-only subcommand registered on a real createProgram()
    // instance (inheriting the HomunCommand seam via createCommand, exactly
    // like every real leaf command) writes a success envelope through the same
    // writeResult funnel every command uses, then throws synchronously.
    let exitCode = 0;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      writeOut: (text: string) => stdout.push(text),
      writeErr: (text: string) => stderr.push(text),
      setExitCode: (code: number) => {
        exitCode = code;
      }
    };
    const program = createProgram(io);

    program
      .command("__test-scratch-envelope-then-throw")
      .option("--json")
      .action((_options: unknown, command) => {
        writeResult(command, io, { schema: "homun.test-scratch-result.v1", ok: true }, () => "ok\n");
        throw new Error("scratch failure after a successful write");
      });

    program.exitOverride();
    await program.parseAsync(["node", "homun", "__test-scratch-envelope-then-throw", "--json"], { from: "node" });

    const stdoutText = stdout.join("");
    // The real-world failure mode this guards against: JSON.parse(stdout)
    // throwing because a second document got appended. Parsing must succeed
    // and yield exactly the success envelope, not the HOMUN_UNEXPECTED one.
    const envelope = JSON.parse(stdoutText) as { schema: string; ok: boolean };
    expect(envelope).toEqual({ schema: "homun.test-scratch-result.v1", ok: true });
    // Exactly one write reached stdout: the success envelope. The catch-all did
    // not additionally write there.
    expect(stdout).toHaveLength(1);
    expect(stderr.join("")).toContain("HOMUN_UNEXPECTED:");
    expect(stderr.join("")).toContain("scratch failure after a successful write");
    expect(exitCode).toBe(2);
  });

  it.skipIf(isRunningAsRoot())(
    "discriminates a real runs I/O failure from an empty runs directory (issue #262 repro B)",
    async () => {
      await withTempApp({}, async (cwd) => {
        const runsRoot = path.join(cwd, ".homun", "runs");
        await mkdir(runsRoot, { recursive: true });
        await chmod(runsRoot, 0o000);

        try {
          const result = await runCli(["runs", "--cwd", cwd, "--json"]);

          expect(result.stderr).toBe("");
          const envelope = JSON.parse(result.stdout) as {
            schema: string;
            ok: boolean;
            runs: unknown[];
            latest: string | null;
            error: { code: string; message: string };
          };
          expect(result.exitCode).toBe(2);
          expect(envelope.schema).toBe("homun.runs-result.v1");
          expect(envelope.ok).toBe(false);
          expect(envelope.runs).toEqual([]);
          expect(envelope.latest).toBeNull();
          expect(envelope.error.code).toBe("HOMUN_RUNS_UNAVAILABLE");
          expect(envelope.error.message).not.toContain(cwd);
        } finally {
          await chmod(runsRoot, 0o755);
        }
      });
    }
  );

  it("reports ok:true with an empty list for a fresh cwd with no .homun/runs yet (not an error)", async () => {
    await withTempApp({}, async (cwd) => {
      const result = await runCli(["runs", "--cwd", cwd, "--json"]);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { ok: boolean; runs: unknown[]; latest: string | null };
      expect(envelope.ok).toBe(true);
      expect(envelope.runs).toEqual([]);
      expect(envelope.latest).toBeNull();
    });
  });

  it("exits 2 on doctor failure, matching every other structured command", async () => {
    await withTempApp({}, async (cwd) => {
      const result = await runCli(["doctor", "--cwd", cwd, "--json"]);

      expect(result.exitCode).toBe(2);
      const envelope = JSON.parse(result.stdout) as { ok: boolean };
      expect(envelope.ok).toBe(false);
    });
  });

  it("no longer exports the dead planned-command scaffold from the public package entrypoint", () => {
    expect(Object.prototype.hasOwnProperty.call(homunIndex, "plannedCommands")).toBe(false);
    // The catch-all envelope helper stays: the schema string is still live.
    expect(homunIndex.CLI_RESPONSE_SCHEMA).toBe("homun.cli-response.v1");
    expect(typeof homunIndex.createProgram).toBe("function");
  });
});
