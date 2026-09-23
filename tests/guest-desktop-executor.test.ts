import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { createGuestDesktopExecutor, guestDesktopChord, type GuestDesktopTools } from "../src/guest-desktop-executor.js";

function fixture(overrides: Partial<GuestDesktopTools> = {}) {
  const authority = new AbortController();
  const onTerminal = vi.fn();
  const tools: GuestDesktopTools = {
    capture: vi.fn(async () => PNG.sync.write(new PNG({ width: 100, height: 80 }))),
    input: vi.fn(async () => {}), prepareText: vi.fn(async () => ({ paste: async () => {}, close: async () => {} })), ...overrides
  };
  return { authority, onTerminal, tools, executor: createGuestDesktopExecutor({ width: 100, height: 80, tools, authoritySignal: authority.signal, onTerminal }) };
}

describe("guest headed desktop", () => {
  it.each(["ctrl+a", "--window", "a key Return", "a\nclick 1", "$(touch x)", "mousemove", "a+b", "__proto__", "toString", "", "💚"])("refuses command-like or unsupported key %j", async key => {
    const f = fixture();
    await expect(f.executor.execute({ kind: "keypress", keys: [key] })).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.input).not.toHaveBeenCalled();
    expect(f.onTerminal).not.toHaveBeenCalled();
  });
  it("normalizes common aliases only", () => {
    expect(guestDesktopChord(["CONTROL", "SHIFT", "l"])).toBe("ctrl+shift+l");
    expect(guestDesktopChord(["ALT", "ArrowLeft"])).toBe("alt+Left");
    expect(guestDesktopChord(["F12"])).toBe("F12");
    expect(() => guestDesktopChord(["CTRL", "Control", "a"])).toThrow();
  });
  it.each([[-1, 0], [0, -1], [100, 0], [0, 80], [NaN, 2], [Infinity, 1]])("rejects outside-frame coordinates %j,%j before moving", async (x, y) => {
    const f = fixture();
    await expect(f.executor.execute({ kind: "click", x, y })).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
  it("validates the entire drag before the first input", async () => {
    const f = fixture();
    await expect(f.executor.execute({ kind: "drag", path: [{ x: 10, y: 10 }, { x: 101, y: 10 }] })).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
  it.each(["before\0after", "\ud800"])("rejects text that native UTF-8 cannot preserve", async text => {
    const f = fixture();
    await expect(f.executor.execute({ kind: "type", text })).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.prepareText).not.toHaveBeenCalled();
  });
  it("does not release a held mouse button after revocation", async () => {
    const inputs: string[][] = [];
    const f = fixture({ input: async args => {
      inputs.push([...args]);
      if (args[0] === "mousedown") f.authority.abort();
    } });
    await expect(f.executor.execute({ kind: "drag", path: [{ x: 1, y: 1 }, { x: 60, y: 50 }] })).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(inputs).toEqual([["mousemove", "1", "1"], ["mousedown", "1"]]);
    expect(f.onTerminal).toHaveBeenCalledOnce();
    await expect(f.executor.execute({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({ code: "session_revoked" });
    expect(inputs).toHaveLength(2);
  });
  it("never retries a failed native operation or exposes its payload", async () => {
    const f = fixture({ input: async () => { throw new Error("private action contents"); } });
    await expect(f.executor.execute({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain", message: "Desktop executor could not complete the request." });
    expect(f.onTerminal).toHaveBeenCalledOnce();
    await expect(f.executor.observe()).rejects.toMatchObject({ code: "session_revoked" });
  });
  it("rejects overlapping actions instead of queueing after a cancelled owner", async () => {
    let resume!: () => void;
    const f = fixture({ prepareText: () => new Promise(resolve => { resume = () => resolve({ paste: async () => {}, close: async () => {} }); }) });
    const first = f.executor.execute({ kind: "type", text: "hello" });
    await expect(f.executor.execute({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({ code: "executor_busy", disposition: "not_dispatched" });
    f.authority.abort(); resume();
    await expect(first).rejects.toMatchObject({ code: "session_revoked" });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
  it("refuses a capture from a different coordinate space", async () => {
    const f = fixture({ capture: async () => PNG.sync.write(new PNG({ width: 99, height: 80 })) });
    await expect(f.executor.observe()).rejects.toMatchObject({ code: "invalid_response" });
    expect(f.onTerminal).toHaveBeenCalledOnce();
  });
  it("returns full-frame bytes with no fabricated browser metadata", async () => {
    const f = fixture();
    const observation = await f.executor.observe();
    expect(PNG.sync.read(observation.screenshot!).width).toBe(100);
    expect(Object.keys(observation).sort()).toEqual(["screenshot", "stateSignature"]);
  });
  it("cancels wait promptly without any native input", async () => {
    const f = fixture();
    const cancel = new AbortController();
    const waiting = f.executor.execute({ kind: "wait", ms: 30_000 }, cancel.signal);
    cancel.abort();
    await expect(waiting).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
  it("bounds native wheel fanout before any dispatch", async () => {
    const f = fixture();
    await expect(f.executor.execute({ kind: "scroll", x: 1, y: 1, dx: 1_000_000, dy: 0 })).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
});
