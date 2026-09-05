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

// Conformance against the REAL installed desktop + base SDK. Debug mode avoids allocation;
// only SDK command/kill methods are replaced with local fault ports. No provider HTTP response
// fixtures are fabricated. Dependency upgrades must preserve constructor-before-bootstrap order.
const options = {
  debug: true,
  apiKey: "synthetic-not-a-provider-key",
  requestTimeoutMs: 30_000,
  timeoutMs: 60_000,
  resolution: [1280, 800],
  dpi: 96,
  lifecycle: { onTimeout: "kill" }
} as E2BDesktopCreateOptions;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function sdkProbe(config: {
  command?: (command: string, instance: number) => Promise<void>;
  kill?: (instance: number, opts: { requestTimeoutMs?: number; signal?: AbortSignal }) => Promise<boolean>;
} = {}) {
  const instances: SdkDesktop[] = [];
  const events: string[] = [];
  const killed: number[] = [];
  class ProbeSandbox extends SdkDesktop {
    constructor(...args: ConstructorParameters<typeof SdkDesktop>) {
      super(...args);
      const instance = instances.push(this);
      events.push(`construct-${instance}`);
      this.commands.run = (async (command: string) => {
        events.push(`command-${instance}`);
        await config.command?.(command, instance);
        // SDK method-port values (not API wire): both foreground results and background handles.
        return { exitCode: 0, stdout: "", stderr: "", pid: instance, disconnect: async () => undefined };
      }) as typeof this.commands.run;
      this.kill = async (opts) => {
        killed.push(instance);
        events.push(`kill-${instance}`);
        return config.kill?.(instance, opts ?? {}) ?? true;
      };
    }
  }
  // Guard the real allocator too: an SDK debug-mode change must fail this suite before HTTP.
  const allocation = vi.spyOn(ProbeSandbox as unknown as {
    createSandbox(...args: unknown[]): Promise<unknown>;
  }, "createSandbox").mockRejectedValue(new Error("provider allocation forbidden in conformance tests"));
  const list = vi.spyOn(ProbeSandbox, "list").mockImplementation(() => { throw new Error("account enumeration forbidden"); });
  const create = vi.spyOn(ProbeSandbox, "create");
  const module = guardDesktopSandboxCreate({ Sandbox: ProbeSandbox } as unknown as E2BDesktopModule);
  return { module, ProbeSandbox, instances, events, killed, list, create, allocation };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("desktop allocation ownership survives startup failure (#581)", () => {
  it("demonstrates the SDK leak, then reclaims its constructed instance through the guarded public create", async () => {
    const probe = sdkProbe({ command: async () => { throw new Error("Sandbox is probably not running anymore"); } });
    await expect(probe.ProbeSandbox.create(options)).rejects.toThrow("probably not running");
    expect(probe.instances).toHaveLength(1);
    expect(probe.killed).toEqual([]); // The unguarded installed SDK leaves its allocated handle behind.

    await expect(probe.module.Sandbox.create(options)).rejects.toMatchObject({
      name: "E2BDesktopStartupError", cleanup: "killed"
    });
    expect(probe.instances).toHaveLength(2);
    expect(probe.killed).toEqual([2]); // Only THIS attempt's acquired handle is cleanup authority.
    expect(probe.events).toEqual(["construct-1", "command-1", "construct-2", "command-2", "kill-2"]);
    expect(probe.list).not.toHaveBeenCalled();
    expect(probe.allocation).not.toHaveBeenCalled();
  });

  it.each([undefined, "custom-desktop-image"])("keeps successful create options and desktop behavior (%s)", async (template) => {
    const probe = sdkProbe();
    const desktop = await createDesktopSandbox(probe.module, options, template);
    expect(desktop).toBeInstanceOf(SdkDesktop);
    expect(desktop).toBeInstanceOf(probe.ProbeSandbox);
    expect(desktop).toBeInstanceOf(probe.module.Sandbox);
    expect(typeof desktop.screenshot).toBe("function");
    expect(typeof desktop.stream.start).toBe("function");
    expect(probe.create.mock.calls).toEqual(template === undefined ? [[options]] : [[template, options]]);
    expect(probe.killed).toEqual([]); // Successful ownership transfers to the existing lane teardown.
    expect(probe.list).not.toHaveBeenCalled();
    expect(probe.allocation).not.toHaveBeenCalled();
  });

  it("finishes cleanup before a transient startup retry can allocate a second instance", async () => {
    const probe = sdkProbe({
      command: async (_command, instance) => { if (instance === 1) throw new Error("12: [unimplemented] HTTP 404"); }
    });
    const reasons: string[] = [];
    const desktop = await createDesktopSandbox(probe.module, options, undefined, {
      sleep: async () => undefined,
      onRetry: (reason) => { probe.events.push("retry"); reasons.push(reason); }
    });
    expect(desktop).toBe(probe.instances[1]);
    expect(probe.killed).toEqual([1]);
    expect(probe.events.indexOf("kill-1")).toBeLessThan(probe.events.indexOf("retry"));
    expect(probe.events.indexOf("retry")).toBeLessThan(probe.events.indexOf("construct-2"));
    expect(reasons[0]).toContain("allocated sandbox was reclaimed");
    expect(probe.list).not.toHaveBeenCalled();
    expect(probe.allocation).not.toHaveBeenCalled();
  });

  it("keeps concurrent failure ownership separate when the second create fails first", async () => {
    const gates = [deferred(), deferred()];
    const probe = sdkProbe({ command: async (_command, instance) => {
      await gates[instance - 1]!.promise;
      throw new Error(`synthetic bootstrap failure ${instance}`);
    } });
    const first = probe.module.Sandbox.create(options).catch((error: unknown) => error);
    const second = probe.module.Sandbox.create(options).catch((error: unknown) => error);
    await vi.waitFor(() => expect(probe.instances).toHaveLength(2));
    gates[1]!.resolve();
    expect(await second).toMatchObject({ cleanup: "killed" });
    expect(probe.killed).toEqual([2]);
    gates[0]!.resolve();
    expect(await first).toMatchObject({ cleanup: "killed" });
    expect(probe.killed).toEqual([2, 1]);
    expect(probe.list).not.toHaveBeenCalled();
    expect(probe.allocation).not.toHaveBeenCalled();
  });

  it.each(["xdpyinfo", "startxfce4"])("reclaims failures during later desktop bootstrap (%s)", async (phase) => {
    const probe = sdkProbe({ command: async (command) => {
      if (command.includes(phase)) throw new Error(`synthetic ${phase} startup failure`);
    } });
    await expect(probe.module.Sandbox.create(options)).rejects.toMatchObject({ cleanup: "killed" });
    expect(probe.killed).toEqual([1]);
    expect(probe.events.filter((event) => event === "command-1").length).toBeGreaterThan(1);
    expect(probe.allocation).not.toHaveBeenCalled();
  });

  it("treats the SDK's exact-id 404 result as already gone", async () => {
    const probe = sdkProbe({ command: async () => { throw new Error("HTTP 503"); }, kill: async () => false });
    const error = await probe.module.Sandbox.create(options).catch((value: unknown) => value);
    expect(error).toMatchObject({ cleanup: "already_gone" });
    expect(isTransientE2BError(error)).toBe(true);
    expect(probe.killed).toEqual([1]);
  });

  it("fails without retry or cleanup-error leakage when reclamation is unconfirmed", async () => {
    const cleanupSecret = "synthetic-cleanup-credential";
    const probe = sdkProbe({
      command: async () => { throw new Error("HTTP 503 during startup"); },
      kill: async () => { throw new Error(cleanupSecret); }
    });
    const retry = vi.fn();
    const error = await createDesktopSandbox(probe.module, options, undefined, { onRetry: retry, sleep: async () => undefined })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(E2BDesktopStartupError);
    expect(error).toMatchObject({ cleanup: "unconfirmed" });
    expect(String(error)).toContain("cleanup of the allocated sandbox was not confirmed");
    expect(String(error)).not.toContain(cleanupSecret);
    expect(String(error)).not.toContain(options.apiKey);
    expect(retry).not.toHaveBeenCalled();
    expect(probe.instances).toHaveLength(1);
    expect(probe.killed).toEqual([1]);
    expect(probe.list).not.toHaveBeenCalled();
    expect(probe.allocation).not.toHaveBeenCalled();
  });

  it("bounds a hung cleanup and aborts its request before refusing another allocation", async () => {
    vi.useFakeTimers();
    let killOptions: { requestTimeoutMs?: number; signal?: AbortSignal } | undefined;
    const probe = sdkProbe({
      command: async () => { throw new Error("HTTP 503 during startup"); },
      kill: async (_instance, opts) => { killOptions = opts; return new Promise(() => undefined); }
    });
    const retry = vi.fn();
    const pending = createDesktopSandbox(probe.module, options, undefined, { onRetry: retry, sleep: async () => undefined })
      .catch((value: unknown) => value);
    await vi.advanceTimersByTimeAsync(DESKTOP_CREATE_CLEANUP_TIMEOUT_MS);
    expect(await pending).toMatchObject({ cleanup: "unconfirmed" });
    expect(killOptions?.requestTimeoutMs).toBe(DESKTOP_CREATE_CLEANUP_TIMEOUT_MS);
    expect(killOptions?.signal?.aborted).toBe(true);
    expect(retry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not invent ownership when allocation rejects before construction", async () => {
    const probe = sdkProbe();
    probe.create.mockRejectedValueOnce(new Error("401 Unauthorized"));
    await expect(probe.module.Sandbox.create(options)).rejects.toThrow("401 Unauthorized");
    expect(probe.instances).toHaveLength(0);
    expect(probe.killed).toHaveLength(0);
    expect(probe.list).not.toHaveBeenCalled();
    expect(probe.allocation).not.toHaveBeenCalled();
  });
});
