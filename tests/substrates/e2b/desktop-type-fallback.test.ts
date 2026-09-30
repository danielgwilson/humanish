import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createE2BDesktopExecutor,
  CuaTypeFallbackError,
  type E2BDesktopLike,
} from "../../../src/substrates/e2b/desktop-executor.js";

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
function makeFakeDesktop(
  opts: {
    write?: (text: string) => void | Promise<void>;
    fileWrite?: (path: string, data: unknown) => void | Promise<void>;
    commandThrow?: { exitCode?: number; stderr?: string; stdout?: string; message?: string };
    commandReturn?: CommandResult;
    press?: (keys: string[]) => void | Promise<void>;
    omitCommands?: boolean;
    omitFiles?: boolean;
  } = {},
): { desktop: E2BDesktopLike; rec: Recorder } {
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

async function runType(desktop: E2BDesktopLike, text: string = SECRET): Promise<unknown> {
  return createE2BDesktopExecutor(desktop)
    .execute({ ...typeAction, text })
    .then(() => undefined)
    .catch((error: unknown) => error);
}

const UNICODE = "Réunion café — 10h 🚀 会議";

describe("typing text on an E2B desktop", () => {
  it.runIf(process.platform !== "win32")(
    "types non-ASCII text with xdotool in the UTF-8 locale from a temp file, then removes it",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "humanish-type-utf8-"));
      const bin = path.join(root, "bin");
      const record = path.join(root, "xdotool.json");
      let transferPath: string | undefined;
      try {
        await mkdir(bin);
        await symlink("/bin/rm", path.join(bin, "rm"));
        // A stand-in for xdotool that records its arguments, its locale and the file it was
        // asked to type, exactly as the desktop's xdotool would read it.
        const fixture = path.join(root, "xdotool.cjs");
        await writeFile(
          fixture,
          `const fs = require('node:fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, lcAll: process.env.LC_ALL, text: fs.readFileSync(file, 'utf8') }));
`,
        );
        const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
        await writeFile(
          path.join(bin, "xdotool"),
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
          { mode: 0o755 },
        );
        const { desktop, rec } = makeFakeDesktop({
          fileWrite: async (target, data) => {
            transferPath = target;
            await writeFile(target, data as string);
          },
        });
        desktop.commands = {
          run: async (command) =>
            new Promise((resolve, reject) => {
              const child = spawn("/bin/bash", ["-c", command], {
                env: { PATH: bin, DISPLAY: ":0" },
                stdio: ["ignore", "pipe", "pipe"],
              });
              let stderr = "";
              child.stderr.on("data", (chunk) => {
                stderr += chunk;
              });
              child.stdout.resume();
              child.on("error", reject);
              child.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
            }),
        };
        const text = `${UNICODE}\nsecond line: $() and \`literal\` 'quoted'`;
        await createE2BDesktopExecutor(desktop).execute({ kind: "type", text });
        const recorded = JSON.parse(await readFile(record, "utf8"));
        expect(recorded.lcAll).toBe("C.UTF-8");
        expect(recorded.args.slice(0, 4)).toEqual(["type", "--delay", "75", "--file"]);
        expect(recorded.text).toBe(text);
        // The SDK write would split and fail on this text, so it is never tried.
        expect(rec.writeCalls).toEqual([]);
        expect(rec.pressCalls).toEqual([]);
        await expect(readFile(transferPath!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (transferPath !== undefined) await rm(transferPath, { force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("types ASCII text with the SDK write and runs no command", async () => {
    const { desktop, rec } = makeFakeDesktop();
    const err = await runType(desktop);
    expect(err).toBeUndefined();
    expect(rec.writeCalls).toEqual([SECRET]);
    expect(rec.commandRuns).toHaveLength(0);
    expect(rec.pressCalls).toHaveLength(0);
  });

  it("sends non-ASCII text straight to UTF-8 typing without the SDK write", async () => {
    const { desktop, rec } = makeFakeDesktop();
    const err = await runType(desktop, UNICODE);
    expect(err).toBeUndefined();
    expect(rec.writeCalls).toEqual([]);
    expect(rec.fileWrites.map((write) => write.data)).toEqual([UNICODE]);
    expect(rec.commandRuns).toHaveLength(1);
    expect(rec.commandRuns[0]).toContain("LC_ALL=C.UTF-8 xdotool type --delay 75 --file");
    expect(rec.commandRuns[0]).not.toContain("xclip");
    expect(rec.pressCalls).toEqual([]);
  });

  it("falls back to UTF-8 typing, with no clipboard, when the SDK write fails", async () => {
    const { desktop, rec } = makeFakeDesktop({ write: throwOnWrite });
    const err = await runType(desktop);
    expect(err).toBeUndefined();
    expect(rec.writeCalls).toEqual([SECRET]);
    expect(rec.fileWrites).toHaveLength(1);
    expect(rec.commandRuns).toHaveLength(1);
    expect(rec.commandRuns[0]).toContain("xdotool type");
    expect(rec.pressCalls).toEqual([]);
  });

  it("names the command phase with xdotool's stderr when the SDK throws a non-zero exit", async () => {
    const { desktop } = makeFakeDesktop({
      commandThrow: {
        exitCode: 1,
        stderr: "Invalid multi-byte sequence encountered\nxdo_enter_text_window reported an error",
      },
    });
    const err = await runType(desktop, UNICODE);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    const failure = err as CuaTypeFallbackError;
    expect(failure.phase).toBe("text-command");
    expect(failure.attemptChain).toEqual(["xdotool type failed (exit 1)"]);
    expect(failure.stderrTail).toContain("Invalid multi-byte sequence");
  });

  it("records the SDK write failure first when ASCII text falls back and fails", async () => {
    const { desktop } = makeFakeDesktop({
      write: throwOnWrite,
      commandReturn: { exitCode: 1, stderr: "returned-nonzero shape" },
    });
    const err = await runType(desktop);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    const failure = err as CuaTypeFallbackError;
    expect(failure.phase).toBe("text-command");
    expect(failure.attemptChain).toEqual(["desktop.write failed", "xdotool type failed (exit 1)"]);
  });

  it("names the command phase for an infra error with no exit code", async () => {
    const { desktop } = makeFakeDesktop({ commandThrow: { message: "request timed out" } });
    const err = await runType(desktop, UNICODE);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("text-command");
    expect((err as CuaTypeFallbackError).attemptChain).toEqual(["xdotool type errored"]);
  });

  it("names the temp-file phase when the text cannot be written", async () => {
    const { desktop, rec } = makeFakeDesktop({
      fileWrite: () => {
        throw new Error("disk full");
      },
    });
    const err = await runType(desktop, UNICODE);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("text-tempfile");
    expect(rec.commandRuns).toEqual([]);
  });

  it("fails closed when there is no command or file surface", async () => {
    const { desktop } = makeFakeDesktop({ omitCommands: true, omitFiles: true });
    const err = await runType(desktop, UNICODE);
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect((err as CuaTypeFallbackError).phase).toBe("text-unavailable");
  });

  it("never leaks the typed text into the attempt chain, message, command or stderr tail", async () => {
    const { desktop, rec } = makeFakeDesktop({
      write: throwOnWrite,
      commandThrow: { exitCode: 1, stderr: "xdo_enter_text_window reported an error" },
    });
    const err = (await runType(desktop)) as CuaTypeFallbackError;
    expect(err).toBeInstanceOf(CuaTypeFallbackError);
    expect(err.message).not.toContain(SECRET);
    expect(err.attemptChain.join(" ")).not.toContain(SECRET);
    expect(err.stderrTail ?? "").not.toContain(SECRET);
    expect(rec.commandRuns.join("\n")).not.toContain(SECRET);
    expect(err.stderrTail).toContain("xdo_enter_text_window");
  });
});
