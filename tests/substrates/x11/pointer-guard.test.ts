import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaProvider,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { executeX11Action, type X11Transport } from "../../../src/substrates/x11/desktop.js";
import { HOSTED_X11_DIALECT } from "../../../src/substrates/x11/translator.js";

// A hosted left or double click reads the pointer first and skips its synchronized move when the
// pointer is already at the target. These tests drive the runner over a fake transport whose
// pointer read can return anything a custom transport might.

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** A transport that records each xdotool command as one line; `read` answers pointer reads. */
function transport(read?: () => unknown) {
  const sent: string[] = [];
  const port: X11Transport & { sent: string[] } = {
    sent,
    input: vi.fn(async (args: readonly string[]) => {
      sent.push(args.join(" "));
    }),
    prepareText: async () => ({ paste: async () => {}, close: async () => {} }),
    wait: async () => {},
    capture: async () => Buffer.alloc(0),
    ...(read === undefined
      ? {}
      : { readPointer: vi.fn(read) as unknown as NonNullable<X11Transport["readPointer"]> }),
  };
  return port;
}

const click: CuaAction = { kind: "click", x: 420, y: 450 };
const MOVE_AND_CLICK = ["mousemove --sync 420 450", "click 1"];

function execute(port: X11Transport, action: CuaAction, signal = new AbortController().signal) {
  return executeX11Action(action, { transport: port, dialect: HOSTED_X11_DIALECT }, signal);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a fresh pointer read skips only redundant left and double-click moves", () => {
  it.each([
    ["click", "click 1"],
    ["double_click", "click --repeat 2 1"],
  ] as const)("skips the move for an exact current %s target", async (kind, sent) => {
    const port = transport(() => ({ x: 420, y: 450 }));
    await execute(port, { ...click, kind });
    expect(port.readPointer).toHaveBeenCalledTimes(1);
    expect(port.sent).toEqual([sent]);
  });

  it.each([
    { x: 419, y: 450 },
    { x: 420, y: 449 },
  ])("keeps the move when the pointer differs: %j", async (position) => {
    const port = transport(() => position);
    await execute(port, click);
    expect(port.sent).toEqual(MOVE_AND_CLICK);
  });

  it("moves for every click on a transport that cannot read the pointer", async () => {
    const port = transport();
    await execute(port, click);
    expect(port.sent).toEqual(MOVE_AND_CLICK);
  });

  it.each([
    null,
    undefined,
    420,
    {},
    { x: "420", y: 450 },
    { x: 420, y: null },
    { x: 420.1, y: 450 },
    { x: Infinity, y: 450 },
    { x: -420, y: 450 },
    {
      get x() {
        throw new Error("malformed getter");
      },
      y: 450,
    },
  ])("moves once on a malformed pointer read (%#)", async (value) => {
    const port = transport(() => value);
    await execute(port, click);
    expect(port.sent).toEqual(MOVE_AND_CLICK);
  });

  it.each([420.1, 420.9, NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])(
    "reads nothing and passes x=%s through unrounded",
    async (x) => {
      const port = transport(() => ({ x: Math.trunc(x), y: 450 }));
      await execute(port, { ...click, x });
      expect(port.readPointer).not.toHaveBeenCalled();
      expect(port.sent.at(-1)).toBe("click 1");
    },
  );

  it.each(["sync", "async"])("moves after a %s pointer read error", async (mode) => {
    const port = transport(() => {
      if (mode === "sync") throw new Error("unavailable");
      return Promise.reject(new Error("unavailable"));
    });
    await execute(port, click);
    expect(port.sent).toEqual(MOVE_AND_CLICK);
  });

  it.each(["resolve", "reject"] as const)(
    "bounds a hung read at 500 ms and ignores its late %s without replaying the click",
    async (settle) => {
      vi.useFakeTimers();
      const read = deferred<{ x: number; y: number }>();
      const port = transport(() => read.promise);
      const action = execute(port, click);
      await vi.advanceTimersByTimeAsync(499);
      expect(port.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await action;
      expect(port.sent).toEqual(MOVE_AND_CLICK);
      if (settle === "resolve") read.resolve({ x: 420, y: 450 });
      else read.reject(new Error("late read rejection is observed"));
      await vi.advanceTimersByTimeAsync(1000);
      expect(port.sent).toEqual(MOVE_AND_CLICK);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("never retries a failed click after a successful read", async () => {
    const port = transport(() => ({ x: 420, y: 450 }));
    const failure = new Error("click failed");
    vi.mocked(port.input).mockRejectedValue(failure);
    await expect(execute(port, click)).rejects.toBe(failure);
    expect(port.input).toHaveBeenCalledTimes(1);
  });

  it("reads afresh for every action", async () => {
    let current = { x: 420, y: 450 };
    const port = transport(() => current);
    await execute(port, click);
    current = { x: 200, y: 350 }; // Another action or participant moved the pointer.
    await execute(port, click);
    expect(port.readPointer).toHaveBeenCalledTimes(2);
    expect(port.sent).toEqual(["click 1", ...MOVE_AND_CLICK]);
  });

  it("reads nothing for right and middle clicks, moves and scrolls", async () => {
    const port = transport(() => ({ x: 420, y: 450 }));
    await execute(port, { ...click, button: "right" });
    await execute(port, { ...click, button: "middle" });
    await execute(port, { kind: "move", x: 420, y: 450 });
    await execute(port, { kind: "scroll", x: 420, y: 450, dx: 0, dy: 100 });
    expect(port.readPointer).not.toHaveBeenCalled();
    expect(port.sent.filter((line) => line.startsWith("mousemove"))).toHaveLength(4);
  });
});

describe("cancellation during pointer preparation", () => {
  it("does not read or click for an already cancelled call", async () => {
    const controller = new AbortController();
    controller.abort();
    const port = transport(() => ({ x: 420, y: 450 }));
    await expect(execute(port, click, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(port.readPointer).not.toHaveBeenCalled();
    expect(port.sent).toEqual([]);
  });

  it.each(["abort", "deadline"] as const)(
    "the actual loop's %s prevents a late click through an executor wrapper",
    async (stop) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      const readStarted = deferred<void>();
      const read = deferred<{ x: number; y: number }>();
      const port = transport(() => {
        readStarted.resolve();
        return read.promise;
      });
      const base: CuaExecutor = {
        observe: async () => ({ stateSignature: "ready" }),
        execute: (action, signal) =>
          executeX11Action(action, { transport: port, dialect: HOSTED_X11_DIALECT }, signal!),
      };
      let forwardedSignal: AbortSignal | undefined;
      // Same transparent execute forwarding used by the standalone study-state adapter.
      const executor: CuaExecutor = {
        observe: async () => ({ stateSignature: "ready", appState: {} }),
        execute: (...args) => {
          forwardedSignal = args[1];
          return base.execute(...args);
        },
      };
      const provider: CuaProvider = {
        id: "synthetic-pointer-control",
        version: "1",
        capabilities: {
          headless: true,
          structuredTrace: true,
          lanes: ["computer-use"],
          producesScreenshots: false,
          byoModel: false,
          preGrantableApprovals: false,
          inProcessTools: false,
          license: "open",
        },
        nextTurn: async () => ({ actions: [click], pendingSafetyChecks: [], done: false }),
      };
      const run = runComputerUseLoop({
        instructions: "click the synthetic target",
        provider,
        executor,
        persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
        redaction: defaultRedactionHooks,
        timeoutMs: 100,
        now: () => Date.now(),
        signal: controller.signal,
      });
      await readStarted.promise;
      if (stop === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(100);
      const result = await run;
      expect(result.completionReason).toBe(stop === "abort" ? "harness_error" : "budget_reached");
      expect(forwardedSignal?.aborted).toBe(true);
      read.resolve({ x: 420, y: 450 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(port.sent).toEqual([]);
      expect(
        result.trace.items.filter(
          (item) => item.kind === "ui_action" && item.lifecycle === "completed",
        ),
      ).toEqual([]);
    },
  );
});
