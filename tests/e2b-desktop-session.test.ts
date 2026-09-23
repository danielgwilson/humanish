import { describe, expect, it, vi } from "vitest";
import { allocateE2BDesktopSession } from "../src/e2b-desktop-session.js";
import type { E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";

// Allocation tests need only the SDK's identity and existing create/kill contract.
// No HTTP fixture or new provider wire protocol is modeled here.
function fixture(result: boolean = true) {
  const desktop = { sandboxId: "owned-desktop" } as E2BDesktopSandbox;
  const create = vi.fn(async () => desktop);
  const kill = vi.fn(async (_id: string, _options?: { requestTimeoutMs?: number }) => result);
  const list = vi.fn(() => { throw new Error("must not enumerate"); });
  const module: E2BDesktopModule = { Sandbox: { create, kill, list } };
  return { desktop, module, create, kill, list };
}

describe("hosted desktop session adapter", () => {
  it("preserves default and template creation arguments", async () => {
    const f = fixture();
    const options = { apiKey: "synthetic", timeoutMs: 1000, lifecycle: { onTimeout: "kill" as const } };
    const first = await allocateE2BDesktopSession(f.module, options);
    expect(f.create).toHaveBeenLastCalledWith(options);
    await first.allocation.close();
    const second = await allocateE2BDesktopSession(f.module, options, "custom-desktop");
    expect(f.create).toHaveBeenLastCalledWith("custom-desktop", options);
    await second.allocation.close();
  });

  it("captures identity and release authority before mutable provisioning hooks", async () => {
    const f = fixture();
    const replacement = vi.fn(async () => true);
    const acquired = await allocateE2BDesktopSession(f.module, { apiKey: "synthetic" });
    f.desktop.sandboxId = "unrelated-desktop";
    f.module.Sandbox.kill = replacement;
    expect(acquired.allocation.resourceId).toBe("owned-desktop");
    expect(await acquired.allocation.close()).toEqual({ status: "released", reason: "terminated" });
    expect(f.kill).toHaveBeenCalledWith("owned-desktop", { requestTimeoutMs: 60_000 });
    expect(replacement).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });

  it("treats the SDK false/404 result as already gone", async () => {
    const f = fixture(false);
    const { allocation } = await allocateE2BDesktopSession(f.module, { apiKey: "synthetic" });
    expect(await allocation.close()).toEqual({ status: "released", reason: "already_gone" });
    expect(f.list).not.toHaveBeenCalled();
  });

  it("does not claim release for absent methods, malformed results or exceptions", async () => {
    const missing = fixture();
    delete missing.module.Sandbox.kill;
    expect(await (await allocateE2BDesktopSession(missing.module, { apiKey: "synthetic" })).allocation.close())
      .toEqual({ status: "unconfirmed", reason: "release_unavailable" });
    const malformed = fixture();
    malformed.module.Sandbox.kill = "unsupported" as unknown as NonNullable<E2BDesktopModule["Sandbox"]["kill"]>;
    const acquired = await allocateE2BDesktopSession(malformed.module, { apiKey: "synthetic" });
    expect(acquired.allocation.resourceId).toBe("owned-desktop");
    expect(await acquired.allocation.close()).toEqual({ status: "unconfirmed", reason: "release_unavailable" });
    const invalid = fixture();
    invalid.kill.mockResolvedValue(undefined as unknown as boolean);
    expect(await (await allocateE2BDesktopSession(invalid.module, { apiKey: "synthetic" })).allocation.close())
      .toEqual({ status: "unconfirmed", reason: "invalid_result" });
    const failed = fixture();
    failed.kill.mockRejectedValue(new Error("unreachable"));
    expect(await (await allocateE2BDesktopSession(failed.module, { apiKey: "synthetic" })).allocation.close())
      .toMatchObject({ status: "unconfirmed", reason: "release_failed" });
    expect(failed.list).not.toHaveBeenCalled();
  });

  it("does not invent cleanup authority when creation never returns a handle", async () => {
    const f = fixture();
    f.create.mockRejectedValue(new Error("unauthorized"));
    await expect(allocateE2BDesktopSession(f.module, { apiKey: "synthetic" })).rejects.toThrow("unauthorized");
    expect(f.kill).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });
});
