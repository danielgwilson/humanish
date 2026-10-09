import { execFile, spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  readDetachedLog,
  runDetachedStep,
  startDetachedProcess,
} from "../../src/substrates/detached.js";
import type { Shell, ShellResult } from "../../src/substrates/shell.js";

// Detached steps on this machine's bash. The scripted sandboxes in detached.test.ts answer every
// command from a table, so they never parse the wrapper script; bash does, here as in a sandbox.

/** A Shell over local bash. `start` makes the command a session leader, as `setsid -f` does on E2B. */
function localBashShell(): Shell {
  return {
    run: (command) =>
      new Promise<ShellResult>((resolve) => {
        execFile("bash", ["-c", command], { cwd: tmpdir() }, (error, stdout, stderr) => {
          const exitCode = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
          resolve({ exitCode, stdout, stderr });
        });
      }),
    async start(command) {
      spawn("bash", ["-c", command], { cwd: tmpdir(), detached: true, stdio: "ignore" }).unref();
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async writeFile(path, data) {
      await writeFile(path, typeof data === "string" ? data : new Uint8Array(data));
    },
  };
}

// Step directories live under /tmp/humanish-subject (src/substrates/detached.ts); the pid keeps
// parallel test workers apart.
const stepDirs: string[] = [];
afterAll(async () => {
  await Promise.all(stepDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

function stepName(label: string): string {
  const name = `detached-test-${process.pid}-${label}`;
  stepDirs.push(`/tmp/humanish-subject/${name}`);
  return name;
}

const STEP_TIMEOUT_MS = 10_000;

async function runOnBash(label: string, command: string) {
  const startedAt = performance.now();
  const result = await runDetachedStep(localBashShell(), {
    name: stepName(label),
    command,
    timeoutMs: STEP_TIMEOUT_MS,
    pollIntervalMs: 50,
  });
  return { result, elapsedMs: performance.now() - startedAt };
}

describe("runDetachedStep on bash", () => {
  it("fails a command bash cannot parse within seconds, with bash's message", async () => {
    const { result, elapsedMs } = await runOnBash("syntax", "if then echo built; fi");
    expect(result).toMatchObject({ ok: false, exitCode: 2, timedOut: false });
    expect(result.logTail).toContain("syntax error near unexpected token `then'");
    expect(elapsedMs).toBeLessThan(STEP_TIMEOUT_MS / 4);
  });

  it("fails a build whose heredoc is never closed within seconds, with bash's message", async () => {
    const { result, elapsedMs } = await runOnBash(
      "heredoc-open",
      "if true; then\n  cat <<'EOF'\n<h1>Pricing</h1>\nfi",
    );
    expect(result).toMatchObject({ ok: false, exitCode: 2, timedOut: false });
    expect(result.logTail).toContain("syntax error: unexpected end of file");
    expect(elapsedMs).toBeLessThan(STEP_TIMEOUT_MS / 4);
  });

  it("runs a build whose heredoc closes on its last line, as a trimmed YAML block leaves it", async () => {
    const { result } = await runOnBash("heredoc-closed", "cat <<'EOF'\n<h1>Pricing</h1>\nEOF");
    expect(result).toEqual({
      ok: true,
      exitCode: 0,
      timedOut: false,
      logTail: "<h1>Pricing</h1>\n",
    });
  });
});

describe("startDetachedProcess on bash", () => {
  it("leaves bash's message in the log of a server command it cannot parse", async () => {
    const shell = localBashShell();
    const name = stepName("start-syntax");
    await startDetachedProcess(shell, { name, command: "python3 -m http.server 8000 (" });
    await vi.waitFor(
      async () =>
        expect(await readDetachedLog(shell, name)).toContain(
          "syntax error near unexpected token `('",
        ),
      { timeout: STEP_TIMEOUT_MS / 4, interval: 50 },
    );
  });
});
