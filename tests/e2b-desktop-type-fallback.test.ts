import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { isCommandExitError } from "../src/command-failure.js";
import { createE2BDesktopExecutor, CuaTypeFallbackError, type E2BDesktopLike } from "../src/e2b-desktop-executor.js";
import { CuaTypeInputError, NATIVE_TYPE_MAX_CODE_POINTS, typeTextNative } from "../src/e2b-desktop-type.js";

type Result = { exitCode?: number; stdout?: string; stderr?: string };
function fake() {
  const calls: string[] = [];
  const writes: Array<{ path: string; data: string | ArrayBuffer }> = [];
  const noop = () => {};
  const desktop: E2BDesktopLike = {
    screenshot: () => new Uint8Array(), leftClick: noop, rightClick: noop, middleClick: noop,
    doubleClick: noop, moveMouse: noop, scroll: noop, drag: noop, wait: noop,
    write: () => { calls.push("sdk-write"); }, press: () => { calls.push("press"); },
    files: { write: async (path, data) => { calls.push("upload"); writes.push({ path, data }); } },
    commands: { run: async (command) => { calls.push(command); return { exitCode: 0 }; } },
  };
  return { desktop, calls, writes };
}
const isInput = (command: string) => command.includes("xdotool type --delay");
const secret = "synthetic-private-text";
const commandError = () => Object.assign(new Error(secret), {
  name: "CommandExitError", exitCode: 1, stderr: secret,
});

describe("native typing without replay (#340)", () => {
  it("retains the legacy error export without using clipboard recovery", () => {
    expect(new CuaTypeFallbackError("clipboard-command", ["legacy caller"]).name).toBe("CuaTypeFallbackError");
  });

  it("types one whole UTF-8 value without SDK slicing or shell interpolation", async () => {
    const { desktop, calls, writes } = fake();
    const text = "a".repeat(24) + "🧪 café\nquotes: ' \" ` $() \\\n";
    await createE2BDesktopExecutor(desktop, { nativeTyping: true }).execute({ kind: "type", text });
    expect(writes.map(w => w.data)).toEqual([text]);
    expect(calls.filter(isInput)).toHaveLength(1);
    expect(calls).not.toContain("sdk-write");
    expect(calls).not.toContain("press");
    expect(calls.filter(c => c !== "upload").join("\n")).not.toContain(text);
  });

  it.each(["\0", "\ud83e", "\uddea", "a".repeat(NATIVE_TYPE_MAX_CODE_POINTS + 1)])("rejects unsupported input before preparation", async text => {
    const { desktop, calls } = fake();
    await expect(typeTextNative(desktop, text)).rejects.toMatchObject({ phase: "invalid-text" });
    expect(calls).toEqual([]);
  });

  it("counts scalar values rather than UTF-16 units and makes empty input a no-op", async () => {
    const { desktop, calls } = fake();
    await typeTextNative(desktop, "");
    expect(calls).toEqual([]);
    await typeTextNative(desktop, "🧪".repeat(NATIVE_TYPE_MAX_CODE_POINTS));
    expect(calls.filter(isInput)).toHaveLength(1);
  });

  it.each(["throw", "nonzero", "missing-status", "stderr-zero", "stdout-zero"])("stops after uncertain native input: %s", async mode => {
    const { desktop, calls } = fake();
    let partiallyInserted = false;
    desktop.commands!.run = async command => {
      calls.push(command);
      if (!isInput(command)) return { exitCode: 0 };
      partiallyInserted = true;
      if (mode === "throw") throw commandError();
      // Upstream xdotool can report skipped characters on stderr yet return success.
      if (mode === "stderr-zero") return { exitCode: 0, stderr: `I don't what key produces '${secret}', skipping.` };
      if (mode === "stdout-zero") return { exitCode: 0, stdout: secret };
      return mode === "nonzero" ? { exitCode: 1 } : {};
    };
    const error = await typeTextNative(desktop, secret).catch((e: unknown) => e);
    expect(partiallyInserted).toBe(true);
    expect(error).toBeInstanceOf(CuaTypeInputError);
    expect(error).toMatchObject({ phase: "input-uncertain", cleanup: "confirmed" });
    expect(isCommandExitError(error)).toBe(false);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(calls.filter(isInput)).toHaveLength(1);
    expect(calls).not.toContain("sdk-write");
    expect(calls).not.toContain("press");
  });

  it.each(["before", "preparation", "upload", "input"])("closes input admission when aborted during %s", async stage => {
    const { desktop, calls } = fake();
    const controller = new AbortController();
    if (stage === "before") controller.abort();
    desktop.commands!.run = async command => {
      calls.push(command);
      if ((stage === "preparation" && command.includes("mkdir -m")) || (stage === "input" && isInput(command))) controller.abort();
      return { exitCode: 0 };
    };
    desktop.files!.write = async () => { calls.push("upload"); if (stage === "upload") controller.abort(); };
    await expect(typeTextNative(desktop, secret, controller.signal)).rejects.toThrow();
    expect(calls.filter(isInput)).toHaveLength(stage === "input" ? 1 : 0);
    expect(calls).not.toContain("press");
  });

  it("a late upload resolution after abort cannot dispatch typing", async () => {
    const { desktop, calls } = fake();
    const controller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const uploading = new Promise<void>(resolve => { started = resolve; });
    desktop.files!.write = async () => { started(); await new Promise<void>(resolve => { release = resolve; }); };
    const pending = typeTextNative(desktop, secret, controller.signal);
    await uploading; controller.abort(); release();
    await expect(pending).rejects.toMatchObject({ phase: "transfer", cleanup: "confirmed" });
    expect(calls.filter(isInput)).toEqual([]);
  });

  it("retains uncertain cleanup and sanitizes failed transfers without sending input", async () => {
    const { desktop, calls } = fake();
    desktop.files!.write = async () => { throw commandError(); };
    desktop.commands!.run = async command => {
      calls.push(command);
      if (!command.includes("mkdir -m")) throw commandError();
      return { exitCode: 0 };
    };
    await expect(typeTextNative(desktop, secret)).rejects.toMatchObject({ phase: "transfer", cleanup: "unconfirmed" });
    expect(calls.filter(isInput)).toEqual([]);
  });

  it("does not claim permanent removal after an upload loses its completion response", async () => {
    const { desktop, calls } = fake();
    desktop.files!.write = async () => { throw new Error("upload response lost"); };
    await expect(typeTextNative(desktop, secret)).rejects.toMatchObject({ phase: "transfer", cleanup: "unconfirmed" });
    // Cleanup was attempted successfully, but the remote upload could still finish later.
    expect(calls.filter(isInput)).toEqual([]);
    expect(calls.at(-1)).toContain("rmdir");
  });

  it("does not delete an unacknowledged preparation path", async () => {
    const { desktop, calls } = fake();
    desktop.commands!.run = async command => { calls.push(command); throw commandError(); };
    await expect(typeTextNative(desktop, secret)).rejects.toMatchObject({ phase: "preparation", cleanup: "unconfirmed" });
    expect(calls).toHaveLength(1);
  });

  it("requires the explicit native command/file capability without falling back", async () => {
    const { desktop, calls } = fake(); delete desktop.commands;
    await expect(typeTextNative(desktop, secret)).rejects.toMatchObject({ phase: "preparation" });
    expect(calls).toEqual([]);
  });

  it.runIf(process.platform === "linux")("the generated shell transfers literal UTF-8 into a private file and cleans it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "humanish-native-type-"));
    const bin = path.join(root, "bin");
    const output = path.join(root, "typed.bin");
    const metadata = path.join(root, "metadata.json");
    const sentinel = path.join(root, "must-not-execute");
    let uploaded: string | undefined;
    try {
      await mkdir(bin);
      await writeFile(path.join(bin, "xdotool"), `#!${process.execPath}\nconst fs=require('node:fs');\nconst p=process.argv.at(-1);\nfs.writeFileSync(process.env.HUMANISH_TEST_OUTPUT,fs.readFileSync(p));\nfs.writeFileSync(process.env.HUMANISH_TEST_META,JSON.stringify({args:process.argv.slice(2),fileMode:fs.statSync(p).mode&511,dirMode:fs.statSync(require('node:path').dirname(p)).mode&511,locale:process.env.LC_ALL}));\n`, { mode: 0o755 });
      const { desktop, calls } = fake();
      desktop.files!.write = async (target, data) => { uploaded = target; await writeFile(target, data as string); };
      desktop.commands!.run = command => new Promise<Result>((resolve, reject) => {
        calls.push(command);
        const child = spawn("/bin/bash", ["-c", command], {
          env: { PATH: `${bin}:/usr/bin:/bin`, HUMANISH_TEST_OUTPUT: output, HUMANISH_TEST_META: metadata },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
        child.on("error", reject); child.on("close", code => resolve({ exitCode: code ?? 1, stdout, stderr }));
      });
      const text = " ".repeat(2) + "a".repeat(24) + `🧪 café e\u0301 日本語\n'\" $HOME $(touch ${sentinel}) \`literal\` \\\n`;
      await typeTextNative(desktop, text);
      expect(await readFile(output, "utf8")).toBe(text);
      expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({
        fileMode: 0o600, dirMode: 0o700, locale: "C.UTF-8", args: ["type", "--delay", "75", "--file", uploaded],
      });
      await expect(stat(path.dirname(uploaded!))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      expect(calls.filter(isInput)).toHaveLength(1);
      expect(calls.join("\n")).not.toContain(text);
    } finally {
      if (uploaded) await rm(path.dirname(uploaded), { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
