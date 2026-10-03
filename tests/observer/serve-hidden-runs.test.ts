import { cp } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProgram } from "../../src/cli/program.js";
import { serveObserverLibrary, type ServeLibraryServer } from "../../src/observer/serve.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { writeLocalOnlyRun } from "../helpers/local-only-run.js";
import { makeTestTempDir } from "../helpers/temp-dir.js";

// Every live run a new user makes is local_only until its screenshots are redacted, so the first
// `serve --safe` after a live run shows an empty library. It says how many runs it left out and
// why, and how to share one.

const openServers: ServeLibraryServer[] = [];
afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

async function project(): Promise<string> {
  const root = await makeTestTempDir("humanish-serve-hidden-");
  const app = path.join(root, "minimal-app");
  await cp(path.resolve("fixtures/minimal-app"), app, { recursive: true });
  return app;
}

async function safeLibrary(cwd: string): Promise<ServeLibraryServer> {
  const started = await serveObserverLibrary(cwd, {
    port: 0,
    safe: true,
    expose: false,
    edgeAuthed: false,
  });
  if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
  openServers.push(started.server);
  return started.server;
}

describe("serve --safe names the runs it leaves out", () => {
  it("groups hidden runs by grade and reasons, and leaves a share_ready run out of the count", async () => {
    const cwd = await project();
    expect((await runDryRun({ cwd, dryRun: true, runId: "ready" })).ok).toBe(true);
    await writeLocalOnlyRun(cwd, "raw-one");
    await writeLocalOnlyRun(cwd, "raw-two");

    const server = await safeLibrary(cwd);

    expect(server.runsListed).toBe(1);
    expect(server.hiddenRuns).toEqual([
      { status: "local_only", reasons: ["RAW_SCREENSHOTS"], runs: 2 },
    ]);
  });

  it("reports nothing hidden without --safe", async () => {
    const cwd = await project();
    await writeLocalOnlyRun(cwd, "raw-one");
    const started = await serveObserverLibrary(cwd, {
      port: 0,
      safe: false,
      expose: false,
      edgeAuthed: false,
    });
    if (!started.ok) throw new Error(started.error.message);
    openServers.push(started.server);

    expect(started.server.hiddenRuns).toBeUndefined();
  });

  it("prints the hidden runs and the redacted-copy step when every run is local_only", async () => {
    const cwd = await project();
    await writeLocalOnlyRun(cwd, "raw-one");
    await writeLocalOnlyRun(cwd, "raw-two");
    await writeLocalOnlyRun(cwd, "raw-three");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const before = new Set<unknown>(process.listeners("SIGTERM"));
    const program = createProgram({
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stderr.push(text),
      setExitCode: () => {},
    });
    program.exitOverride();
    const finished = program.parseAsync(
      ["node", "humanish", "observe", "--all", "--safe", "--cwd", cwd, "--no-open"],
      { from: "node" },
    );
    const start = Date.now();
    // Without --json the attach notes go to stdout, after the summary.
    while (!stdout.join("").includes("serving: press Ctrl-C to stop")) {
      if (Date.now() - start > 10_000)
        throw new Error(`serve never started: ${stdout.join("")}${stderr.join("")}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    for (const listener of process.listeners("SIGTERM"))
      if (!before.has(listener)) listener("SIGTERM");
    await finished;

    const lines = stdout.join("").split("\n");
    expect(lines).toContain("runs: 0");
    expect(lines).toContain("hidden: 3 runs not share_ready");
    expect(lines).toContain("  3 runs local_only (RAW_SCREENSHOTS)");
    expect(lines.find((line) => line.startsWith("share: "))).toContain(
      "humanish export --run <id> --format bundle --redact-screenshots --out <dir>",
    );
    expect(lines.find((line) => line.startsWith("why: "))).toContain("humanish verify --run <id>");
  });
});
