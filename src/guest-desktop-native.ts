import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { CuaExecutorError } from "./cua-executor-error.js";
import { BROWSER_CONTROL_LIMITS } from "./browser-control-protocol.js";
import type { GuestDesktopTools } from "./guest-desktop-executor.js";

/** Private owner port; never expose its command array to a participant. */
export interface GuestDesktopNativeTools extends Pick<GuestDesktopTools, "input" | "capture"> {
  activeWindowId(signal: AbortSignal): Promise<string>;
  typeAscii(text: string, signal: AbortSignal): Promise<void>;
}

class UnconfirmedHelperExit extends CuaExecutorError {
  constructor() { super("execution_failed", "outcome_uncertain"); }
}

/** Guest-only helpers. Not a host administration API or an actor-visible command runner. */
export function createGuestDesktopNativeTools(options: {
  display: string;
  /** An owner-created private directory inside the disposable guest. */
  temporaryDirectory: string;
  /** Owner-created cookie file; never inherit an operator's XAUTHORITY. */
  xauthority: string;
}): GuestDesktopNativeTools {
  if (!/^:[0-9]{1,3}(?:\.[0-9])?$/.test(options.display) || !options.temporaryDirectory.startsWith("/") || !options.xauthority.startsWith("/")) {
    throw new CuaExecutorError("invalid_request", "not_dispatched");
  }
  const environment = { PATH: "/usr/bin:/bin", HOME: options.temporaryDirectory, DISPLAY: options.display,
    XAUTHORITY: options.xauthority, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };

  // The direct child handle remains the only termination authority. Native helper
  // stderr can contain user text; consume it with a bound, never return or log it.
  async function helper(binary: "xdotool" | "scrot", args: readonly string[], signal: AbortSignal, text?: string): Promise<Buffer> {
    if (signal.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(`/usr/bin/${binary}`, [...args], {
        cwd: options.temporaryDirectory, env: environment, stdio: ["pipe", "pipe", "pipe"]
      });
      let live = true, failed = false, outputBytes = 0;
      const stdout: Buffer[] = [];
      let killDeadline: NodeJS.Timeout | undefined;
      let failureCode: "session_revoked" | "deadline_exceeded" | "execution_failed" = "execution_failed";
      const fail = (code: typeof failureCode): void => {
        if (failed) return;
        failed = true; failureCode = code;
        if (live) child.kill("SIGKILL");
        killDeadline = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          reject(new UnconfirmedHelperExit());
        }, 2000);
      };
      const abort = (): void => fail("session_revoked");
      signal.addEventListener("abort", abort, { once: true });
      const deadline = setTimeout(() => fail("deadline_exceeded"), 10_000);
      const consume = (data: Buffer): void => { outputBytes += data.length; if (outputBytes > 16_384) fail("execution_failed"); };
      child.stdout.on("data", (data: Buffer) => { consume(data); if (!failed) stdout.push(data); });
      child.stderr.on("data", (data: Buffer) => {
        consume(data);
        // xdotool can report a skipped character while still exiting zero.
        if (text !== undefined && data.length) fail("execution_failed");
      });
      child.on("error", () => fail("execution_failed"));
      child.stdin.on("error", () => fail("execution_failed"));
      child.once("exit", () => { live = false; });
      child.once("close", code => {
        live = false;
        clearTimeout(deadline);
        clearTimeout(killDeadline);
        signal.removeEventListener("abort", abort);
        if (failed || code !== 0) reject(new CuaExecutorError(failureCode, "outcome_uncertain"));
        else resolve(Buffer.concat(stdout));
      });
      child.stdin.end(text);
      if (signal.aborted) abort();
    });
  }
  return {
    async input(args, signal) { await helper("xdotool", args, signal); },
    async activeWindowId(signal) {
      const value = (await helper("xdotool", ["getactivewindow"], signal)).toString("utf8");
      if (!/^[1-9][0-9]{0,9}\n?$/.test(value) || Number(value.trim()) > 0xffffffff) throw new CuaExecutorError("action_rejected", "not_dispatched");
      return value.trim();
    },
    async typeAscii(text, signal) {
      if (!/^[\x20-\x7e]+$/.test(text) || Buffer.byteLength(text) > BROWSER_CONTROL_LIMITS.textBytes) {
        throw new CuaExecutorError("action_rejected", "not_dispatched");
      }
      await helper("xdotool", ["type", "--clearmodifiers", "--delay", "0", "--file", "-"], signal, text);
    },
    async capture(signal) {
      if (signal.aborted) throw new CuaExecutorError("session_revoked", "not_dispatched");
      const directory = await mkdtemp(join(options.temporaryDirectory, "capture-"));
      const path = join(directory, "frame.png");
      let reclaim = true;
      try {
        await helper("scrot", ["--silent", path], signal);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > BROWSER_CONTROL_LIMITS.pngBytes) {
            throw new CuaExecutorError("invalid_response", "not_dispatched");
          }
          const buffer = Buffer.alloc(stat.size + 1);
          let offset = 0;
          while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (offset !== stat.size) throw new CuaExecutorError("invalid_response", "not_dispatched");
          return buffer.subarray(0, offset);
        } finally { await file.close(); }
      } catch (error) {
        if (error instanceof UnconfirmedHelperExit) reclaim = false;
        throw error;
      } finally {
        // A helper whose exit is unconfirmed might still be writing. Leave this
        // private guest state for the owner to reclaim with the runtime.
        if (reclaim) await rm(directory, { recursive: true, force: true });
      }
    }
  };
}
