import { CommandExitError, SandboxNotFoundError, TimeoutError } from "@e2b/desktop";
import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import { makeChromeBrowserStateObserver } from "../../../src/substrates/e2b/desktop-cdp.js";
import { createE2BDesktopExecutor } from "../../../src/substrates/e2b/desktop-executor.js";
import type { E2BDesktopLike } from "../../../src/substrates/e2b/desktop-executor.js";
import { makeChromeDesktopGeometryObserver } from "../../../src/substrates/e2b/desktop-geometry.js";
import type {
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../../src/substrates/e2b/desktop-launch.js";
import { prepareDesktopMedia } from "../../../src/substrates/e2b/desktop-media.js";
import {
  acquireE2BDesktopSandbox,
  destroyE2BSandbox,
} from "../../../src/substrates/e2b/sandbox.js";

// The installed SDK's commands.run awaits CommandHandle.wait(), which throws the SDK's own
// CommandExitError on a non-zero exit (e2b 2.49.0 dist/index.js, CommandHandle.wait). These
// desktops fail every command that way, so a caller that reads result.exitCode never sees one.

const endpoint = { targetUrl: "http://127.0.0.1:3000/" };

function failingDesktop(error: unknown): E2BDesktopSandbox {
  return {
    sandboxId: "sb-command-exits",
    commands: {
      run: vi.fn(async () => {
        throw error;
      }),
    },
    files: { write: vi.fn(async () => undefined) },
    launch: vi.fn(),
    screenshot: vi.fn(),
    wait: vi.fn(async () => undefined),
    stream: { getAuthKey: vi.fn(), getUrl: vi.fn(), start: vi.fn() },
  } as unknown as E2BDesktopSandbox;
}

const exited = (exitCode: number, stderr: string): CommandExitError =>
  new CommandExitError({ exitCode, stdout: "", stderr, error: `exit status ${exitCode}` });

function screenDesktop(): E2BDesktopLike {
  const png = new PNG({ width: 4, height: 4 });
  const frame = PNG.sync.write(png);
  return {
    screenshot: () => frame,
    leftClick: () => undefined,
    rightClick: () => undefined,
    middleClick: () => undefined,
    doubleClick: () => undefined,
    moveMouse: () => undefined,
    scroll: () => undefined,
    write: () => undefined,
    press: () => undefined,
    drag: () => undefined,
    wait: () => undefined,
  };
}

describe("an E2B desktop command that exits non-zero", () => {
  it.fails("reports the browser-state observer unavailable, once per lane", async () => {
    const desktop = failingDesktop(exited(127, "bash: line 1: python3: command not found"));
    const onUnavailable = vi.fn();
    const executor = createE2BDesktopExecutor(screenDesktop(), {
      observeBrowserState: makeChromeBrowserStateObserver(
        desktop,
        1_000,
        endpoint,
        undefined,
        onUnavailable,
      ),
    });
    await executor.observe();
    await executor.observe();
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0]?.[0]).toMatch(/^probe exited 127: .*python3/);
  });

  it.fails("reports a timed-out browser-state probe as unavailable too", async () => {
    const desktop = failingDesktop(new TimeoutError("[deadline_exceeded] command timed out"));
    const onUnavailable = vi.fn();
    const observe = makeChromeBrowserStateObserver(
      desktop,
      1_000,
      endpoint,
      undefined,
      onUnavailable,
    );
    await expect(observe()).resolves.toEqual({});
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable.mock.calls[0]?.[0]).toMatch(/^probe failed: .*timed out/);
  });

  it.fails("names the exit when the geometry probe fails", async () => {
    const desktop = failingDesktop(exited(1, "Traceback: ConnectionRefusedError"));
    const onUnavailable = vi.fn();
    const measure = makeChromeDesktopGeometryObserver(
      desktop,
      1_000,
      endpoint,
      undefined,
      onUnavailable,
    );
    await expect(measure()).resolves.toBeUndefined();
    expect(onUnavailable).toHaveBeenCalledWith(
      expect.stringMatching(/^probe exited 1: .*ConnectionRefusedError/),
    );
  });

  it.fails("says why a synthetic camera feed could not be generated", async () => {
    const desktop = failingDesktop(exited(127, "bash: line 1: ffmpeg: command not found"));
    await expect(
      prepareDesktopMedia(desktop, { camera: { source: "synthetic" } }, "prompt", "/tmp", 1_000),
    ).rejects.toThrow(
      /synthetic camera feed could not be generated .*ffmpeg exited 127: .*ffmpeg: command not found/,
    );
  });
});

describe("releasing an E2B sandbox that is already gone", () => {
  function moduleWith(kill: (id: string) => Promise<unknown>): E2BDesktopModule {
    const desktop = { sandboxId: "sb-gone" } as E2BDesktopSandbox;
    return {
      Sandbox: { create: vi.fn(async () => desktop), kill },
    } as unknown as E2BDesktopModule;
  }

  it.fails("reads the SDK's not-found error as already gone, as reclaim does", async () => {
    const module = moduleWith(async (id) => {
      throw new SandboxNotFoundError(`Sandbox ${id} not found`);
    });
    const { allocation } = await acquireE2BDesktopSandbox({
      module,
      options: { apiKey: "synthetic" },
      receipt: null,
    });
    expect(await allocation.close()).toEqual({ status: "released", reason: "already_gone" });
    expect(await destroyE2BSandbox(module, "sb-gone", { requestTimeoutMs: 1_000 })).toEqual({
      state: "already-gone",
    });
  });

  it.fails("does not read a malformed kill result as already gone during reclaim", async () => {
    const module = moduleWith(async () => undefined);
    const { allocation } = await acquireE2BDesktopSandbox({
      module,
      options: { apiKey: "synthetic" },
      receipt: null,
    });
    expect(await allocation.close()).toEqual({ status: "unconfirmed", reason: "invalid_result" });
    expect(await destroyE2BSandbox(module, "sb-gone", { requestTimeoutMs: 1_000 })).toMatchObject({
      state: "kill-failed",
    });
  });
});
