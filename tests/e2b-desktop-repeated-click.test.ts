import { Sandbox as SdkDesktop } from "@e2b/desktop";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runComputerUseLoop, type CuaAction, type CuaExecutor, type CuaProvider } from "../src/computer-use.js";
import { createE2BDesktopExecutor, type E2BDesktopLike } from "../src/e2b-desktop-executor.js";
import { defaultRedactionHooks } from "../src/redaction.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function desktop(read?: () => unknown) {
  const port: E2BDesktopLike = {
    screenshot: async () => Buffer.alloc(0),
    leftClick: vi.fn(async () => undefined), rightClick: vi.fn(async () => undefined),
    middleClick: vi.fn(async () => undefined), doubleClick: vi.fn(async () => undefined),
    moveMouse: vi.fn(async () => undefined), scroll: vi.fn(async () => undefined),
    write: vi.fn(async () => undefined), press: vi.fn(async () => undefined),
    drag: vi.fn(async () => undefined), wait: vi.fn(async () => undefined),
    ...(read === undefined ? {} : { getCursorPosition: vi.fn(read) as NonNullable<E2BDesktopLike["getCursorPosition"]> })
  };
  return port;
}

const click: CuaAction = { kind: "click", x: 420, y: 450 };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("fresh cursor read avoids only redundant left/double-click movement (#681)", () => {
  it.each(["click", "double_click"] as const)("omits coordinates for an exact current %s target", async (kind) => {
    const port = desktop(() => ({ x: 420, y: 450 }));
    await createE2BDesktopExecutor(port).execute({ ...click, kind });
    expect(port.getCursorPosition).toHaveBeenCalledTimes(1);
    expect(kind === "click" ? port.leftClick : port.doubleClick).toHaveBeenCalledExactlyOnceWith();
    expect(port.moveMouse).not.toHaveBeenCalled();
  });

  it.each([{ x: 419, y: 450 }, { x: 420, y: 449 }])("keeps the requested target when the pointer differs: %j", async (position) => {
    const port = desktop(() => position);
    await createE2BDesktopExecutor(port).execute(click);
    expect(port.leftClick).toHaveBeenCalledExactlyOnceWith(420, 450);
  });

  it("keeps older/custom desktop dispatch without a cursor capability", async () => {
    const port = desktop();
    await createE2BDesktopExecutor(port).execute(click);
    expect(port.leftClick).toHaveBeenCalledExactlyOnceWith(420, 450);
  });

  it.each([null, undefined, 420, {}, { x: "420", y: 450 }, { x: 420, y: null },
    { x: 420.1, y: 450 }, { x: Infinity, y: 450 }, { x: -420, y: 450 },
    { get x() { throw new Error("malformed getter"); }, y: 450 }
  ])("falls back once on malformed pointer readback (%#)", async (value) => {
    const port = desktop(() => value);
    await createE2BDesktopExecutor(port).execute(click);
    expect(port.leftClick).toHaveBeenCalledExactlyOnceWith(420, 450);
  });

  it.each([420.1, 420.9, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])("preserves SDK target semantics for x=%s without rounding", async (x) => {
    const port = desktop(() => ({ x: Math.trunc(x), y: 450 }));
    await createE2BDesktopExecutor(port).execute({ ...click, x });
    expect(port.getCursorPosition).not.toHaveBeenCalled();
    expect(port.leftClick).toHaveBeenCalledExactlyOnceWith(x, 450);
  });

  it("accepts an exact zero coordinate without moving the existing pointer", async () => {
    const port = desktop(() => ({ x: 0, y: 450 }));
    await createE2BDesktopExecutor(port).execute({ ...click, x: 0 });
    expect(port.leftClick).toHaveBeenCalledExactlyOnceWith();
  });

  it.each(["sync", "async"])("falls back after a %s cursor error", async (mode) => {
    const port = desktop(() => { if (mode === "sync") throw new Error("unavailable"); return Promise.reject(new Error("unavailable")); });
    await createE2BDesktopExecutor(port).execute(click);
    expect(port.leftClick).toHaveBeenCalledExactlyOnceWith(420, 450);
  });

  it.each(["resolve", "reject"] as const)("bounds a hung read and ignores its late %s without replaying the click", async (settle) => {
    vi.useFakeTimers();
    const read = deferred<{ x: number; y: number }>();
    const port = desktop(() => read.promise);
    const action = createE2BDesktopExecutor(port).execute(click);
    await vi.advanceTimersByTimeAsync(499);
    expect(port.leftClick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await action;
    expect(port.leftClick).toHaveBeenCalledExactlyOnceWith(420, 450);
    if (settle === "resolve") read.resolve({ x: 420, y: 450 });
    else read.reject(new Error("late read rejection is observed"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.leftClick).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never retries a failed click after a successful read", async () => {
    const port = desktop(() => ({ x: 420, y: 450 }));
    const failure = new Error("click failed");
    vi.mocked(port.leftClick).mockRejectedValue(failure);
    await expect(createE2BDesktopExecutor(port).execute(click)).rejects.toBe(failure);
    expect(port.leftClick).toHaveBeenCalledTimes(1);
  });

  it("reads afresh across actions and sequential shared-world role executors", async () => {
    let current = { x: 420, y: 450 };
    const port = desktop(() => current);
    const firstRole = createE2BDesktopExecutor(port);
    const secondRole = createE2BDesktopExecutor(port);
    await firstRole.execute(click);
    current = { x: 200, y: 350 }; // Another action/role moved the cursor after the first click.
    await firstRole.execute(click);
    await secondRole.execute(click);
    expect(port.getCursorPosition).toHaveBeenCalledTimes(3);
    expect(vi.mocked(port.leftClick).mock.calls).toEqual([[], [420, 450], [420, 450]]);
  });

  it("keeps independent concurrent shared-world desktop seats independent", async () => {
    const a = desktop(() => ({ x: 420, y: 450 }));
    const b = desktop(() => ({ x: 200, y: 350 }));
    await Promise.all([createE2BDesktopExecutor(a).execute(click), createE2BDesktopExecutor(b).execute(click)]);
    expect(a.leftClick).toHaveBeenCalledExactlyOnceWith();
    expect(b.leftClick).toHaveBeenCalledExactlyOnceWith(420, 450);
  });

  it("keeps right/middle clicks and move/scroll dispatch unchanged", async () => {
    const port = desktop(() => ({ x: 420, y: 450 }));
    const executor = createE2BDesktopExecutor(port);
    await executor.execute({ ...click, button: "right" });
    await executor.execute({ ...click, button: "middle" });
    await executor.execute({ kind: "move", x: 420, y: 450 });
    await executor.execute({ kind: "scroll", x: 420, y: 450, dx: 0, dy: 100 });
    expect(port.getCursorPosition).not.toHaveBeenCalled();
    expect(port.rightClick).toHaveBeenCalledExactlyOnceWith(420, 450);
    expect(port.middleClick).toHaveBeenCalledExactlyOnceWith(420, 450);
    expect(port.moveMouse).toHaveBeenCalledTimes(2);
  });
});

describe("cancellation during pointer preparation", () => {
  it("does not read or click for an already cancelled direct call", async () => {
    const controller = new AbortController(); controller.abort();
    const port = desktop(() => ({ x: 420, y: 450 }));
    await expect(createE2BDesktopExecutor(port).execute(click, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(port.getCursorPosition).not.toHaveBeenCalled();
    expect(port.leftClick).not.toHaveBeenCalled();
  });

  it.each(["abort", "deadline"] as const)("the actual loop's %s prevents a late click through an executor wrapper", async (stop) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const readStarted = deferred<void>();
    const read = deferred<{ x: number; y: number }>();
    const port = desktop(() => { readStarted.resolve(); return read.promise; });
    const base = createE2BDesktopExecutor(port);
    let forwardedSignal: AbortSignal | undefined;
    // Same transparent execute forwarding used by the standalone study-state adapter.
    const executor: CuaExecutor = {
      observe: async () => ({ stateSignature: "ready", appState: {} }),
      execute: (...args) => { forwardedSignal = args[1]; return base.execute(...args); }
    };
    const provider: CuaProvider = {
      id: "synthetic-pointer-control", version: "1",
      capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: false, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "open" },
      nextTurn: async () => ({ actions: [click], pendingSafetyChecks: [], done: false })
    };
    const run = runComputerUseLoop({ instructions: "click the synthetic target", provider, executor,
      persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
      redaction: defaultRedactionHooks, timeoutMs: 100, now: () => Date.now(), signal: controller.signal });
    await readStarted.promise;
    if (stop === "abort") controller.abort();
    else await vi.advanceTimersByTimeAsync(100);
    const result = await run;
    expect(result.completionReason).toBe(stop === "abort" ? "harness_error" : "budget_reached");
    expect(forwardedSignal?.aborted).toBe(true);
    read.resolve({ x: 420, y: 450 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(port.leftClick).not.toHaveBeenCalled();
    expect(result.trace.items.filter(item => item.kind === "ui_action" && item.lifecycle === "completed")).toEqual([]);
  });
});

describe("installed SDK command conformance", () => {
  it("uses actual SDK coordinate-free primitives and leaves fractional movement unchanged", async () => {
    // Direct construction does not allocate or bootstrap. Only the command method port is
    // replaced; these are shell results, not fabricated provider HTTP response fixtures.
    const sdk = new SdkDesktop({ sandboxId: "synthetic-local-desktop", envdVersion: "0.0.0", debug: true, apiKey: "synthetic-not-a-provider-key" });
    const commands: string[] = [];
    sdk.commands.run = (async (command: string) => {
      commands.push(command);
      return { exitCode: 0, stdout: command === "xdotool getmouselocation" ? "x:420 y:450 screen:0 window:1\n" : "", stderr: "" };
    }) as typeof sdk.commands.run;
    const executor = createE2BDesktopExecutor(sdk);
    await executor.execute(click);
    await executor.execute({ ...click, kind: "double_click" });
    await executor.execute({ ...click, x: 420.9 });
    expect(commands).toEqual([
      "xdotool getmouselocation", "xdotool click 1",
      "xdotool getmouselocation", "xdotool click --repeat 2 1",
      "xdotool mousemove --sync 420.9 450", "xdotool click 1"
    ]);
  });
});
