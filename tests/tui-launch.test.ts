import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isSafeLabHandle, launchRun, readLaunchLogTail } from "../src/tui-launch.js";

describe("starting a run from the terminal surface (#455)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-launch-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  /** Records the spawn instead of performing it, so these assert the CONTRACT with the OS. */
  function recordingSpawn() {
    const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
    const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      return { pid: 4242, unref: () => {} };
    }) as never;
    return { calls, spawn };
  }

  it("spawns the same command a person would type, detached and off the terminal", async () => {
    const { calls, spawn } = recordingSpawn();
    const result = await launchRun({ cwd, lab: "signup-flow", mode: "live", spawn, cliPath: "/opt/humanish/dist/cli.js" });

    expect(result.ok).toBe(true);
    const call = calls[0]!;
    expect(call.args).toEqual([
      "/opt/humanish/dist/cli.js",
      "lab",
      "run",
      "--cwd",
      cwd,
      "--json",
      "--no-open",
      "--",
      "signup-flow"
    ]);
    // The three properties that make the run outlive the surface. Losing any one of them means a
    // dropped SSH kills a study that costs real money.
    expect(call.options.detached).toBe(true);
    const stdio = call.options.stdio as unknown[];
    expect(stdio[0]).toBe("ignore");
    // stdout and stderr both go to the SAME opened descriptor, never to an unread pipe.
    expect(typeof stdio[1]).toBe("number");
    expect(stdio[2]).toBe(stdio[1]);
  });

  it("passes --dry-run only when asked, so live spend is never implicit", async () => {
    const dry = recordingSpawn();
    await launchRun({ cwd, lab: "signup-flow", mode: "dry-run", spawn: dry.spawn, cliPath: "/x/cli.js" });
    expect(dry.calls[0]!.args).toContain("--dry-run");

    const live = recordingSpawn();
    await launchRun({ cwd, lab: "signup-flow", mode: "live", spawn: live.spawn, cliPath: "/x/cli.js" });
    expect(live.calls[0]!.args).not.toContain("--dry-run");
  });

  it("returns the pid, which is how the surface finds the run it just started", async () => {
    const { spawn } = recordingSpawn();
    const result = await launchRun({ cwd, lab: "signup-flow", mode: "live", spawn, cliPath: "/x/cli.js" });
    expect(result.ok && result.run.pid).toBe(4242);
  });

  it("refuses a lab handle that could be read as a flag", async () => {
    // argv is positional and there is no shell, so this is the entire injection surface — but a lab
    // named `--json` would still be handed to the CLI as an option.
    for (const handle of ["--json", "-x", "", "../etc/passwd", "a/b", "a\0b", "a b"]) {
      expect(isSafeLabHandle(handle)).toBe(false);
      const { calls, spawn } = recordingSpawn();
      const result = await launchRun({ cwd, lab: handle, mode: "live", spawn, cliPath: "/x/cli.js" });
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.code).toBe("HUMANISH_LAUNCH_INVALID_LAB");
      // Nothing was spawned — the refusal happens before any process exists.
      expect(calls).toHaveLength(0);
    }
    // And the handles this project actually uses still pass, colons included (`oss:meta`).
    for (const handle of ["signup-flow", "oss:meta", "persona-contrast-live", "a.b_c-1"]) {
      expect(isSafeLabHandle(handle)).toBe(true);
    }
  });

  it("writes the log inside .humanish, owner-readable only", async () => {
    const { spawn } = recordingSpawn();
    const result = await launchRun({
      cwd,
      lab: "signup-flow",
      mode: "live",
      spawn,
      cliPath: "/x/cli.js",
      now: () => new Date("2026-08-19T12:00:00.000Z")
    });
    expect(result.ok).toBe(true);
    const logPath = result.ok ? result.run.logPath : "";
    expect(logPath.startsWith(path.join(cwd, ".humanish", "launches"))).toBe(true);
    expect(path.basename(logPath)).toBe("2026-08-19T12-00-00-000Z-signup-flow.log");
    // A launch log can carry provider error text, so it is not world-readable.
    expect((await stat(logPath)).mode & 0o077).toBe(0);
  });

  it("reports a spawn failure as a result, never as a thrown error", async () => {
    // The surface owns the screen; an exception here would tear it down instead of rendering a
    // problem the operator can act on.
    const spawn = (() => {
      throw new Error("EACCES: permission denied");
    }) as never;
    const result = await launchRun({ cwd, lab: "signup-flow", mode: "live", spawn, cliPath: "/x/cli.js" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("HUMANISH_LAUNCH_FAILED");
    expect(result.ok === false && result.error.message).toContain("EACCES");
  });

  it("reads back the tail of a log, and treats a missing one as empty rather than an error", async () => {
    const { spawn } = recordingSpawn();
    const result = await launchRun({ cwd, lab: "signup-flow", mode: "live", spawn, cliPath: "/x/cli.js" });
    const logPath = result.ok ? result.run.logPath : "";
    const { writeFile } = await import("node:fs/promises");
    await writeFile(logPath, "line one\nline two\n", "utf8");
    expect(await readLaunchLogTail(logPath)).toBe("line one\nline two");
    expect(await readLaunchLogTail(path.join(cwd, "nope.log"))).toBe("");
  });
});
