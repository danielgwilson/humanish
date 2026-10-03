import { CommanderError } from "commander";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { connect as netConnect, createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import { createProgram, normalizeCliArgv } from "../../src/cli/program.js";
import { formatCuaLabHuman } from "../../src/cli/commands/lab-format.js";
import { resolveRouteShouldOpen } from "../../src/cli/commands/lab-route-open.js";
import { followObserver } from "../../src/cli/observer-follow.js";
import { runFactsFor, writeResult } from "../../src/cli/io.js";
import * as humanishIndex from "../../src/index.js";

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
    },
  });

  program.exitOverride();

  try {
    await program.parseAsync(["node", "humanish", ...args], { from: "node" });
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
      return {
        exitCode: 0,
        stderr: stderr.join(""),
        stdout: stdout.join(""),
      };
    }

    throw error;
  }

  return {
    exitCode,
    stderr: stderr.join(""),
    stdout: stdout.join(""),
  };
}

async function withTempApp<T>(
  files: Record<string, string>,
  callback: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-init-test-"));

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

describe("humanish CLI scaffold", () => {
  it.each(["0", "65535", "2525.5", "2525oops", "NaN"])(
    "rejects invalid catch SMTP port %s before creating files",
    async (smtpPort) => {
      await withTempApp({}, async (cwd) => {
        const result = await runCli([
          "comms",
          "catch",
          "--smtp-port",
          smtpPort,
          "--dir",
          path.join(cwd, "catch"),
        ]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("--smtp-port must be an integer");
        expect(await readdir(cwd)).toEqual([]);
      });
    },
  );

  it.each([
    ["--port", "2525"],
    ["--inbox-port", "2525"],
  ])("rejects an SMTP port shared with %s before creating files", async (flag, port) => {
    await withTempApp({}, async (cwd) => {
      const result = await runCli([
        "comms",
        "catch",
        flag,
        port,
        "--smtp-port",
        "2525",
        "--dir",
        path.join(cwd, "catch"),
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("--smtp-port must differ");
      expect(await readdir(cwd)).toEqual([]);
    });
  });

  it.each([
    ["run", "lanes"],
    ["run", "roster"],
  ] as const)(
    "%s rejects unknown %s fields in JSON before creating run evidence",
    async (command, field) => {
      const manifest = {
        schema: "humanish.lab.v2",
        id: "typo",
        subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
        actors: [
          {
            type: "openai-computer-use",
            [field]: [
              { id: "reader", runtme: "different", ...(field === "roster" ? { count: 2 } : {}) },
            ],
          },
        ],
        execution: { target: "e2b-desktop" },
      };
      await withTempApp({ "humanish/labs/typo.yaml": JSON.stringify(manifest) }, async (cwd) => {
        // A regression can only reach a dry backend; this contract test never permits paid work.
        const result = await runCli([
          ...command.split(" "),
          "typo",
          "--dry-run",
          "--no-open",
          "--json",
          "--cwd",
          cwd,
        ]);
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toBe("");
        const envelope = JSON.parse(result.stdout);
        expect(envelope.ok).toBe(false);
        expect(envelope.error.code).toBe("HUMANISH_STUDY_INVALID");
        expect(envelope.error.message).toContain(
          `Unknown lab field(s) in \`actors[0].${field}[0]\`: runtme`,
        );
        expect(await readdir(cwd)).not.toContain(".humanish");
      });
    },
  );

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
        },
      },
      {
        schema: "humanish.observer-result.v1",
        ok: true,
        cwd: "/tmp/humanish",
        observerPath: ".humanish/runs/run/observer/index.html",
        run: "run",
        warnings: [],
      },
      {
        opened: false,
        port: 1234,
        url: "http://127.0.0.1:1234/observer/index.html",
        addPublicOrigin: () => {},
        close: async () => {
          closed += 1;
        },
      },
      {
        onStop: async () => {
          cleanupCalls += 1;
          return ["E2B sandbox cleanup killed 1, skipped 0."];
        },
        signalTarget,
        signals: ["SIGTERM"],
      },
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
    expect(result.stdout).toContain("Usage: humanish [options] [command]");
    expect(result.stdout).toContain("init");
    expect(result.stdout).toContain("doctor");
    expect(result.stdout).toContain("feedback");
    expect(result.stdout).toContain("Public-safety boundary");
  });

  it("lists each visible top-level command on one line of the root --help", async () => {
    // At 80 columns commander wraps a long summary onto indented continuation lines, which would
    // show up here as rows that do not start with a command name.
    const result = await runCli(["--help"]);
    const lines = result.stdout.split("\n");
    const start = lines.indexOf("Commands:") + 1;
    const rows = lines.slice(start, lines.indexOf("", start));
    const program = createProgram();
    const visible = program
      .createHelp()
      .visibleCommands(program)
      .map((command) => command.name());

    expect(result.exitCode).toBe(0);
    expect(rows.map((row) => row.trim().split(" ")[0])).toEqual(visible);
    expect(visible).not.toContain("codex");
    expect(program.commands.map((command) => command.name())).toContain("codex");
  });

  it.each([["--version"], ["-v"]])("reports the package version for %s", async (flag) => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };
    const result = await runCli([flag]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

  it("plans init changes without mutating files during JSON dry-run", async () => {
    await withTempApp(
      {
        ".gitignore": "node_modules/\n.env.example\n!.env.example\n",
        "package.json": JSON.stringify({ name: "fixture-app", scripts: { dev: "vite" } }, null, 2),
      },
      async (cwd) => {
        const result = await runCli(["init", "--dry-run", "--json", "--cwd", cwd]);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");

        const envelope = JSON.parse(result.stdout) as {
          schema: string;
          ok: boolean;
          mode: string;
          changes: Array<{ action: string; path: string }>;
        };

        expect(envelope.schema).toBe("humanish.init-result.v1");
        expect(envelope.ok).toBe(true);
        expect(envelope.mode).toBe("dry-run");
        expect(
          envelope.changes.some((change) => change.path === "humanish/studies/first-run.yaml"),
        ).toBe(true);

        await expect(stat(path.join(cwd, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });
        const packageJson = (await readJson(path.join(cwd, "package.json"))) as {
          scripts: Record<string, string>;
        };
        expect(packageJson.scripts).toEqual({ dev: "vite" });
      },
    );
  });

  it("applies init safely and preserves .env.example exceptions", async () => {
    await withTempApp(
      {
        ".gitignore": "node_modules/\n.env.example\n!.env.example\n",
        "package.json": JSON.stringify({ name: "fixture-app", scripts: { dev: "vite" } }, null, 2),
      },
      async (cwd) => {
        const result = await runCli(["init", "--yes", "--json", "--cwd", cwd]);

        expect(result.exitCode).toBe(0);

        const envelope = JSON.parse(result.stdout) as {
          ok: boolean;
          mode: string;
          changes: Array<{ action: string; path: string }>;
        };
        expect(envelope.ok).toBe(true);
        expect(envelope.mode).toBe("applied");
        expect(
          envelope.changes.some(
            (change) => change.path === ".humanish/runs" && change.action === "mkdir",
          ),
        ).toBe(true);

        await expect(
          stat(path.join(cwd, "humanish/personas/synthetic-new-user.yaml")),
        ).resolves.toBeTruthy();
        await expect(stat(path.join(cwd, "humanish/studies/first-run.yaml"))).resolves.toBeTruthy();
        await expect(stat(path.join(cwd, ".humanish/runs"))).resolves.toBeTruthy();
        await expect(stat(path.join(cwd, ".humanish/local/studies"))).resolves.toBeTruthy();

        const gitignore = await readFile(path.join(cwd, ".gitignore"), "utf8");
        expect(gitignore).toContain(".humanish/");
        expect(gitignore).toContain(".env*");
        expect(gitignore).toContain("!.env.example");
        expect(gitignore.lastIndexOf("!.env.example")).toBeGreaterThan(
          gitignore.lastIndexOf(".env*"),
        );

        const packageJson = (await readJson(path.join(cwd, "package.json"))) as {
          scripts: Record<string, string>;
        };
        expect(packageJson.scripts.dev).toBe("vite");
        expect(packageJson.scripts.humanish).toBe("humanish");
        expect(packageJson.scripts["humanish:watch"]).toBe("humanish watch");
        expect(packageJson.scripts["humanish:watch:ci"]).toBe("humanish watch --json --no-open");
        expect(packageJson.scripts["humanish:verify"]).toBe("humanish verify");
      },
    );
  });

  it("makes dry-run win over yes", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      },
      async (cwd) => {
        const result = await runCli(["init", "--dry-run", "--yes", "--json", "--cwd", cwd]);

        const envelope = JSON.parse(result.stdout) as { mode: string };
        expect(result.exitCode).toBe(0);
        expect(envelope.mode).toBe("dry-run");
        await expect(stat(path.join(cwd, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("keeps the next action visible after setup while JSON and dry-run retain the file inventory", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }),
      },
      async (cwd) => {
        const plan = await runCli(["init", "--dry-run", "--cwd", cwd]);
        expect(plan.stdout).toContain("humanish/personas/synthetic-new-user.yaml");
        const applied = await runCli(["init", "--yes", "--cwd", cwd]);
        expect(applied.exitCode).toBe(0);
        const firstScreen = applied.stdout.split("\n").slice(0, 20).join("\n");
        expect(firstScreen).toContain("humanish run first-run");
        expect(firstScreen).toContain("a dry run: no browser or model runs");
        expect(applied.stdout).not.toContain("humanish/personas/synthetic-new-user.yaml");
        const details = await runCli(["init", "--dry-run", "--json", "--cwd", cwd]);
        expect(JSON.parse(details.stdout).changes).toContainEqual(
          expect.objectContaining({
            path: "humanish/personas/synthetic-new-user.yaml",
            action: "skip",
          }),
        );
      },
    );
  });

  it("keeps preservation warnings visible in compact setup output", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({
          name: "fixture-app",
          scripts: { humanish: "custom command" },
        }),
        "humanish/README.md": "# Existing harness\n",
      },
      async (cwd) => {
        const result = await runCli(["init", "--yes", "--cwd", cwd]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Skipped existing humanish/README.md");
        expect(result.stdout).toContain("Preserved existing script values");
        expect(await readFile(path.join(cwd, "humanish/README.md"), "utf8")).toBe(
          "# Existing harness\n",
        );
      },
    );
  });

  it("does not overwrite existing starter files or conflicting scripts", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify(
          { name: "fixture-app", scripts: { humanish: "custom command" } },
          null,
          2,
        ),
        "humanish/README.md": "# Existing harness\n",
      },
      async (cwd) => {
        const result = await runCli(["init", "--yes", "--json", "--cwd", cwd]);

        const envelope = JSON.parse(result.stdout) as {
          ok: boolean;
          changes: Array<{ action: string; path: string; reason: string }>;
          warnings: string[];
        };
        expect(result.exitCode).toBe(0);
        expect(envelope.ok).toBe(true);
        expect(envelope.changes).toContainEqual(
          expect.objectContaining({
            action: "skip",
            path: "humanish/README.md",
          }),
        );
        expect(envelope.changes).toContainEqual(
          expect.objectContaining({
            action: "update",
            path: "package.json",
            reason: expect.stringContaining("add scripts"),
          }),
        );
        expect(envelope.warnings.join("\n")).toContain("Skipped existing humanish/README.md");
        expect(envelope.warnings.join("\n")).toContain("Preserved existing script values");
        expect(await readFile(path.join(cwd, "humanish/README.md"), "utf8")).toBe(
          "# Existing harness\n",
        );
        const packageJson = (await readJson(path.join(cwd, "package.json"))) as {
          scripts: Record<string, string>;
        };
        expect(packageJson.scripts.humanish).toBe("custom command");
        expect(packageJson.scripts["humanish:run"]).toBe("humanish run --dry-run");
        expect(packageJson.scripts["humanish:watch"]).toBe("humanish watch");
      },
    );
  });

  it("lists and inspects lab manifests from the CLI", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
        "humanish/labs/first-run.yaml": [
          "schema: humanish.lab.v2",
          "id: first-run",
          "title: First run",
          "subject:",
          "  source: this-repo",
          "actors:",
          "  - type: synthetic-persona",
          "    count: 2",
        ].join("\n"),
      },
      async (cwd) => {
        const list = await runCli(["lab", "list", "--cwd", cwd]);
        const inspect = await runCli(["lab", "inspect", "first-run", "--cwd", cwd, "--json"]);

        expect(list.exitCode).toBe(0);
        expect(list.stdout).toContain("humanish labs");
        expect(list.stdout).toContain("first-run this-repo committed");

        const envelope = JSON.parse(inspect.stdout) as {
          ok: boolean;
          config: {
            id: string;
            subject: { source: string };
            actors: Array<{ type: string; count?: number }>;
          };
        };
        expect(inspect.exitCode).toBe(0);
        expect(envelope.ok).toBe(true);
        expect(envelope.config).toEqual(
          expect.objectContaining({
            id: "first-run",
            subject: { source: "this-repo" },
          }),
        );
        expect(envelope.config.actors[0]).toEqual(
          expect.objectContaining({ type: "synthetic-persona", count: 2 }),
        );
      },
    );
  });

  it("runs a synthetic lab manifest through run and watch", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
        "humanish/labs/first-run.yaml": [
          "schema: humanish.lab.v2",
          "id: first-run",
          "subject:",
          "  source: this-repo",
          "actors:",
          "  - type: synthetic-persona",
          "    count: 2",
          "scenario:",
          "  mode: dry-run",
        ].join("\n"),
      },
      async (cwd) => {
        const run = await runCli([
          "run",
          "first-run",
          "--cwd",
          cwd,
          "--run-id",
          "lab-run-test",
          "--json",
        ]);
        const watch = await runCli([
          "watch",
          "first-run",
          "--cwd",
          cwd,
          "--run-id",
          "lab-watch-test",
          "--json",
          "--no-open",
        ]);

        expect(run.exitCode).toBe(0);
        expect(JSON.parse(run.stdout)).toEqual(
          expect.objectContaining({
            ok: true,
            runId: "lab-run-test",
            simCount: 2,
          }),
        );

        const watchEnvelope = JSON.parse(watch.stdout) as {
          ok: boolean;
          run: string;
          observerPath: string;
        };
        expect(watch.exitCode).toBe(0);
        expect(watchEnvelope.ok).toBe(true);
        expect(watchEnvelope.run).toBe("lab-watch-test");
        expect(watchEnvelope.observerPath).toContain("observer/index.html");
      },
    );
  });

  it("gates human-mode auto-open behind a real TTY for both bare and lab-backed watch", async () => {
    // watch defaulted shouldOpen to true in human mode with no TTY check at all
    // (unlike observe, which already gated on process.stdout.isTTY). Force a
    // non-TTY stdout here so the assertion holds regardless of how the test
    // runner itself is invoked, then confirm neither the bare watch path nor the
    // lab-backed watch path (synthetic backend showing the Observer its preview rendered)
    // attempts to auto-open a browser without --open, --json, or a real TTY.
    const originalIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = false;

    try {
      await withTempApp(
        {
          "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
          "humanish/labs/first-run.yaml": [
            "schema: humanish.lab.v2",
            "id: first-run",
            "subject:",
            "  source: this-repo",
            "actors:",
            "  - type: synthetic-persona",
            "    count: 2",
            "scenario:",
            "  mode: dry-run",
          ].join("\n"),
        },
        async (cwd) => {
          const bareWatch = await runCli([
            "watch",
            "--cwd",
            cwd,
            "--run-id",
            "tty-gate-bare",
            "--detach",
          ]);
          expect(bareWatch.exitCode).toBe(0);
          expect(bareWatch.stdout).toContain("opened: no");

          const labWatch = await runCli([
            "watch",
            "first-run",
            "--cwd",
            cwd,
            "--run-id",
            "tty-gate-lab",
            "--detach",
          ]);
          expect(labWatch.exitCode).toBe(0);
          expect(labWatch.stdout).toContain("opened: no");
        },
      );
    } finally {
      process.stdout.isTTY = originalIsTTY;
    }
  });

  it("fails closed when rerun flags are used on a non-computer-use study", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
        "humanish/labs/first-run.yaml": [
          "schema: humanish.lab.v2",
          "id: first-run",
          "subject:",
          "  source: this-repo",
          "actors:",
          "  - type: synthetic-persona",
          "scenario:",
          "  mode: dry-run",
        ].join("\n"),
      },
      async (cwd) => {
        const result = await runCli([
          "lab",
          "run",
          "first-run",
          "--cwd",
          cwd,
          "--rerun-failed-from",
          "latest",
          "--json",
        ]);

        const envelope = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { code: string; message: string };
        };
        expect(result.exitCode).toBe(2);
        expect(envelope.ok).toBe(false);
        expect(envelope.error.code).toBe("HUMANISH_UNSUPPORTED_RERUN_FLAGS");
        expect(envelope.error.message).toContain("the preview route");
      },
    );
  });

  it("fails closed for invalid target cwd and invalid package.json", async () => {
    const missingRoot = await mkdtemp(path.join(os.tmpdir(), "humanish-missing-root-"));
    const missing = path.join(missingRoot, "missing");
    await rm(missingRoot, { force: true, recursive: true });
    const missingResult = await runCli(["init", "--dry-run", "--json", "--cwd", missing]);
    const missingEnvelope = JSON.parse(missingResult.stdout) as {
      ok: boolean;
      error: { code: string };
    };

    expect(missingResult.exitCode).toBe(2);
    expect(missingEnvelope.ok).toBe(false);
    expect(missingEnvelope.error.code).toBe("HUMANISH_INVALID_CWD");

    await withTempApp(
      {
        "package.json": "{ nope",
      },
      async (cwd) => {
        const result = await runCli(["init", "--yes", "--json", "--cwd", cwd]);
        const envelope = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { code: string };
        };

        expect(result.exitCode).toBe(2);
        expect(envelope.ok).toBe(false);
        expect(envelope.error.code).toBe("HUMANISH_INVALID_PACKAGE_JSON");
        await expect(stat(path.join(cwd, "humanish"))).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("fails closed for feedback issue output when no run bundle exists", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      },
      async (cwd) => {
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
          "--json",
        ]);

        const envelope = JSON.parse(result.stdout) as {
          ok: boolean;
          error: { code: string };
          schema: string;
        };

        expect(result.exitCode).toBe(2);
        expect(envelope.schema).toBe("humanish.feedback-result.v1");
        expect(envelope.ok).toBe(false);
        expect(envelope.error.code).toBe("HUMANISH_RUN_NOT_FOUND");
      },
    );
  });

  it("keeps feedback draft fail-closed without a run bundle", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
      },
      async (cwd) => {
        const result = await runCli(["feedback", "draft", "--run", "latest", "--cwd", cwd]);

        expect(result.exitCode).toBe(2);
        expect(result.stderr).toContain("HUMANISH_RUN_NOT_FOUND");
        expect(result.stdout).toBe("");
      },
    );
  });

  it("catches an unexpected fs error at the command boundary and emits a single HUMANISH_UNEXPECTED envelope", async () => {
    await withTempApp({}, async (cwd) => {
      // .humanish/runs as a file (not a directory) makes the unguarded mkdir inside
      // runDryRun reject with ENOTDIR. Before the command-boundary catch-all this
      // crashed raw to stderr with a Node stack trace and zero stdout.
      await mkdir(path.join(cwd, ".humanish"), { recursive: true });
      await writeFile(path.join(cwd, ".humanish", "runs"), "", "utf8");

      const result = await runCli(["run", "--dry-run", "--cwd", cwd, "--json"]);

      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout) as {
        schema: string;
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(result.exitCode).toBe(2);
      expect(envelope.schema).toBe("humanish.cli-response.v1");
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe("HUMANISH_UNEXPECTED");
      expect(envelope.error.message).toContain("ENOTDIR");
      expect(envelope.error.message).not.toContain(cwd);
    });
  });

  it("emits a concise HUMANISH_UNEXPECTED stderr line (not a raw stack trace) without --json", async () => {
    await withTempApp({}, async (cwd) => {
      await mkdir(path.join(cwd, ".humanish"), { recursive: true });
      await writeFile(path.join(cwd, ".humanish", "runs"), "", "utf8");

      const result = await runCli(["run", "--dry-run", "--cwd", cwd]);

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("HUMANISH_UNEXPECTED:");
      expect(result.stderr).toContain("ENOTDIR");
      expect(result.stderr).not.toContain("at async");
    });
  });

  it("never appends a second JSON document to stdout when the command boundary catch-all fires after a successful writeResult", async () => {
    // Repro: `codex app-server --keep-open --json` calls writeResult to flush a
    // success envelope, then awaits further work that can still reject
    // (controller.completion; see codex-app-server-ui.ts's persistState()).
    // Before this guard, the catch-all appended a second humanish.cli-response.v1
    // document to the same stdout stream and JSON.parse(stdout) broke for every
    // --json consumer. This reproduces that shape directly at the command
    // boundary: a scratch-only subcommand registered on a real createProgram()
    // instance (inheriting the HumanishCommand seam via createCommand, exactly
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
      },
    };
    const program = createProgram(io);

    program
      .command("__test-scratch-envelope-then-throw")
      .option("--json")
      .action((_options: unknown, command) => {
        writeResult(
          command,
          io,
          { schema: "humanish.test-scratch-result.v1", ok: true },
          () => "ok\n",
        );
        throw new Error("scratch failure after a successful write");
      });

    program.exitOverride();
    await program.parseAsync(["node", "humanish", "__test-scratch-envelope-then-throw", "--json"], {
      from: "node",
    });

    const stdoutText = stdout.join("");
    // The real-world failure mode this guards against: JSON.parse(stdout)
    // throwing because a second document got appended. Parsing must succeed
    // and yield exactly the success envelope, not the HUMANISH_UNEXPECTED one.
    const envelope = JSON.parse(stdoutText) as { schema: string; ok: boolean };
    expect(envelope).toEqual({ schema: "humanish.test-scratch-result.v1", ok: true });
    // Exactly one write reached stdout: the success envelope. The catch-all did
    // not additionally write there.
    expect(stdout).toHaveLength(1);
    expect(stderr.join("")).toContain("HUMANISH_UNEXPECTED:");
    expect(stderr.join("")).toContain("scratch failure after a successful write");
    expect(exitCode).toBe(2);
  });

  it.skipIf(isRunningAsRoot())(
    "discriminates a real runs I/O failure from an empty runs directory",
    async () => {
      await withTempApp({}, async (cwd) => {
        const runsRoot = path.join(cwd, ".humanish", "runs");
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
          expect(envelope.schema).toBe("humanish.runs-result.v1");
          expect(envelope.ok).toBe(false);
          expect(envelope.runs).toEqual([]);
          expect(envelope.latest).toBeNull();
          expect(envelope.error.code).toBe("HUMANISH_RUNS_UNAVAILABLE");
          expect(envelope.error.message).not.toContain(cwd);
        } finally {
          await chmod(runsRoot, 0o755);
        }
      });
    },
  );

  it("reports ok:true with an empty list for a fresh cwd with no .humanish/runs yet (not an error)", async () => {
    await withTempApp({}, async (cwd) => {
      const result = await runCli(["runs", "--cwd", cwd, "--json"]);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as {
        ok: boolean;
        runs: unknown[];
        latest: string | null;
      };
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

  it("exports the library surface and none of the CLI", () => {
    const golden = JSON.parse(
      readFileSync(new URL("../golden/public-api.json", import.meta.url), "utf8"),
    ) as { values: string[] };
    expect(Object.keys(humanishIndex).sort()).toEqual(golden.values);
    for (const cliName of ["createProgram", "CLI_RESPONSE_SCHEMA", "normalizeCliArgv", "doctor"])
      expect(humanishIndex).not.toHaveProperty(cliName);
  });
});

describe("resolveRouteShouldOpen (shared lab-route auto-open gate)", () => {
  const origTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdout.isTTY = origTTY;
  });

  it("--no-open (open=false) never opens, even on a TTY watch", () => {
    process.stdout.isTTY = true;
    expect(
      resolveRouteShouldOpen({
        optionOpen: false,
        defaultsOpen: undefined,
        mode: "watch",
        wantsMachine: false,
      }),
    ).toBe(false);
  });

  it("--json (machine mode) only opens with an explicit --open", () => {
    process.stdout.isTTY = true;
    expect(
      resolveRouteShouldOpen({
        optionOpen: undefined,
        defaultsOpen: undefined,
        mode: "watch",
        wantsMachine: true,
      }),
    ).toBe(false);
    expect(
      resolveRouteShouldOpen({
        optionOpen: true,
        defaultsOpen: undefined,
        mode: "watch",
        wantsMachine: true,
      }),
    ).toBe(true);
  });

  it("human watch opens on a real TTY and not without one (the fix)", () => {
    process.stdout.isTTY = true;
    expect(
      resolveRouteShouldOpen({
        optionOpen: undefined,
        defaultsOpen: undefined,
        mode: "watch",
        wantsMachine: false,
      }),
    ).toBe(true);
    process.stdout.isTTY = false;
    expect(
      resolveRouteShouldOpen({
        optionOpen: undefined,
        defaultsOpen: undefined,
        mode: "watch",
        wantsMachine: false,
      }),
    ).toBe(false);
  });

  it("run mode never auto-opens by default (only watch does)", () => {
    process.stdout.isTTY = true;
    expect(
      resolveRouteShouldOpen({
        optionOpen: undefined,
        defaultsOpen: undefined,
        mode: "run",
        wantsMachine: false,
      }),
    ).toBe(false);
  });

  it("lab-config defaults.open wins over the TTY fallback", () => {
    process.stdout.isTTY = false;
    expect(
      resolveRouteShouldOpen({
        optionOpen: undefined,
        defaultsOpen: true,
        mode: "run",
        wantsMachine: false,
      }),
    ).toBe(true);
  });
});

interface ServeEnvelope {
  schema: string;
  ok: boolean;
  mode: string;
  safe: boolean;
  host: string;
  port?: number;
  url?: string;
  publicUrl?: string;
  tunnel?: { provider: string; url: string };
  oauth?: { provider: string; allowEmails: string[]; allowDomains: string[] };
  runsListed: number;
  shareReadyCount?: number;
  entryRunId?: string;
  warnings: string[];
  error?: { code: string; message: string };
}

const SERVE_LAB_FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
  "humanish/labs/first-run.yaml": [
    "schema: humanish.lab.v2",
    "id: first-run",
    "subject:",
    "  source: this-repo",
    "actors:",
    "  - type: synthetic-persona",
    "    count: 2",
    "scenario:",
    "  mode: dry-run",
  ].join("\n"),
};

async function seedDryRunBundle(cwd: string, runId: string): Promise<void> {
  const seeded = await runCli(["run", "first-run", "--cwd", cwd, "--run-id", runId, "--json"]);
  expect(seeded.exitCode, `seeding dry-run bundle ${runId}`).toBe(0);
}

// serve's action awaits serveObserveUntilSignal, so the CLI promise must run
// unawaited while the test polls its output and then delivers the stop signal
// (the watch signal-cleanup technique, with process itself as the target).
function startAttachedCli(args: string[]): {
  exitCode: () => number;
  stdout: () => string;
  stderr: () => string;
  finished: Promise<void>;
} {
  let exitCode = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = createProgram({
    writeOut: (text) => stdout.push(text),
    writeErr: (text) => stderr.push(text),
    setExitCode: (code) => {
      exitCode = code;
    },
  });
  program.exitOverride();
  const finished = program
    .parseAsync(["node", "humanish", ...args], { from: "node" })
    .then(() => undefined);
  return {
    exitCode: () => exitCode,
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
    finished,
  };
}

async function waitForOutput(
  read: () => string,
  needle: string,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!read().includes(needle)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for ${JSON.stringify(needle)}; saw: ${JSON.stringify(read())}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// serve registers its stop handler with process.once("SIGTERM", ...); invoking
// exactly the listeners that appeared since the snapshot mirrors the watch
// test's signalTarget.emit without tripping the test runner's own handlers.
function sigtermListenersSince(preexisting: ReadonlySet<unknown>): NodeJS.SignalsListener[] {
  return process.listeners("SIGTERM").filter((listener) => !preexisting.has(listener));
}

function portRefusesConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(true));
  });
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        reject(new Error("port probe did not bind a TCP port"));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

describe("humanish serve command", () => {
  // `serve` is the hidden alias of `observe --all` until 0.109.0; both serve the same library.
  it.each([[["observe", "--all"]], [["serve"]]])(
    "%j serves the run library over loopback with a machine envelope, then tears down once on SIGTERM",
    async (command) => {
      await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
        await seedDryRunBundle(cwd, "serve-loopback-run");

        const preexisting = new Set<unknown>(process.listeners("SIGTERM"));
        const cli = startAttachedCli([
          ...command,
          "--run",
          "serve-loopback-run",
          "--cwd",
          cwd,
          "--json",
          "--no-open",
        ]);
        await waitForOutput(cli.stderr, "serving: press Ctrl-C to stop");

        const envelope = JSON.parse(cli.stdout()) as ServeEnvelope;
        expect(envelope.schema).toBe("humanish.serve-result.v1");
        expect(envelope.ok).toBe(true);
        expect(envelope.mode).toBe("loopback");
        expect(envelope.safe).toBe(false);
        expect(envelope.host).toBe("127.0.0.1");
        expect(envelope.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
        expect(envelope.oauth).toBeUndefined();
        expect(envelope.runsListed).toBe(1);
        expect(envelope.entryRunId).toBe("serve-loopback-run");
        expect(cli.stderr().split("humanish serve is deprecated").length - 1).toBe(
          command[0] === "serve" ? 1 : 0,
        );

        // Mirror the watch signal test: deliver SIGTERM twice; the stop path must
        // run exactly once and exit with exitCodeForSignal(SIGTERM).
        const listeners = sigtermListenersSince(preexisting);
        expect(listeners).toHaveLength(1);
        for (const listener of listeners) listener("SIGTERM");
        for (const listener of listeners) listener("SIGTERM");
        await cli.finished;

        expect(cli.exitCode()).toBe(143);
        expect(cli.stderr().split("observe stopped").length - 1).toBe(1);
        expect(cli.stderr()).not.toContain("cleanup failed");
      });
    },
  );

  it("rejects conflicting or unsafe serve option combinations with exit 2 and exact error codes (fail-closed matrix)", async () => {
    await withTempApp(
      { "package.json": JSON.stringify({ name: "fixture-app" }, null, 2) },
      async (cwd) => {
        const matrix: Array<{ args: string[]; code: string }> = [
          // Exposure requires either edge auth or --safe: a bare tunnel to local bundles is refused.
          {
            args: ["--expose", "--tunnel", "ngrok"],
            code: "HUMANISH_SERVE_EXPOSE_REQUIRES_EDGE_AUTH_OR_SAFE",
          },
          // --oauth is only meaningful on the ngrok edge.
          { args: ["--oauth", "google"], code: "HUMANISH_SERVE_OAUTH_REQUIRES_TUNNEL" },
          { args: ["--expose", "--oauth", "google"], code: "HUMANISH_SERVE_OAUTH_REQUIRES_TUNNEL" },
          // Allow rules require --oauth.
          { args: ["--allow-email", "a@example.com"], code: "HUMANISH_SERVE_ALLOW_REQUIRES_OAUTH" },
          // Tunnel + public-url are mutually exclusive origins.
          {
            args: [
              "--expose",
              "--tunnel",
              "ngrok",
              "--oauth",
              "google",
              "--public-url",
              "https://observer.example.com",
            ],
            code: "HUMANISH_SERVE_OPTION_CONFLICT",
          },
          { args: ["--tunnel", "ngrok"], code: "HUMANISH_SERVE_TUNNEL_REQUIRES_EXPOSE" },
          {
            args: ["--tunnel-domain", "observer.example.com"],
            code: "HUMANISH_SERVE_OPTION_CONFLICT",
          },
          {
            args: ["--public-url", "https://observer.example.com"],
            code: "HUMANISH_SERVE_OPTION_CONFLICT",
          },
          { args: ["--expose", "--public-url", "notaurl"], code: "HUMANISH_SERVE_OPTION_CONFLICT" },
          { args: ["--port", "99999"], code: "HUMANISH_INVALID_PORT" },
        ];

        for (const row of matrix) {
          const result = await runCli([
            "observe",
            "--all",
            "--cwd",
            cwd,
            "--json",
            "--no-open",
            ...row.args,
          ]);
          const envelope = JSON.parse(result.stdout) as ServeEnvelope;
          expect(result.exitCode, `exit code for: ${row.args.join(" ")}`).toBe(2);
          expect(envelope.error?.code, `error code for: ${row.args.join(" ")}`).toBe(row.code);
        }
      },
    );
  });

  it("rejects the removed --auth and --ttl flags as unknown options (capability-link machinery deleted)", async () => {
    await withTempApp(
      { "package.json": JSON.stringify({ name: "fixture-app" }, null, 2) },
      async (cwd) => {
        for (const removed of [
          ["--auth", "link"],
          ["--auth", "none"],
          ["--ttl", "5"],
        ]) {
          // The flags are gone: commander refuses the unknown option (a non-zero exit, surfaced here as
          // a thrown error), rather than silently accepting a no-op: the pre-1.0 breaking change.
          await expect(
            runCli(["observe", "--all", "--cwd", cwd, "--json", "--no-open", ...removed]),
          ).rejects.toThrow();
        }
      },
    );
  });

  it("fails HUMANISH_RUN_NOT_FOUND for an unknown --run before printing any serving banner", async () => {
    await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
      await seedDryRunBundle(cwd, "serve-entry-run");

      const result = await runCli([
        "observe",
        "--all",
        "--run",
        "nope",
        "--cwd",
        cwd,
        "--json",
        "--no-open",
      ]);
      const envelope = JSON.parse(result.stdout) as ServeEnvelope;
      expect(result.exitCode).toBe(2);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe("HUMANISH_RUN_NOT_FOUND");
      // Fail-before-bind pin: the attach banner must never appear on either stream.
      expect(result.stdout).not.toContain("serving:");
      expect(result.stderr).not.toContain("serving:");
    });
  });

  it("refuses to serve a blocked run under --safe, naming the shareSafety status and reason code", async () => {
    await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
      await seedDryRunBundle(cwd, "serve-blocked-run");
      // Same poisoning pattern as the run.test.ts public-safety scan test: a
      // secret-shaped token in a text artifact drives verify to blocked.
      await writeFile(
        path.join(cwd, ".humanish/runs/serve-blocked-run/events.ndjson"),
        `{"message":"synthetic ${"sk-" + "testsecretvalue1234567890abcd"}"}\n`,
        "utf8",
      );

      const result = await runCli([
        "observe",
        "--all",
        "--safe",
        "--run",
        "serve-blocked-run",
        "--cwd",
        cwd,
        "--json",
        "--no-open",
      ]);
      const envelope = JSON.parse(result.stdout) as ServeEnvelope;
      expect(result.exitCode).toBe(2);
      expect(envelope.error?.code).toBe("HUMANISH_SERVE_RUN_NOT_SHAREABLE");
      expect(envelope.error?.message).toContain("blocked");
      expect(envelope.error?.message).toContain("PUBLIC_SAFETY_FINDINGS");
    });
  });

  it("exposes the library under --expose --public-url (operator-secured edge; no in-process token)", async () => {
    await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
      await seedDryRunBundle(cwd, "serve-exposed-run");

      const preexisting = new Set<unknown>(process.listeners("SIGTERM"));
      const cli = startAttachedCli([
        "observe",
        "--all",
        "--cwd",
        cwd,
        "--expose",
        "--public-url",
        "https://observer.example.com",
        "--json",
        "--no-open",
      ]);
      await waitForOutput(cli.stderr, "serving: press Ctrl-C to stop");

      const envelope = JSON.parse(cli.stdout()) as ServeEnvelope;
      expect(envelope.mode).toBe("exposed");
      // No capability-link machinery: the JSON envelope carries no in-process token/url of any kind.
      expect((envelope as { capabilityUrl?: string }).capabilityUrl).toBeUndefined();
      expect((envelope as { publicCapabilityUrl?: string }).publicCapabilityUrl).toBeUndefined();
      expect(envelope.publicUrl).toBe("https://observer.example.com");
      expect(envelope.warnings.join("\n")).toContain(`all ${envelope.runsListed} local runs`);

      for (const listener of sigtermListenersSince(preexisting)) listener("SIGTERM");
      await cli.finished;
      expect(cli.exitCode()).toBe(143);
    });
  });

  it("serves share_ready runs openly under --safe --expose --tunnel (no edge auth), naming the public origin", async () => {
    await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
      await seedDryRunBundle(cwd, "serve-open-run");

      const stubDir = await mkdtemp(path.join(os.tmpdir(), "humanish-ngrok-stub-"));
      const startedTunnelLine = `{"addr":"http://localhost:8732","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-08-01T23:33:48.610569992Z","url":"https://observer.example.com"}`;
      await writeFile(
        path.join(stubDir, "ngrok"),
        [
          "#!/bin/sh",
          `trap 'kill "$SLEEP_PID" 2>/dev/null; exit 0' TERM INT`,
          `printf '%s\\n' '${startedTunnelLine}'`,
          "sleep 120 &",
          "SLEEP_PID=$!",
          'wait "$SLEEP_PID"',
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );
      const originalPath = process.env.PATH;
      process.env.PATH = `${stubDir}${path.delimiter}${originalPath ?? ""}`;
      try {
        const preexisting = new Set<unknown>(process.listeners("SIGTERM"));
        const cli = startAttachedCli([
          "observe",
          "--all",
          "--cwd",
          cwd,
          "--safe",
          "--expose",
          "--tunnel",
          "ngrok",
          "--json",
          "--no-open",
        ]);
        await waitForOutput(cli.stderr, "serving: press Ctrl-C to stop");

        const envelope = JSON.parse(cli.stdout()) as ServeEnvelope;
        expect(envelope.mode).toBe("share-safe-open");
        expect(envelope.oauth).toBeUndefined();
        expect(envelope.shareReadyCount).toBe(1);
        expect(envelope.warnings.join("\n")).toContain("https://observer.example.com");

        for (const listener of sigtermListenersSince(preexisting)) listener("SIGTERM");
        await cli.finished;
        expect(cli.exitCode()).toBe(143);
      } finally {
        process.env.PATH = originalPath;
        await rm(stubDir, { force: true, recursive: true });
      }
    });
  });

  it("starts the ngrok tunnel with edge OAuth args against the loopback port and tears both down on SIGTERM", async () => {
    await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
      await seedDryRunBundle(cwd, "serve-tunnel-run");

      const stubDir = await mkdtemp(path.join(os.tmpdir(), "humanish-ngrok-stub-"));
      const teardownMarker = path.join(stubDir, "ngrok-teardown-marker");
      const argsMarker = path.join(stubDir, "ngrok-args");
      // Started-tunnel log line field shape captured from a real ngrok 3.x
      // `--log stdout --log-format json` session, with the url genericized.
      const startedTunnelLine = `{"addr":"http://localhost:8732","lvl":"info","msg":"started tunnel","name":"command_line","obj":"tunnels","t":"2026-08-01T23:33:48.610569992Z","url":"https://observer.example.com"}`;
      await writeFile(
        path.join(stubDir, "ngrok"),
        [
          "#!/bin/sh",
          "# Stub ngrok: record argv, emit one started-tunnel line, wait for SIGTERM, record teardown.",
          `printf '%s\\n' "$@" > "${argsMarker}"`,
          `trap 'touch "${teardownMarker}"; kill "$SLEEP_PID" 2>/dev/null; exit 0' TERM INT`,
          `printf '%s\\n' '${startedTunnelLine}'`,
          "sleep 120 &",
          "SLEEP_PID=$!",
          'wait "$SLEEP_PID"',
          "",
        ].join("\n"),
        { encoding: "utf8", mode: 0o755 },
      );

      const originalPath = process.env.PATH;
      process.env.PATH = `${stubDir}${path.delimiter}${originalPath ?? ""}`;
      try {
        const preexisting = new Set<unknown>(process.listeners("SIGTERM"));
        const cli = startAttachedCli([
          "observe",
          "--all",
          "--cwd",
          cwd,
          "--expose",
          "--tunnel",
          "ngrok",
          "--oauth",
          "google",
          "--allow-email",
          "you@example.com",
          "--json",
          "--no-open",
        ]);
        await waitForOutput(cli.stderr, "serving: press Ctrl-C to stop");

        const envelope = JSON.parse(cli.stdout()) as ServeEnvelope;
        expect(envelope.mode).toBe("exposed");
        expect(envelope.tunnel).toEqual({ provider: "ngrok", url: "https://observer.example.com" });
        expect(envelope.publicUrl).toBe("https://observer.example.com");
        expect(envelope.oauth).toEqual({
          provider: "google",
          allowEmails: ["you@example.com"],
          allowDomains: [],
        });
        // No in-process token leaked into the envelope.
        expect((envelope as { capabilityUrl?: string }).capabilityUrl).toBeUndefined();
        if (typeof envelope.port !== "number") {
          throw new Error("expected a bound port in the serve envelope");
        }

        // ngrok was actually invoked with the mapped edge OAuth args.
        const recordedArgs = (await readFile(argsMarker, "utf8")).split("\n").filter(Boolean);
        expect(recordedArgs).toContain("--oauth");
        expect(recordedArgs).toContain("google");
        expect(recordedArgs).toContain("--oauth-allow-email");
        expect(recordedArgs).toContain("you@example.com");

        for (const listener of sigtermListenersSince(preexisting)) listener("SIGTERM");
        await cli.finished;
        expect(cli.exitCode()).toBe(143);
        await expect(stat(teardownMarker)).resolves.toBeTruthy();
        expect(await portRefusesConnections(envelope.port)).toBe(true);
      } finally {
        process.env.PATH = originalPath;
        await rm(stubDir, { force: true, recursive: true });
      }
    });
  });

  it("fails HUMANISH_SERVE_TUNNEL_NOT_FOUND when ngrok is absent and tears the bound server down", async () => {
    await withTempApp(
      { "package.json": JSON.stringify({ name: "fixture-app" }, null, 2) },
      async (cwd) => {
        await mkdir(path.join(cwd, ".humanish", "runs"), { recursive: true });

        const emptyDir = await mkdtemp(path.join(os.tmpdir(), "humanish-empty-path-"));
        const port = await findFreePort();
        const originalPath = process.env.PATH;
        // The CLI runs in-process and spawns nothing but ngrok on this path, so a
        // `PATH` of one empty directory makes that exact spawn fail ENOENT.
        process.env.PATH = emptyDir;
        try {
          const result = await runCli([
            "observe",
            "--all",
            "--cwd",
            cwd,
            "--expose",
            "--tunnel",
            "ngrok",
            "--oauth",
            "google",
            "--port",
            String(port),
            "--json",
            "--no-open",
          ]);
          const envelope = JSON.parse(result.stdout) as ServeEnvelope;
          expect(result.exitCode).toBe(2);
          expect(envelope.ok).toBe(false);
          expect(envelope.error?.code).toBe("HUMANISH_SERVE_TUNNEL_NOT_FOUND");
          expect(result.stdout).not.toContain("serving:");
          expect(result.stderr).not.toContain("serving:");
          expect(await portRefusesConnections(port)).toBe(true);
        } finally {
          process.env.PATH = originalPath;
          await rm(emptyDir, { force: true, recursive: true });
        }
      },
    );
  });
});

// A live-mode CUA study so prepareCuaWatch runs the exposure validator. Every case below is a refusal
// that aborts at validateExposure before runLab, so no sandbox/provider spend occurs ($0).
const CUA_LAB_FIXTURE: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
  "humanish/labs/cua-live.yaml": [
    "schema: humanish.lab.v2",
    "id: cua-live",
    "subject:",
    "  source: app-url",
    "  appUrl: http://127.0.0.1:3000/",
    "actors:",
    "  - type: openai-computer-use",
    "    persona: first-time-visitor",
    "    mission: Explore the app and stop.",
    "execution:",
    "  target: e2b-desktop",
    "  timeoutMs: 60000",
    "scenario:",
    "  mode: live",
  ].join("\n"),
};

interface CuaEnvelope {
  ok: boolean;
  error?: { code: string; message: string };
}

describe("humanish watch --expose (live CUA) fail-closed matrix", () => {
  it("refuses a live watch --expose --tunnel ngrok with no edge auth (edge auth is required)", async () => {
    await withTempApp(CUA_LAB_FIXTURE, async (cwd) => {
      // No --json: --json would trip the live-follow refusal first; here we isolate the edge-auth gate.
      const result = await runCli([
        "watch",
        "cua-live",
        "--cwd",
        cwd,
        "--no-open",
        "--expose",
        "--tunnel",
        "ngrok",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("HUMANISH_WATCH_EXPOSE_REQUIRES_EDGE_AUTH");
      // Aborted before any run: no attach/serving banner.
      expect(result.stdout).not.toContain("watching:");
      expect(result.stderr).not.toContain("watching:");
    });
  });

  it("refuses a live watch --expose --safe with SAFE_NOT_APPLICABLE (--safe is a `serve` filter, not a watch gate)", async () => {
    await withTempApp(CUA_LAB_FIXTURE, async (cwd) => {
      const result = await runCli([
        "watch",
        "cua-live",
        "--cwd",
        cwd,
        "--no-open",
        "--expose",
        "--safe",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("HUMANISH_WATCH_SAFE_NOT_APPLICABLE");
    });
  });

  it("refuses watch --expose --json (no attached follow) with EXPOSE_REQUIRES_LIVE_FOLLOW", async () => {
    await withTempApp(CUA_LAB_FIXTURE, async (cwd) => {
      const result = await runCli([
        "watch",
        "cua-live",
        "--cwd",
        cwd,
        "--no-open",
        "--expose",
        "--tunnel",
        "ngrok",
        "--oauth",
        "google",
        "--json",
      ]);
      expect(result.exitCode).toBe(2);
      const envelope = JSON.parse(result.stdout) as CuaEnvelope;
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe("HUMANISH_WATCH_EXPOSE_REQUIRES_LIVE_FOLLOW");
    });
  });

  it("refuses watch --expose --dry-run and --detach (no live desktop / no attached follow)", async () => {
    await withTempApp(CUA_LAB_FIXTURE, async (cwd) => {
      for (const extra of [["--dry-run"], ["--detach"]]) {
        const result = await runCli([
          "watch",
          "cua-live",
          "--cwd",
          cwd,
          "--no-open",
          "--expose",
          "--tunnel",
          "ngrok",
          "--oauth",
          "google",
          ...extra,
        ]);
        expect(result.exitCode, extra.join(" ")).toBe(2);
        expect(result.stderr, extra.join(" ")).toContain(
          "HUMANISH_WATCH_EXPOSE_REQUIRES_LIVE_FOLLOW",
        );
      }
    });
  });

  it("refuses --oauth without --tunnel and --allow-email without --oauth", async () => {
    await withTempApp(CUA_LAB_FIXTURE, async (cwd) => {
      const noTunnel = await runCli([
        "watch",
        "cua-live",
        "--cwd",
        cwd,
        "--no-open",
        "--expose",
        "--oauth",
        "google",
      ]);
      expect(noTunnel.exitCode).toBe(2);
      expect(noTunnel.stderr).toContain("HUMANISH_WATCH_OAUTH_REQUIRES_TUNNEL");

      const noOauth = await runCli([
        "watch",
        "cua-live",
        "--cwd",
        cwd,
        "--no-open",
        "--expose",
        "--allow-email",
        "you@example.com",
      ]);
      expect(noOauth.exitCode).toBe(2);
      expect(noOauth.stderr).toContain("HUMANISH_WATCH_ALLOW_REQUIRES_OAUTH");
    });
  });

  it("refuses exposure on a non-CUA (synthetic) lab: no live desktop to stream", async () => {
    await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
      const result = await runCli([
        "watch",
        "first-run",
        "--cwd",
        cwd,
        "--no-open",
        "--expose",
        "--tunnel",
        "ngrok",
        "--oauth",
        "google",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("HUMANISH_WATCH_OPTION_CONFLICT");
    });
  });

  it("refuses exposure on the non-lab watch path (existing evidence)", async () => {
    await withTempApp(SERVE_LAB_FIXTURE, async (cwd) => {
      await seedDryRunBundle(cwd, "watch-existing-run");
      const result = await runCli([
        "watch",
        "--run",
        "latest",
        "--cwd",
        cwd,
        "--no-open",
        "--expose",
        "--tunnel",
        "ngrok",
        "--oauth",
        "google",
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("HUMANISH_WATCH_OPTION_CONFLICT");
    });
  });
});

describe("provider-key discovery at the CLI seam", () => {
  it("runs discovery on env-taking commands and announces fills on stderr", async () => {
    const calls: Array<{ cwd: string }> = [];
    const stderr: string[] = [];
    const program = createProgram({
      writeOut: () => {},
      writeErr: (text) => stderr.push(text),
      setExitCode: () => {},
      keyDiscovery: async (args) => {
        calls.push({ cwd: args.cwd });
        args.announce("humanish keys: FAKE_KEY from fake-source");
        return [{ name: "FAKE_KEY", source: "fake-source" }];
      },
    });
    program.exitOverride();
    // `lab preflight` goes through the same applyEnvFileOption seam as watch/run/lab run.
    try {
      await program.parseAsync(
        ["node", "humanish", "lab", "preflight", "missing-lab", "--cwd", "/nonexistent", "--json"],
        { from: "node" },
      );
    } catch {
      // The command itself may fail on the bogus cwd; the seam runs first.
    }
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(stderr.join("")).toContain("humanish keys: FAKE_KEY from fake-source");
    expect(stderr.join("")).not.toContain("fake-value");
  });

  it("`humanish keys list` reports an empty store without ever printing values", async () => {
    const result = await runCli(["keys", "list", "--json"]);
    const envelope = JSON.parse(result.stdout) as {
      schema: string;
      ok: boolean;
      action: string;
      names: string[];
    };
    expect(envelope.schema).toBe("humanish.keys-result.v1");
    expect(envelope.ok).toBe(true);
    expect(envelope.action).toBe("list");
    expect(Array.isArray(envelope.names)).toBe(true);
  });
});

describe("lab provenance survives the whole CLI path", () => {
  // This test exists because a live run caught what the unit tests could not: the provenance was
  // built at the resolution site and forwarded through nine `runLab` call sites, and three of them
  // silently dropped it: TypeScript cannot catch that, because a spread of an optional field is
  // never an excess-property error. So the guard has to run the CLI end to end and read the disk.
  it("`lab run` stamps the resolved study into the bundle and the status record", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-lab-provenance-"));
    try {
      const labPath = path.join(cwd, "humanish", "labs", "provenance-demo.yaml");
      await mkdir(path.dirname(labPath), { recursive: true });
      await writeFile(
        labPath,
        [
          "schema: humanish.lab.v2",
          "id: provenance-demo",
          "subject:",
          "  source: this-repo",
          "actors:",
          "  - type: synthetic-persona",
          "scenario:",
          "  mode: dry-run",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = await runCli([
        "lab",
        "run",
        "provenance-demo",
        "--cwd",
        cwd,
        "--json",
        "--no-open",
      ]);
      expect(result.exitCode).toBe(0);

      const runsDir = path.join(cwd, ".humanish", "runs");
      const runId = (await readdir(runsDir)).find((entry) => entry.startsWith("dryrun-"));
      expect(runId).toBeDefined();

      const bundle = JSON.parse(await readFile(path.join(runsDir, runId!, "run.json"), "utf8")) as {
        lab?: { id: string; path?: string; origin?: string };
      };
      expect(bundle.lab).toEqual({
        id: "provenance-demo",
        path: path.join("humanish", "labs", "provenance-demo.yaml"),
        origin: "committed",
      });

      const status = JSON.parse(
        await readFile(path.join(runsDir, runId!, "status.json"), "utf8"),
      ) as {
        schema: string;
        state: string;
        mode: string;
        lab?: { id: string };
      };
      expect(status.schema).toBe("humanish.run-status.v1");
      expect(status.state).toBe("finished");
      expect(status.mode).toBe("dry-run");
      expect(status.lab?.id).toBe("provenance-demo");
    } finally {
      await rm(cwd, { force: true, recursive: true });
    }
  });
});

describe("study facts ride the result seam", () => {
  it("writeResult reads a study's facts for telemetry, once, for whichever backend wrote it", () => {
    const io = { writeOut: () => {}, writeErr: () => {}, setExitCode: () => {} };
    const program = createProgram(io);
    const command = program.command("probe-study-facts");
    writeResult(
      command,
      io,
      {
        schema: "humanish.study-result.v1",
        ok: true,
        labId: "try-live",
        actor: "openai-computer-use",
        dryRun: false,
        session: { status: "abandoned", completionReason: "gave_up", reason: "", screenshots: 3 },
      },
      () => "",
    );
    expect(runFactsFor(command)).toEqual({
      mode: "live",
      lab: "try-live",
      outcome: "abandoned",
      brain: "provider-key",
    });
    // A command that wrote no study leaves nothing behind.
    const other = program.command("probe-nothing");
    writeResult(
      other,
      io,
      { schema: "humanish.doctor-result.v1", ok: true, cwd: "/x", checks: [] },
      () => "",
    );
    expect(runFactsFor(other)).toEqual({});
  });
});

describe("HUMANISH_DEBUG_HANDLES", () => {
  it("names what is still alive after a command settles, and only when asked", async () => {
    const previous = process.env.HUMANISH_DEBUG_HANDLES;
    const stderr: string[] = [];
    const io = {
      writeOut: () => {},
      writeErr: (text: string) => {
        stderr.push(text);
      },
      setExitCode: () => {},
    };
    const program = createProgram(io);
    program.command("__probe-handles").action(() => {});
    try {
      process.env.HUMANISH_DEBUG_HANDLES = "1";
      await program.parseAsync(["node", "humanish", "__probe-handles"]);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(stderr.join("")).toMatch(
        /humanish debug: active resources after `__probe-handles` settled: /,
      );
      stderr.length = 0;
      delete process.env.HUMANISH_DEBUG_HANDLES;
      await program.parseAsync(["node", "humanish", "__probe-handles"]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(stderr.join("")).not.toContain("active resources");
    } finally {
      if (previous === undefined) delete process.env.HUMANISH_DEBUG_HANDLES;
      else process.env.HUMANISH_DEBUG_HANDLES = previous;
    }
  });
});

describe("a taken port at the command boundary", () => {
  it("is HUMANISH_PORT_IN_USE in the JSON envelope and on stderr, never HUMANISH_UNEXPECTED", async () => {
    const { PortInUseError } = await import("../../src/observer/listen.js");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      writeOut: (t: string) => {
        stdout.push(t);
      },
      writeErr: (t: string) => {
        stderr.push(t);
      },
      setExitCode: () => {},
    };
    const program = createProgram(io);
    program
      .command("__probe-port")
      .option("--json")
      .action(() => {
        throw new PortInUseError(8791, "humanish");
      });
    await program.parseAsync(["node", "humanish", "__probe-port", "--json"]);
    const envelope = JSON.parse(stdout.join("")) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("HUMANISH_PORT_IN_USE");
    expect(envelope.error.message).toContain("8791");
    expect(envelope.error.message).toContain("another humanish process");
    stdout.length = 0;
    await program.parseAsync(["node", "humanish", "__probe-port"]);
    expect(stderr.join("")).toMatch(/^HUMANISH_PORT_IN_USE: /);
  });
});

describe("run writes the same bundle watch does", () => {
  it("a `run` bundle carries observer/index.html, so it can be exported and opened like a watched one", async () => {
    await withTempApp(
      {
        "package.json": JSON.stringify({ name: "fixture-app" }, null, 2),
        "humanish/labs/first-run.yaml": [
          "schema: humanish.lab.v2",
          "id: first-run",
          "title: First run",
          "subject:",
          "  source: this-repo",
          "actors:",
          "  - type: synthetic-persona",
          "    count: 2",
        ].join("\n"),
      },
      async (cwd) => {
        const viaLab = await runCli([
          "lab",
          "run",
          "first-run",
          "--cwd",
          cwd,
          "--json",
          "--no-open",
        ]);
        expect(viaLab.exitCode).toBe(0);
        const labEnvelope = JSON.parse(viaLab.stdout) as {
          ok: boolean;
          runId?: string;
          warnings: string[];
        };
        expect(labEnvelope.ok).toBe(true);
        expect(
          labEnvelope.warnings.some((w) => w.includes("observer/index.html was not written")),
        ).toBe(false);
        await expect(
          stat(path.join(cwd, ".humanish", "runs", labEnvelope.runId!, "observer", "index.html")),
        ).resolves.toBeTruthy();

        const direct = await runCli(["run", "--cwd", cwd, "--json", "--dry-run"]);
        expect(direct.exitCode).toBe(0);
        const directEnvelope = JSON.parse(direct.stdout) as { ok: boolean; runId?: string };
        expect(directEnvelope.ok).toBe(true);
        await expect(
          stat(
            path.join(cwd, ".humanish", "runs", directEnvelope.runId!, "observer", "index.html"),
          ),
        ).resolves.toBeTruthy();
      },
    );
  });
});

describe("CUA ending output", () => {
  it("shows distinct lane causes without calling the first lane the whole session", () => {
    const output = formatCuaLabHuman({
      schema: "humanish.study-result.v1",
      route: "computer-use",
      studyId: "synthetic",
      labId: "synthetic",
      ok: false,
      cwd: "/synthetic",
      actor: "openai-computer-use",
      appUrl: "http://127.0.0.1:3000/",
      dryRun: false,
      runId: "synthetic",
      warnings: [],
      diagnostics: { category: "mixed", stopCause: "mixed" },
      session: {
        status: "incomplete",
        completionReason: "budget_reached",
        stopCause: "provider_output_limit",
        reason: "Synthetic",
        screenshots: 0,
      },
      lanes: ["provider_output_limit", "time_limit"].map((stopCause, index) => ({
        id: `lane-${index + 1}`,
        index: index + 1,
        persona: "synthetic",
        device: "desktop",
        resolution: [1440, 950] as [number, number],
        status: "incomplete" as const,
        ok: false,
        subject: { source: "app-url" as const, state: { provenance: "undeclared" as const } },
        diagnostics: {
          category: "session_interrupted" as const,
          stopCause: stopCause as "provider_output_limit" | "time_limit",
        },
      })),
    });
    expect(output).toContain("diagnostic: mixed endings (mixed)");
    expect(output).toContain(
      "participant lane-1: incomplete · session interrupted (provider output limit)",
    );
    expect(output).toContain("participant lane-2: incomplete · session interrupted (time limit)");
    expect(output).not.toContain("session: incomplete");
  });

  it("prints and verifies an actual N2 preview with no live participant verdict", async () => {
    const manifest = {
      schema: "humanish.lab.v2",
      id: "preview",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", count: 2 }],
      execution: { target: "e2b-desktop" },
    };
    await withTempApp({ "humanish/labs/preview.yaml": JSON.stringify(manifest) }, async (cwd) => {
      const result = await runCli([
        "lab",
        "run",
        "preview",
        "--dry-run",
        "--no-open",
        "--cwd",
        cwd,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("diagnostic: preview");
      expect(result.stdout).toContain(
        "humanish run preview: dry run finished\nroute: computer-use\n",
      );
      expect(result.stdout.match(/dry run, nothing ran live · preview/g)).toHaveLength(2);
      const verified = await runCli(["verify", "--run", "latest", "--cwd", cwd, "--json"]);
      expect(verified.exitCode).toBe(0);
      expect(JSON.parse(verified.stdout).ok).toBe(true);
    });
  });
});

describe("CLI argv normalization", () => {
  it("supports pnpm script proof commands with a literal separator", () => {
    expect(normalizeCliArgv(["node", "humanish", "--", "--help"])).toEqual([
      "node",
      "humanish",
      "--help",
    ]);
  });

  it("leaves normal binary invocation arguments alone", () => {
    expect(normalizeCliArgv(["node", "humanish", "init", "--dry-run"])).toEqual([
      "node",
      "humanish",
      "init",
      "--dry-run",
    ]);
  });
});
