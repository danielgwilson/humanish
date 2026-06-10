import { describe, expect, it } from "vitest";

import type { E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { probeUrl, runDetachedStep, startDetachedProcess } from "../src/e2b-detached.js";

// A scripted sandbox: every commands.run is recorded; the handler decides stdout per call.
function makeScriptedDesktop(handler?: (command: string, calls: string[]) => { stdout?: string } | undefined) {
  const commands: string[] = [];
  const files: Array<{ path: string; data: string }> = [];
  const desktop = {
    sandboxId: "fake-detached",
    commands: {
      run: async (command: string) => {
        commands.push(command);
        return handler?.(command, commands) ?? { exitCode: 0, stdout: "" };
      }
    },
    files: {
      write: async (path: string, data: string | ArrayBuffer) => {
        files.push({ path, data: String(data) });
        return undefined;
      }
    },
    launch: async () => undefined,
    screenshot: async () => new Uint8Array(),
    wait: async () => undefined,
    stream: { getAuthKey: () => "", getUrl: () => "", start: async () => undefined }
  } as unknown as E2BDesktopSandbox;
  return { desktop, commands, files };
}

// Deterministic timers: now() reads a clock that only sleep() advances.
function fakeTimers() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    }
  };
}

describe("runDetachedStep", () => {
  it("writes a heredoc-free wrapper script, launches via setsid, and reads the atomic status", async () => {
    const { desktop, commands, files } = makeScriptedDesktop((command) => {
      if (command.includes("/status")) return { stdout: "0\n" };
      if (command.includes("tail -c")) return { stdout: "build ok" };
      return undefined;
    });

    const result = await runDetachedStep(desktop, {
      name: "subject-build",
      command: "pnpm build",
      cwd: "/home/user/subject",
      timeoutMs: 60_000,
      ...fakeTimers()
    });

    expect(result).toEqual({ ok: true, exitCode: 0, timedOut: false, logTail: "build ok" });

    // The wrapper is a real file write — never a heredoc (no sentinel-collision class).
    const script = files.find((file) => file.path.endsWith("subject-build/run.sh"));
    expect(script).toBeDefined();
    expect(script?.data).toContain("( pnpm build )");
    expect(script?.data).toContain("cd '/home/user/subject'");
    // Atomic status: write tmp, then mv — a poller can never read a half-written code.
    expect(script?.data).toContain("status.tmp");
    expect(script?.data).toMatch(/mv .*status\.tmp.*status/);
    expect(script?.data).not.toContain("<<");
    // Detached launch from its own session so the group is killable.
    expect(commands.some((command) => command.includes("setsid -f"))).toBe(true);
  });

  it("reports a non-zero exit honestly with the log tail", async () => {
    const { desktop } = makeScriptedDesktop((command) => {
      if (command.includes("/status")) return { stdout: "3" };
      if (command.includes("tail -c")) return { stdout: "ERR something broke" };
      return undefined;
    });
    const result = await runDetachedStep(desktop, {
      name: "subject-install",
      command: "pnpm install",
      timeoutMs: 60_000,
      ...fakeTimers()
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.logTail).toContain("something broke");
  });

  it("kills the process group on timeout and still captures the log tail", async () => {
    const { desktop, commands } = makeScriptedDesktop((command) => {
      if (command.includes("/status")) return { stdout: "" }; // never finishes
      if (command.includes("tail -c")) return { stdout: "still building…" };
      return undefined;
    });
    const result = await runDetachedStep(desktop, {
      name: "subject-build",
      command: "sleep forever",
      timeoutMs: 10_000,
      pollIntervalMs: 3000,
      ...fakeTimers()
    });
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.logTail).toContain("still building");
    expect(commands.some((command) => command.includes("kill -- -"))).toBe(true);
  });

  it("rejects unsafe step names before touching the sandbox", async () => {
    const { desktop, commands } = makeScriptedDesktop();
    await expect(
      runDetachedStep(desktop, { name: "bad name; rm -rf /", command: "true", timeoutMs: 1000, ...fakeTimers() })
    ).rejects.toThrow(/name must match/);
    expect(commands).toHaveLength(0);
  });
});

describe("startDetachedProcess", () => {
  it("writes and launches the script without polling for completion", async () => {
    const { desktop, commands, files } = makeScriptedDesktop();
    await startDetachedProcess(desktop, { name: "subject-start", command: "pnpm start", cwd: "/home/user/subject" });
    expect(files.some((file) => file.path.endsWith("subject-start/run.sh") && file.data.includes("( pnpm start )"))).toBe(true);
    expect(commands.some((command) => command.includes("setsid -f"))).toBe(true);
    expect(commands.some((command) => command.includes("/status"))).toBe(false);
  });
});

describe("probeUrl", () => {
  it("returns true once the URL answers", async () => {
    let calls = 0;
    const { desktop } = makeScriptedDesktop((command) => {
      if (command.includes("curl")) {
        calls += 1;
        return { stdout: calls >= 3 ? "READY" : "WAIT" };
      }
      return undefined;
    });
    const ready = await probeUrl(desktop, "http://127.0.0.1:3000/", { timeoutMs: 60_000, ...fakeTimers() });
    expect(ready).toBe(true);
    expect(calls).toBe(3);
  });

  it("returns false when the budget runs out", async () => {
    const { desktop } = makeScriptedDesktop((command) =>
      command.includes("curl") ? { stdout: "WAIT" } : undefined
    );
    const ready = await probeUrl(desktop, "http://127.0.0.1:3000/", {
      timeoutMs: 5000,
      intervalMs: 1500,
      ...fakeTimers()
    });
    expect(ready).toBe(false);
  });
});
