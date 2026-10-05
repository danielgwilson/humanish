import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runDryRun } from "../../src/run/dry-run.js";

// In an agent's shell or a pipe nobody sends Ctrl-C, so `watch` and `observe` print the Observer
// path and exit there. Each child is bounded by a timeout, so a command that waits for a signal
// fails the test instead of hanging it.

const CLI = [process.execPath, "--import", import.meta.resolve("tsx"), path.resolve("src/cli.ts")];
const PTY_WRAPPER = "/usr/bin/script";
const AGENT_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
  "AI_AGENT",
];

function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HUMANISH_STRICT_KEYS: "1",
    HUMANISH_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
  };
  for (const marker of AGENT_MARKERS) delete env[marker];
  return { ...env, ...extra };
}

let cwd: string | undefined;
afterEach(async () => {
  if (cwd !== undefined) await rm(cwd, { recursive: true, force: true });
  cwd = undefined;
});

async function project(): Promise<string> {
  cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-unattended-"));
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  return cwd;
}

/** The `observer:` path a human result prints. */
function observerPath(stdout: string, dir: string): string | undefined {
  const line = stdout.split("\n").find((entry) => entry.startsWith("observer: "));
  return line === undefined ? undefined : path.resolve(dir, line.slice("observer: ".length));
}

describe("watch and observe without an interactive terminal", () => {
  it("watch prints the run's Observer path and exits", async () => {
    const dir = await project();
    const child = spawnSync(CLI[0]!, [...CLI.slice(1), "watch", "--count", "1", "--cwd", dir], {
      env: cleanEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });

    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).not.toMatch(/^watching: /m);
    expect(existsSync(observerPath(child.stdout, dir) ?? "")).toBe(true);
  });

  it("observe prints the saved run's Observer path and exits, in human and JSON mode", async () => {
    const dir = await project();
    expect((await runDryRun({ cwd: dir, dryRun: true, runId: "saved" })).ok).toBe(true);

    const human = spawnSync(CLI[0]!, [...CLI.slice(1), "observe", "--run", "saved", "--cwd", dir], {
      env: cleanEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    expect(human.signal, human.stderr).toBeNull();
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).not.toMatch(/^serving: /m);
    expect(existsSync(observerPath(human.stdout, dir) ?? "")).toBe(true);

    const json = spawnSync(
      CLI[0]!,
      [...CLI.slice(1), "observe", "--run", "saved", "--cwd", dir, "--json"],
      { env: cleanEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
    );
    expect(json.signal, json.stderr).toBeNull();
    expect(json.status, json.stderr).toBe(0);
    const envelope = JSON.parse(json.stdout) as { ok: boolean; serverUrl?: string; run: string };
    expect(envelope).toMatchObject({ ok: true, run: "saved" });
    expect(envelope.serverUrl).toBeUndefined();
  });

  // util-linux `script` gives the child a terminal; the `script` on macOS takes other flags.
  it.skipIf(process.platform !== "linux" || !existsSync(PTY_WRAPPER)).each([
    { name: "observe", args: ["observe", "--run", "saved"], attached: /serving: http:\/\/127/ },
    { name: "watch", args: ["watch", "--count", "1"], attached: /watching: http:\/\/127/ },
  ])(
    "$name exits under a terminal an agent runner claims, and serves one a person holds until Ctrl-C",
    async ({ name, args, attached }) => {
      const dir = await project();
      expect((await runDryRun({ cwd: dir, dryRun: true, runId: "saved" })).ok).toBe(true);
      const command = [...CLI, ...args, "--cwd", dir, "--no-open"]
        .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
        .join(" ");

      const agent = spawnSync(PTY_WRAPPER, ["-qec", command, "/dev/null"], {
        env: cleanEnv({ CODEX_THREAD_ID: "synthetic-thread" }),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60_000,
      });
      expect(agent.signal, agent.stdout).toBeNull();
      expect(agent.status, agent.stdout).toBe(0);
      expect(agent.stdout).not.toMatch(attached);

      const person = spawn(PTY_WRAPPER, ["-qec", command, "/dev/null"], {
        env: cleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let interrupted = false;
      person.stdout.setEncoding("utf8");
      person.stdout.on("data", (chunk: string) => {
        output += chunk;
        // One Ctrl-C through the terminal, once the server says it is attached.
        if (!interrupted && output.includes("press Ctrl-C to stop")) {
          interrupted = true;
          person.stdin.write("\u0003");
        }
      });
      const ended = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          person.kill("SIGKILL");
          reject(new Error(`${name} never attached or never stopped: ${output}`));
        }, 60_000);
        // `close` waits for stdout to drain; `exit` can fire before the last line arrives.
        person.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(output).toMatch(attached);
      expect(output).toContain(`${name} stopped`);
      expect(ended).toBe(130);
    },
    90_000,
  );
});
