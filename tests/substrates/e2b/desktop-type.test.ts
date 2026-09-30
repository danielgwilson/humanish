// How the E2B executor types text. Typed text can be a credential, so every case also checks that
// the text and its temp-file path stay out of what the executor reports.

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createE2BDesktopExecutor,
  CuaTypeError,
  type E2BDesktopLike,
} from "../../../src/substrates/e2b/desktop-executor.js";

type CommandResult = { exitCode?: number; stderr?: string; stdout?: string };

type Recorder = {
  writeCalls: string[];
  fileWrites: Array<{ path: string; data: unknown }>;
  commandRuns: string[];
};

const TYPE_DIR = "/tmp/humanish-type-Abc12345";

/**
 * A fake E2B desktop. `onCommand` answers each command; by default the private directory command
 * prints TYPE_DIR and every other command exits 0. The real SDK throws on a non-zero exit, so
 * `throwOn` models that shape.
 */
function makeFakeDesktop(
  opts: {
    write?: (text: string) => void | Promise<void>;
    fileWrite?: (path: string, data: unknown) => void | Promise<void>;
    onCommand?: (command: string) => CommandResult | undefined;
    throwOn?: RegExp;
    omitSurfaces?: boolean;
  } = {},
): { desktop: E2BDesktopLike; rec: Recorder } {
  const rec: Recorder = { writeCalls: [], fileWrites: [], commandRuns: [] };
  const noop = (): void => {};
  const desktop: E2BDesktopLike = {
    screenshot: () => new Uint8Array(),
    leftClick: noop,
    rightClick: noop,
    middleClick: noop,
    doubleClick: noop,
    moveMouse: noop,
    scroll: noop,
    drag: noop,
    wait: noop,
    press: noop,
    write: async (text: string) => {
      rec.writeCalls.push(text);
      if (opts.write) await opts.write(text);
    },
  };
  if (!opts.omitSurfaces) {
    desktop.files = {
      write: async (target: string, data: string | ArrayBuffer) => {
        rec.fileWrites.push({ path: target, data });
        if (opts.fileWrite) await opts.fileWrite(target, data);
        return undefined;
      },
    };
    desktop.commands = {
      run: async (command: string) => {
        rec.commandRuns.push(command);
        if (opts.throwOn?.test(command))
          throw Object.assign(new Error(`exit status 1: ${command}`), {
            name: "CommandExitError",
            exitCode: 1,
            stderr: "Invalid multi-byte sequence encountered",
          });
        const answer = opts.onCommand?.(command);
        if (answer) return answer;
        return command.includes("mktemp") ? { exitCode: 0, stdout: TYPE_DIR } : { exitCode: 0 };
      },
    };
  }
  return { desktop, rec };
}

const SECRET = "correct-horse-Réunion-passphrase";

async function typeWith(desktop: E2BDesktopLike, text = SECRET): Promise<unknown> {
  return createE2BDesktopExecutor(desktop)
    .execute({ kind: "type", text })
    .then(() => undefined)
    .catch((error: unknown) => error);
}

/** Assert a failure names the phase and exit code only: no text, no path, no substrate output. */
function expectPhaseOnly(error: unknown, phase: string, exitCode?: number): void {
  expect(error).toBeInstanceOf(CuaTypeError);
  expect((error as CuaTypeError).phase).toBe(phase);
  expect((error as CuaTypeError).message).toBe(
    `type failed at ${phase}${exitCode === undefined ? "" : ` (exit ${exitCode})`}`,
  );
  expect((error as Error).cause).toBeUndefined();
}

describe("typing text on an E2B desktop", () => {
  it.runIf(process.platform !== "win32")(
    "types through one xdotool command from a private 0600 file, then removes its directory",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "humanish-type-host-"));
      const bin = path.join(root, "bin");
      const record = path.join(root, "xdotool.json");
      let directory: string | undefined;
      try {
        await mkdir(bin);
        for (const tool of ["mktemp", "rm"])
          await symlink(`/usr/bin/${tool}`, path.join(bin, tool)).catch(() =>
            symlink(`/bin/${tool}`, path.join(bin, tool)),
          );
        // A stand-in for xdotool: records its arguments, locale, the file's text and the modes of
        // the file and its directory, as the desktop's xdotool would see them.
        const fixture = path.join(root, "xdotool.cjs");
        await writeFile(
          fixture,
          `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  args,
  lcAll: process.env.LC_ALL,
  text: fs.readFileSync(file, 'utf8'),
  fileMode: (fs.statSync(file).mode & 0o777).toString(8),
  dirMode: (fs.statSync(path.dirname(file)).mode & 0o777).toString(8),
}));
`,
        );
        const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
        await writeFile(
          path.join(bin, "xdotool"),
          `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`,
          { mode: 0o755 },
        );
        const { desktop, rec } = makeFakeDesktop({
          fileWrite: async (target, data) => writeFile(target, data as string),
        });
        desktop.commands = {
          run: async (command) =>
            new Promise((resolve, reject) => {
              rec.commandRuns.push(command);
              const child = spawn("/bin/bash", ["-c", command], {
                env: { PATH: bin, DISPLAY: ":0" },
                stdio: ["ignore", "pipe", "pipe"],
              });
              let stdout = "";
              child.stdout.on("data", (chunk) => {
                stdout += chunk;
              });
              child.stderr.resume();
              child.on("error", reject);
              child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout }));
            }),
        };
        const text = `${SECRET} — café 🚀\nsecond line: $() and \`literal\` 'quoted'`;
        await createE2BDesktopExecutor(desktop).execute({ kind: "type", text });
        const recorded = JSON.parse(await readFile(record, "utf8"));
        expect(recorded.lcAll).toBe("C.UTF-8");
        expect(recorded.args.slice(0, 4)).toEqual(["type", "--delay", "75", "--file"]);
        expect(recorded.text).toBe(text);
        expect(recorded.fileMode).toBe("600");
        expect(recorded.dirMode).toBe("700");
        // One attempt: the SDK write is never tried, and the text never passes through the shell.
        expect(rec.writeCalls).toEqual([]);
        expect(rec.commandRuns.join("\n")).not.toContain(SECRET);
        directory = path.dirname(rec.fileWrites[0]!.path);
        await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        if (directory !== undefined) await rm(directory, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("types ASCII text through xdotool too, never the SDK write", async () => {
    const { desktop, rec } = makeFakeDesktop();
    expect(await typeWith(desktop, "hello@example.test")).toBeUndefined();
    expect(rec.writeCalls).toEqual([]);
    expect(rec.fileWrites).toEqual([{ path: `${TYPE_DIR}/text`, data: "hello@example.test" }]);
    expect(rec.commandRuns).toHaveLength(3);
    expect(rec.commandRuns[1]).toContain(
      `LC_ALL=C.UTF-8 xdotool type --delay 75 --file '${TYPE_DIR}/text'`,
    );
    expect(rec.commandRuns[2]).toBe(`rm -rf -- '${TYPE_DIR}'`);
  });

  it("fails the step without retrying when xdotool fails, and still removes the directory", async () => {
    const { desktop, rec } = makeFakeDesktop({ throwOn: /xdotool type/ });
    expectPhaseOnly(await typeWith(desktop), "text-command", 1);
    expect(rec.writeCalls).toEqual([]);
    expect(rec.commandRuns.filter((command) => command.includes("xdotool type"))).toHaveLength(1);
    expect(rec.commandRuns.at(-1)).toBe(`rm -rf -- '${TYPE_DIR}'`);
  });

  it("treats a returned non-zero exit as a failure too", async () => {
    const { desktop, rec } = makeFakeDesktop({
      onCommand: (command) => (command.includes("xdotool type") ? { exitCode: 2 } : undefined),
    });
    expectPhaseOnly(await typeWith(desktop), "text-command", 2);
    expect(rec.commandRuns.at(-1)).toBe(`rm -rf -- '${TYPE_DIR}'`);
  });

  it("removes the directory when writing the text fails", async () => {
    const { desktop, rec } = makeFakeDesktop({
      fileWrite: () => {
        throw new Error(`disk full at ${TYPE_DIR}/text`);
      },
    });
    expectPhaseOnly(await typeWith(desktop), "text-tempfile");
    expect(rec.commandRuns.some((command) => command.includes("xdotool type"))).toBe(false);
    expect(rec.commandRuns.at(-1)).toBe(`rm -rf -- '${TYPE_DIR}'`);
  });

  it("writes nothing when the private directory cannot be made", async () => {
    for (const onCommand of [
      (command: string) => (command.includes("mktemp") ? { exitCode: 0, stdout: "" } : undefined),
      (command: string) =>
        command.includes("mktemp") ? { exitCode: 0, stdout: "/home/user/elsewhere" } : undefined,
    ]) {
      const { desktop, rec } = makeFakeDesktop({ onCommand });
      expectPhaseOnly(await typeWith(desktop), "text-tempfile");
      expect(rec.fileWrites).toEqual([]);
    }
    const { desktop, rec } = makeFakeDesktop({ throwOn: /mktemp/ });
    expectPhaseOnly(await typeWith(desktop), "text-tempfile");
    expect(rec.fileWrites).toEqual([]);
  });

  it("removes the directory when the typing request fails before any exit code (a request-layer timeout)", async () => {
    const { desktop, rec } = makeFakeDesktop({
      onCommand: (command) => {
        if (command.includes("xdotool type"))
          throw Object.assign(new Error("deadline exceeded"), { name: "TimeoutError" });
        return undefined;
      },
    });
    expectPhaseOnly(await typeWith(desktop), "text-command");
    expect(rec.fileWrites).toHaveLength(1);
    expect(rec.commandRuns.at(-1)).toBe(`rm -rf -- '${TYPE_DIR}'`);
  });

  it("never types any character twice: one xdotool command, no SDK write, whatever fails", async () => {
    // The SDK write types 25-character chunks and can fail after typing one; this fake does both.
    const typesThenFails = () => {
      throw new Error("chunk 2 failed after chunk 1 was typed");
    };
    for (const text of ["Plan the weekly sync now. Review", "Plan the weekly sync now. Réunion"])
      for (const failure of [
        { throwOn: /xdotool type/ },
        {
          onCommand: (command: string) =>
            command.includes("xdotool type") ? { exitCode: 1 } : undefined,
        },
      ]) {
        const { desktop, rec } = makeFakeDesktop({ ...failure, write: typesThenFails });
        await typeWith(desktop, text);
        expect(rec.writeCalls).toEqual([]);
        expect(rec.commandRuns.filter((command) => command.includes("xdotool"))).toHaveLength(1);
      }
  });

  it("keeps the SDK write, with no retry, on a desktop without command and file surfaces", async () => {
    const { desktop, rec } = makeFakeDesktop({ omitSurfaces: true });
    expect(await typeWith(desktop)).toBeUndefined();
    expect(rec.writeCalls).toEqual([SECRET]);

    const failing = makeFakeDesktop({
      omitSurfaces: true,
      write: (text) => {
        throw new Error(`xdotool type -- '${text}' exited 1`);
      },
    });
    expectPhaseOnly(await typeWith(failing.desktop), "desktop-write");
    expect(failing.rec.writeCalls).toEqual([SECRET]);
  });

  it("never puts the text or its path into the error", async () => {
    const { desktop } = makeFakeDesktop({ throwOn: /xdotool type/ });
    const error = (await typeWith(desktop)) as Error;
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain(TYPE_DIR);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(await readdir(os.tmpdir())).not.toContain(path.basename(TYPE_DIR));
  });
});
