import { Sandbox as SdkDesktop } from "@e2b/desktop";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopSandbox,
  DESKTOP_CREATE_CLEANUP_TIMEOUT_MS,
  E2BDesktopStartupError,
  guardDesktopSandboxCreate,
  isTransientE2BError,
  type E2BDesktopCreateOptions,
  type E2BDesktopModule
} from "../src/e2b-desktop-launch.js";

// Execute the installed SDK's real constructor/create/_start paths without HTTP.
// Method-port faults do not claim to be captured provider wire responses.
const options = { debug: true, apiKey: "synthetic-not-a-provider-key", requestTimeoutMs: 30_000,
  timeoutMs: 60_000, resolution: [1280, 800], lifecycle: { onTimeout: "kill" } } as E2BDesktopCreateOptions;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function probe(config: {
  command?: (command: string) => Promise<void>;
  kill?: (call: number, opts: { requestTimeoutMs?: number; signal?: AbortSignal }) => Promise<boolean>;
} = {}) {
  const killCalls: Array<{ requestTimeoutMs?: number; signal?: AbortSignal }> = [];
  const originalKills: SdkDesktop["kill"][] = [];
  let constructed = 0;
  class Probe extends SdkDesktop {
    constructor(...args: ConstructorParameters<typeof SdkDesktop>) {
      super(...args);
      constructed++;
      this.commands.run = (async (command: string) => {
        await config.command?.(command);
        return { exitCode: 0, stdout: "", stderr: "", pid: 1, disconnect: async () => undefined };
      }) as typeof this.commands.run;
      this.kill = async (opts) => {
        killCalls.push(opts ?? {});
        return config.kill?.(killCalls.length, opts ?? {}) ?? true;
      };
      originalKills.push(this.kill);
    }
  }
  const allocation = vi.spyOn(Probe as unknown as { createSandbox(...args: unknown[]): Promise<unknown> }, "createSandbox")
    .mockRejectedValue(new Error("provider allocation forbidden in SDK compatibility tests"));
  const list = vi.spyOn(Probe, "list").mockImplementation(() => { throw new Error("account enumeration forbidden"); });
  return { module: guardDesktopSandboxCreate({ Sandbox: Probe } as unknown as E2BDesktopModule),
    Probe, killCalls, originalKills, allocation, list, constructed: () => constructed };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("installed desktop SDK cleanup compatibility", () => {
  it.each(["Xvfb", "xdpyinfo", "startxfce4", "pgrep -x xfce4-session"])(
    "preserves the original 503 cause from %s after confirmed cleanup", async (phase) => {
      const original = new Error("HTTP 503 synthetic startup failure");
      const p = probe({ command: async (command) => { if (command.includes(phase)) throw original; } });
      const error = await p.module.Sandbox.create(options).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(E2BDesktopStartupError);
      expect(error).toMatchObject({ cause: original, cleanup: "killed" });
      expect((error as E2BDesktopStartupError).cause).toBe(original);
      expect(isTransientE2BError(error)).toBe(true);
      expect(p.constructed()).toBe(1);
      expect(p.killCalls).toHaveLength(1);
      expect(p.allocation).not.toHaveBeenCalled();
      expect(p.list).not.toHaveBeenCalled();
    }
  );

  it("retains unconfirmed cleanup when the SDK swallows its internal cleanup failure", async () => {
    const startup = new Error("HTTP 503 synthetic startup failure");
    const cleanup = new Error("synthetic cleanup secret");
    const p = probe({ command: async () => { throw startup; }, kill: async (call) => {
      if (call === 1) throw cleanup;
      return true;
    } });
    const error = await p.module.Sandbox.create(options).catch((value: unknown) => value);
    expect(error).toMatchObject({ cause: startup, cleanup: "unconfirmed" });
    expect(isTransientE2BError(error)).toBe(false);
    expect(p.killCalls).toHaveLength(1);
    expect(String(error)).not.toContain(cleanup.message);
    expect(p.allocation).not.toHaveBeenCalled();
  });

  it("bounds cleanup even when the SDK calls kill internally before rejecting create", async () => {
    vi.useFakeTimers();
    const gate = deferred();
    const p = probe({ command: async () => { throw new Error("HTTP 503 synthetic startup failure"); },
      kill: async (call) => { if (call === 1) await gate.promise; return true; } });
    const retry = vi.fn();
    let settled = false;
    const pending = createDesktopSandbox(p.module, options, undefined, { onRetry: retry, sleep: async () => undefined })
      .then(() => undefined, (error: unknown) => error).then((error) => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(DESKTOP_CREATE_CLEANUP_TIMEOUT_MS + 1);
    try {
      expect(settled, "SDK-internal kill must not bypass Humanish's cleanup deadline").toBe(true);
      expect(await pending).toMatchObject({ cleanup: "unconfirmed" });
      expect(retry).not.toHaveBeenCalled();
      expect(p.constructed()).toBe(1);
      expect(p.killCalls).toHaveLength(1);
      expect(p.killCalls[0]?.signal?.aborted).toBe(true);
    } finally {
      gate.resolve();
      await pending;
    }
  });

  it("honors a lower request timeout and clears its cleanup timer", async () => {
    vi.useFakeTimers();
    const p = probe({ command: async () => { throw new Error("HTTP 503 synthetic startup failure"); },
      kill: async () => new Promise(() => undefined) });
    const pending = p.module.Sandbox.create({ ...options, requestTimeoutMs: 75 }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(75);
    expect(await pending).toMatchObject({ cleanup: "unconfirmed" });
    expect(p.killCalls).toHaveLength(1);
    expect(p.killCalls[0]?.requestTimeoutMs).toBe(75);
    expect(p.killCalls[0]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores the original kill method and caller options after successful create", async () => {
    const p = probe();
    const desktop = await p.module.Sandbox.create(options) as unknown as SdkDesktop;
    expect(desktop.kill).toBe(p.originalKills[0]);
    const teardownOptions = { requestTimeoutMs: 321, signal: new AbortController().signal };
    expect(await desktop.kill(teardownOptions)).toBe(true);
    expect(await desktop.kill(teardownOptions)).toBe(true);
    expect(p.killCalls).toEqual([teardownOptions, teardownOptions]);
  });

  it("restores inherited kill lookup without leaving a startup shim on the returned instance", async () => {
    const calls: Array<Parameters<SdkDesktop["kill"]>[0]> = [];
    class PrototypeKill extends SdkDesktop {
      constructor(...args: ConstructorParameters<typeof SdkDesktop>) {
        super(...args);
        this.commands.run = (async (_command: string) => ({ exitCode: 0, stdout: "", stderr: "", pid: 1,
          disconnect: async () => undefined })) as typeof this.commands.run;
      }
      override async kill(opts?: Parameters<SdkDesktop["kill"]>[0]) {
        calls.push(opts);
        return false;
      }
    }
    const allocation = vi.spyOn(PrototypeKill as unknown as { createSandbox(...args: unknown[]): Promise<unknown> }, "createSandbox")
      .mockRejectedValue(new Error("provider allocation forbidden in SDK compatibility tests"));
    const module = guardDesktopSandboxCreate({ Sandbox: PrototypeKill } as unknown as E2BDesktopModule);
    const desktop = await module.Sandbox.create(options) as unknown as SdkDesktop;
    expect(Object.hasOwn(desktop, "kill")).toBe(false);
    expect(desktop.kill).toBe(PrototypeKill.prototype.kill);
    const teardownOptions = { requestTimeoutMs: 456 };
    expect(await desktop.kill(teardownOptions)).toBe(false);
    expect(calls).toEqual([teardownOptions]);
    expect(allocation).not.toHaveBeenCalled();
  });
});
