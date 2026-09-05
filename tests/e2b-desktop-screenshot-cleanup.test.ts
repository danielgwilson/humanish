import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Sandbox as SdkDesktop } from "@e2b/desktop";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadE2BDesktopModule, type E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import {
  desktopScreenshotCleanupFailures,
  protectDesktopScreenshotCleanup
} from "../src/e2b-desktop-screenshot-cleanup.js";

const bytes = Uint8Array.from([137, 80, 78, 71]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Real installed SDK code, with debug mode preventing provider allocation. The local method
// ports below are commands/files, not invented provider HTTP response fixtures.
async function sdkProbe(options: {
  capture?: () => Promise<void>;
  read?: (path: string) => Promise<Uint8Array>;
  remove?: (path: string) => Promise<void>;
  fromLoader?: boolean;
} = {}) {
  const paths: { capture: string[]; read: string[]; remove: string[] } = { capture: [], read: [], remove: [] };
  const Base = options.fromLoader
    ? (await loadE2BDesktopModule()).Sandbox as unknown as typeof SdkDesktop
    : SdkDesktop;
  class ProbeSandbox extends Base {
    constructor(...args: ConstructorParameters<typeof SdkDesktop>) {
      super(...args);
      this.commands.run = (async (command: string) => {
        if (command.startsWith("scrot --pointer ")) {
          paths.capture.push(command.slice("scrot --pointer ".length));
          await options.capture?.();
        }
        return { exitCode: 0, stdout: "", stderr: "", pid: 1, disconnect: async () => undefined };
      }) as typeof this.commands.run;
      this.files.read = (async (path: string) => {
        paths.read.push(path);
        return options.read?.(path) ?? bytes;
      }) as typeof this.files.read;
      this.files.remove = (path: string) => {
        paths.remove.push(path);
        return options.remove?.(path) ?? Promise.resolve();
      };
    }
  }
  const desktop = await ProbeSandbox.create({ debug: true, apiKey: "synthetic-not-a-provider-key" });
  return { desktop, paths };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("SDK screenshot cleanup compatibility (#662)", () => {
  it("proves the installed SDK's detached rejection crashes strict Node, then the guarded path exits cleanly", () => {
    const helper = fileURLToPath(new URL("../src/e2b-desktop-screenshot-cleanup.ts", import.meta.url));
    const script = `
      import { Sandbox } from '@e2b/desktop';
      import { protectDesktopScreenshotCleanup, desktopScreenshotCleanupFailures } from ${JSON.stringify(helper)};
      let screenshotPath;
      class Probe extends Sandbox {
        constructor(...args) {
          super(...args);
          this.commands.run = async () => ({exitCode:0,stdout:'',stderr:'',pid:1,disconnect:async()=>{}});
          this.files.read = async (path) => { screenshotPath = path; return new Uint8Array([137,80,78,71]); };
          this.files.remove = () => new Promise((_, reject) => setTimeout(() => reject(new Error('synthetic-cleanup-failure')), 10));
        }
      }
      const desktop = await Probe.create({debug:true,apiKey:'synthetic-not-a-provider-key'});
      if (process.env.PROTECT_SCREENSHOT === '1') protectDesktopScreenshotCleanup(desktop);
      const image = await desktop.screenshot();
      console.log('image-bytes=' + image.length);
      if (process.env.UNRELATED_REMOVE === '1') desktop.files.remove(screenshotPath);
      await new Promise(resolve => setTimeout(resolve, 30));
      console.log('cleanup-failures=' + desktopScreenshotCleanupFailures(desktop));
    `;
    const run = (protect: boolean, unrelated = false) => spawnSync(process.execPath, [
      "--unhandled-rejections=strict", "--import", "tsx", "--input-type=module", "--eval", script
    ], { encoding: "utf8", env: { ...process.env, PROTECT_SCREENSHOT: protect ? "1" : "0", UNRELATED_REMOVE: unrelated ? "1" : "0" }, timeout: 10_000 });
    const original = run(false);
    expect(original.status).toBe(1);
    expect(original.stdout).toContain("image-bytes=4");
    expect(original.stderr).toContain("synthetic-cleanup-failure");
    const protectedRun = run(true);
    expect(protectedRun.status).toBe(0);
    expect(protectedRun.stdout).toContain("image-bytes=4");
    expect(protectedRun.stdout).toContain("cleanup-failures=1");
    expect(protectedRun.stderr).toContain("screenshot temporary-file cleanup failed (1)");
    expect(protectedRun.stderr).not.toContain("synthetic-cleanup-failure");
    // Even the SAME path outside the screenshot's async scope remains an ordinary rejection.
    const unrelated = run(true, true);
    expect(unrelated.status).toBe(1);
    expect(unrelated.stderr).toContain("synthetic-cleanup-failure");
  });

  it("guards direct create calls from the production loader, including derived SDK classes", async () => {
    const pending = deferred<void>();
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { desktop } = await sdkProbe({ fromLoader: true, remove: () => pending.promise });
    expect(await desktop.screenshot()).toBe(bytes);
    pending.reject(new Error("synthetic-loader-cleanup-failure"));
    await Promise.resolve();
    expect(desktopScreenshotCleanupFailures(desktop)).toBe(1);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("preserves exact SDK capture/read/remove paths, returned bytes, receiver, and idempotency", async () => {
    const { desktop, paths } = await sdkProbe();
    expect(protectDesktopScreenshotCleanup(desktop)).toBe(desktop);
    const screenshot = desktop.screenshot;
    expect(protectDesktopScreenshotCleanup(desktop).screenshot).toBe(screenshot);
    expect(await desktop.screenshot("bytes")).toBe(bytes);
    expect(paths.capture).toHaveLength(1);
    expect(paths.read).toEqual(paths.capture);
    expect(paths.remove).toEqual(paths.read);
    expect(desktopScreenshotCleanupFailures(desktop)).toBe(0);
  });

  it.each(["capture", "read"] as const)("preserves %s failure before any cleanup", async (phase) => {
    const error = new Error(`synthetic-${phase}-failure`);
    const { desktop, paths } = await sdkProbe({ [phase]: async () => { throw error; } });
    protectDesktopScreenshotCleanup(desktop);
    await expect(desktop.screenshot()).rejects.toBe(error);
    expect(paths.remove).toEqual([]);
    expect(desktopScreenshotCleanupFailures(desktop)).toBe(0);
  });

  it("preserves the original removal promise and rejection for ordinary awaited callers", async () => {
    const error = new Error("synthetic-awaited-remove-failure");
    const pending = deferred<void>();
    const { desktop } = await sdkProbe({ remove: () => pending.promise });
    protectDesktopScreenshotCleanup(desktop);
    const returned = desktop.files.remove("/tmp/ordinary-file");
    expect(returned).toBe(pending.promise);
    const rejected = expect(returned).rejects.toBe(error);
    pending.reject(error);
    await rejected;
    expect(desktopScreenshotCleanupFailures(desktop)).toBe(0);
  });

  it("keeps concurrent screenshot cleanup scopes separate and warns without raw paths/errors", async () => {
    const cleanups = [deferred<void>(), deferred<void>()];
    let next = 0;
    const { desktop, paths } = await sdkProbe({ remove: () => cleanups[next++]!.promise });
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    protectDesktopScreenshotCleanup(desktop);
    expect(await Promise.all([desktop.screenshot(), desktop.screenshot()])).toEqual([bytes, bytes]);
    expect(new Set(paths.remove).size).toBe(2);
    cleanups[1]!.reject(new Error("synthetic-private-error"));
    cleanups[0]!.reject(new Error("synthetic-private-error"));
    await Promise.resolve();
    expect(desktopScreenshotCleanupFailures(desktop)).toBe(2);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning.mock.calls.flat().join(" ")).not.toContain("synthetic-private-error");
    for (const path of paths.remove) expect(warning.mock.calls.flat().join(" ")).not.toContain(path);
  });

  it("does not hide an awaited removal failure inside a future SDK screenshot implementation", async () => {
    const error = new Error("synthetic-awaited-screenshot-cleanup");
    const pending = Promise.reject(error);
    const files = { write: async () => undefined, read: async () => bytes, remove: () => pending };
    const desktop = {
      files,
      async screenshot() {
        await files.read();
        await files.remove();
        return bytes;
      }
    } as unknown as E2BDesktopSandbox;
    const warning = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    protectDesktopScreenshotCleanup(desktop);
    await expect(desktop.screenshot()).rejects.toBe(error);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("leaves screenshot-only injected desktops unchanged", () => {
    const desktop = { files: { write: async () => undefined }, screenshot: async () => bytes } as unknown as E2BDesktopSandbox;
    const screenshot = desktop.screenshot;
    expect(protectDesktopScreenshotCleanup(desktop).screenshot).toBe(screenshot);
  });
});
