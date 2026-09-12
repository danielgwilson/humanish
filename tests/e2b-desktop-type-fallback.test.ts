import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createE2BDesktopExecutor,
  CuaTypeFallbackError,
  type E2BDesktopLike,
} from "../src/e2b-desktop-executor.js";

type Recorder = {
  writeCalls: string[];
  fileWrites: Array<{ path: string; data: unknown }>;
  commandRuns: string[];
  pressCalls: string[][];
};

type CommandResult = { exitCode?: number; stderr?: string; stdout?: string };

/**
 * A fake E2B desktop. The real @e2b/desktop Sandbox THROWS a CommandExitError
 * (exposing exitCode/stderr/stdout) on any non-zero exit rather than returning a
 * non-zero exitCode, so `commandThrow` models that real wire shape. `commandReturn`
 * models a structural fake that returns a non-zero exitCode instead; both paths
 * must map to the same phase.
 */
function makeFakeDesktop(opts: {
  write?: (text: string) => void | Promise<void>;
  fileWrite?: (path: string, data: unknown) => void | Promise<void>;
  commandThrow?: { exitCode?: number; stderr?: string; stdout?: string; message?: string };
  commandReturn?: CommandResult;
  press?: (keys: string[]) => void | Promise<void>;
  omitCommands?: boolean;
  omitFiles?: boolean;
} = {}): { desktop: E2BDesktopLike; rec: Recorder } {
  const rec: Recorder = { writeCalls: [], fileWrites: [], commandRuns: [], pressCalls: [] };
  const noop = (): void => {};
  const base: E2BDesktopLike = {
    screenshot: () => new Uint8Array(),
    leftClick: noop,
    rightClick: noop,
    middleClick: noop,
    doubleClick: noop,
    moveMouse: noop,
    scroll: noop,
    drag: noop,
    wait: noop,
    write: async (text: string) => {
      rec.writeCalls.push(text);
      if (opts.write) await opts.write(text);
    },
    press: async (keys: string | string[]) => {
      const arr = Array.isArray(keys) ? keys : [keys];
      rec.pressCalls.push(arr);
      if (opts.press) await opts.press(arr);
    },
  };
  if (!opts.omitFiles) {
    base.files = {
      write: async (path: string, data: string | ArrayBuffer) => {
        rec.fileWrites.push({ path, data });
        if (opts.fileWrite) await opts.fileWrite(path, data);
        return undefined;
      },
    };
  }
  if (!opts.omitCommands) {
    base.commands = {
      run: async (command: string) => {
        rec.commandRuns.push(command);
        if (opts.commandThrow) {
          const t = opts.commandThrow;
          // Shape matches @e2b/desktop's CommandExitError (name + exitCode + stderr).
          throw Object.assign(new Error(t.message ?? `exit status ${t.exitCode ?? 1}`), {
            name: "CommandExitError",
            ...(t.exitCode === undefined ? {} : { exitCode: t.exitCode }),
            ...(t.stderr === undefined ? {} : { stderr: t.stderr }),
            ...(t.stdout === undefined ? {} : { stdout: t.stdout }),
          });
        }
        return opts.commandReturn ?? { exitCode: 0 };
      },
    };
  }
  return { desktop: base, rec };
}

const SECRET = "super-secret-passphrase-42";
const typeAction = { kind: "type", text: SECRET } as const;
const throwOnWrite = () => {
  throw new Error("exit status 1");
};

async function runType(desktop: E2BDesktopLike): Promise<unknown> {
  return createE2BDesktopExecutor(desktop)
    .execute(typeAction)
    .then(() => undefined)
    .catch((error: unknown) => error);
}

describe("type fallback diagnostics (#248)", () => {
  it.runIf(process.platform !== "win32").each(["xclip", "xsel"])("returns while the %s selection owner keeps running, then pastes once", async (utility) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "humanish-clipboard-pipes-"));
    const bin = path.join(root, "bin");
    const textPath = path.join(root, "clipboard.txt");
    const ownerPath = path.join(root, "owner.pid");
    const commandGroups: number[] = [];
    let transferPath: string | undefined;
    try {
      await mkdir(bin);
      await symlink("/bin/rm", path.join(bin, "rm"));
      // A process-lifetime fixture, not an X clipboard implementation: copy stdin exactly,
      // fork a long-lived owner with inherited stdout/stderr, then let the parent exit.
      const fixture = path.join(root, "selection-owner.cjs");
      await writeFile(fixture, `const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(textPath)}, fs.readFileSync(0));
const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' });
fs.writeFileSync(${JSON.stringify(ownerPath)}, String(owner.pid));
owner.unref();
`);
      const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
      await writeFile(path.join(bin, utility), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)}\n`, { mode: 0o755 });
      const { desktop, rec } = makeFakeDesktop({ write: throwOnWrite,
        fileWrite: async (target, data) => { transferPath = target; await writeFile(target, data as string); } });
      desktop.commands = { run: async (command) => new Promise((resolve, reject) => {
        const child = spawn("/bin/bash", ["-c", command], {
          env: { PATH: bin, DISPLAY: ":0" }, detached: true, stdio: ["ignore", "pipe", "pipe"]
        });
        if (child.pid !== undefined) commandGroups.push(child.pid);
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.stdout.resume();
        const timer = setTimeout(() => reject(new Error("command output pipes remained open")), 2000);
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stderr }); });
      }) };
      const text = "Quoted ‘text’ — café\nsecond line: $() and `literal`";
      await createE2BDesktopExecutor(desktop).execute({ kind: "type", text });
      expect(await readFile(textPath, "utf8")).toBe(text);
      expect(rec.writeCalls).toEqual([text]);
      expect(rec.pressCalls).toEqual([["Control", "v"]]);
      // The command returned before its selection owner exited; detachment must not kill it.
      process.kill(Number(await readFile(ownerPath, "utf8")), 0);
      await expect(readFile(transferPath!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      for (const pid of commandGroups) { try { process.kill(-pid, "SIGKILL"); } catch {} }
      if (transferPath !== undefined) await rm(transferPath, { force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("primary write succeeds: no clipboard fallback is attempted", async () => {
    const { desktop, rec } = makeFakeDesktop();
    const err = await runType(desktop);
    expect(err).toBeUndefined();
    expect(rec.writeCalls).toEqual([SECRET]);
    expect(rec.commandRuns).toHaveLength(0);
    expect(rec.pressCalls).toHaveLength(0);
  });

  it("primary write fails, clipboard fallback succeeds: pastes with Control+V", async () => {
    const { desktop, rec } = makeFakeDesktop({ write: throwOnWrite });
    const err = await runType(desktop);
    expect(err).toBeUndefined();
    expect(rec.fileWrites).toHaveLength(1);
    expect(rec.commandRuns).toHaveLength(1);
    expect(rec.pressCalls).toEqual([["Control", "v"]]);
  });

  it("clipboard utility missing: real SDK throws CommandExitError(exit 127)", async () => {
    const { desktop } = makeFakeDesktop({
      write: throwOnWrite,
      commandThrow: { exitCode: 127, stderr: "no xclip/xsel clipboard utility available for paste fallback" },
    });
    const err = await runType(desktop);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("clipboard-utility-missing");
    expect((err as CuaTypeFallbackError).attemptChain).toContain("desktop.write failed");
  });

  it("clipboard command fails: real SDK throws CommandExitError(exit 1), stderr surfaces", async () => {
    const { desktop } = makeFakeDesktop({
      write: throwOnWrite,
      commandThrow: { exitCode: 1, stderr: "clipboard utility present but failed to set the clipboard" },
    });
    const err = await runType(desktop);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    const fallback = err as CuaTypeFallbackError;
    expect(fallback.phase).toBe("clipboard-command");
    expect(fallback.stderrTail).toContain("failed to set the clipboard");
  });

  it("also maps a structural fake that RETURNS a non-zero exit (not just throws)", async () => {
    const { desktop } = makeFakeDesktop({
      write: throwOnWrite,
      commandReturn: { exitCode: 1, stderr: "returned-nonzero shape" },
    });
    const err = await runType(desktop);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("clipboard-command");
  });

  it("infra error with no exit code: names the command phase, still redacted", async () => {
    const { desktop } = makeFakeDesktop({
      write: throwOnWrite,
      commandThrow: { message: "request timed out" },
    });
    const err = await runType(desktop);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("clipboard-command");
  });

  it("paste keypress (Control+V) fails: names the paste-keypress phase", async () => {
    const { desktop } = makeFakeDesktop({
      write: throwOnWrite,
      press: () => {
        throw new Error("xdotool key failed");
      },
    });
    const err = await runType(desktop);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("paste-keypress");
  });

  it("fails closed when there is no command/file surface for the fallback", async () => {
    const { desktop } = makeFakeDesktop({ write: throwOnWrite, omitCommands: true, omitFiles: true });
    const err = await runType(desktop);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("clipboard-unavailable");
  });

  it("never leaks the typed text into the attempt chain, message, or stderr tail", async () => {
    const { desktop } = makeFakeDesktop({
      write: throwOnWrite,
      commandThrow: { exitCode: 1, stderr: "clipboard utility present but failed to set the clipboard" },
    });
    const err = (await runType(desktop)) as CuaTypeFallbackError;
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect(err.message).not.toContain(SECRET);
    expect(err.attemptChain.join(" ")).not.toContain(SECRET);
    expect(err.stderrTail ?? "").not.toContain(SECRET);
    // The substrate's own stderr still surfaces (that is the useful diagnostic).
    expect(err.stderrTail).toContain("failed to set the clipboard");
  });
});
