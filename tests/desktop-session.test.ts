import { describe, expect, it, vi } from "vitest";
import type { CuaExecutor } from "../src/computer-use.js";
import { ownDesktopAllocation } from "../src/desktop-session.js";

function executor(): CuaExecutor {
  return { observe: vi.fn(async () => ({ screenshot: Buffer.from("frame"), stateSignature: "state" })), execute: vi.fn(async () => {}) };
}

describe("owned desktop session", () => {
  it("forwards observations, actions and the original cancellation signal", async () => {
    const backend = executor();
    const session = ownDesktopAllocation({ resourceId: "owned", release: async () => ({ status: "released", reason: "terminated" }) }).open(backend);
    expect(await session.executor.observe()).toEqual(await backend.observe());
    const action = { kind: "click" as const, x: 3, y: 9, button: "left" as const };
    const signal = new AbortController().signal;
    await session.executor.execute(action, signal);
    expect(backend.execute).toHaveBeenCalledWith(action, signal);
  });

  it("shares one close attempt and rejects new operations before release settles", async () => {
    let finish!: () => void;
    const released = new Promise<void>(resolve => { finish = resolve; });
    const release = vi.fn(async () => { await released; return { status: "released" as const, reason: "terminated" as const }; });
    const allocation = ownDesktopAllocation({ resourceId: "owned", release });
    const backend = executor();
    const session = allocation.open(backend);
    const closing = session.close();
    expect(allocation.close()).toBe(closing);
    await expect(session.executor.observe()).rejects.toThrow("closed");
    await expect(session.executor.execute({ kind: "wait", ms: 1 })).rejects.toThrow("closed");
    expect(backend.observe).not.toHaveBeenCalled();
    expect(backend.execute).not.toHaveBeenCalled();
    finish();
    expect(await closing).toEqual({ status: "released", reason: "terminated" });
    expect(release).toHaveBeenCalledTimes(1);
    expect(session.close()).toBe(closing);
  });

  it("can release a failed allocation before participant binding and prevents rebinding", async () => {
    const allocation = ownDesktopAllocation({ resourceId: "owned", release: async () => ({ status: "released", reason: "already_gone" }) });
    await allocation.close();
    expect(() => allocation.open(executor())).toThrow("closed");
    const other = ownDesktopAllocation({ resourceId: "other", release: async () => ({ status: "released", reason: "terminated" }) });
    other.open(executor());
    expect(() => other.open(executor())).toThrow("already has");
    await other.close();
  });

  it("preserves unresolved cleanup and never retries it implicitly", async () => {
    const error = new Error("transport unavailable");
    const release = vi.fn(async () => { throw error; });
    const allocation = ownDesktopAllocation({ resourceId: "owned", release });
    const session = allocation.open(executor());
    expect(await session.close()).toEqual({ status: "unconfirmed", reason: "release_failed", error });
    expect(await allocation.close()).toEqual({ status: "unconfirmed", reason: "release_failed", error });
    expect(release).toHaveBeenCalledTimes(1);
    await expect(session.executor.observe()).rejects.toThrow("closed");
  });

  it("records deliberate retention without dispatching release or permitting further input", async () => {
    const release = vi.fn(async () => ({ status: "released" as const, reason: "terminated" as const }));
    const allocation = ownDesktopAllocation({ resourceId: "owned", release });
    const session = allocation.open(executor());
    expect(await session.close({ retainForDebug: true })).toEqual({ status: "retained", reason: "debug" });
    expect(await session.close()).toEqual({ status: "retained", reason: "debug" });
    expect(release).not.toHaveBeenCalled();
    await expect(session.executor.observe()).rejects.toThrow("closed");
  });

  it("can release while an observation is in flight", async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const backend = executor();
    backend.observe = async () => { await pending; return { stateSignature: "last" }; };
    const session = ownDesktopAllocation({ resourceId: "owned", release: async () => ({ status: "released", reason: "terminated" }) }).open(backend);
    const observation = session.executor.observe();
    expect((await session.close()).status).toBe("released");
    finish();
    await observation;
    await expect(session.executor.observe()).rejects.toThrow("closed");
  });
});
