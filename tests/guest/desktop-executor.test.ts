import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";
import { ComputerUseExecutorError } from "../../src/actors/computer-use/executor-error.js";
import type { CuaAction } from "../../src/actors/computer-use/loop.js";
import { BROWSER_CONTROL_LIMITS } from "../../src/browser-control/protocol.js";
import { perceptualSignature } from "../../src/evidence/frame-signature.js";
import {
  createGuestDesktopExecutor,
  type GuestDesktopTools,
} from "../../src/guest/desktop-executor.js";

function fixture(overrides: Partial<GuestDesktopTools> = {}) {
  const authority = new AbortController();
  const onTerminal = vi.fn();
  const tools: GuestDesktopTools = {
    capture: vi.fn(async () => PNG.sync.write(new PNG({ width: 100, height: 80 }))),
    input: vi.fn(async () => {}),
    prepareText: vi.fn(async () => ({ paste: async () => {}, close: async () => {} })),
    ...overrides,
  };
  return {
    authority,
    onTerminal,
    tools,
    executor: createGuestDesktopExecutor({
      width: 100,
      height: 80,
      tools,
      authoritySignal: authority.signal,
      onTerminal,
    }),
  };
}

describe("guest headed desktop", () => {
  it.each([
    "ctrl+",
    "--window",
    "a key Return",
    "a\nclick 1",
    "$(touch x)",
    "mousemove",
    "a++b",
    "__proto__",
    "toString",
    "",
    "💚",
  ])("refuses command-like or unsupported key %j", async (key) => {
    const f = fixture();
    await expect(f.executor.execute({ kind: "keypress", keys: [key] })).rejects.toMatchObject({
      disposition: "not_dispatched",
    });
    expect(f.tools.input).not.toHaveBeenCalled();
    expect(f.onTerminal).not.toHaveBeenCalled();
  });
  it.each([
    [-1, 0],
    [0, -1],
    [100, 0],
    [0, 80],
    [NaN, 2],
    [Infinity, 1],
  ])("rejects outside-frame coordinates %j,%j before moving", async (x, y) => {
    const f = fixture();
    await expect(f.executor.execute({ kind: "click", x, y })).rejects.toMatchObject({
      disposition: "not_dispatched",
    });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
  it("validates the entire drag before the first input", async () => {
    const f = fixture();
    await expect(
      f.executor.execute({
        kind: "drag",
        path: [
          { x: 10, y: 10 },
          { x: 101, y: 10 },
        ],
      }),
    ).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
  it.each(["before\0after", "\ud800"])(
    "rejects text that native UTF-8 cannot preserve",
    async (text) => {
      const f = fixture();
      await expect(f.executor.execute({ kind: "type", text })).rejects.toMatchObject({
        disposition: "not_dispatched",
      });
      expect(f.tools.prepareText).not.toHaveBeenCalled();
    },
  );
  it("does not release a held mouse button after revocation", async () => {
    const inputs: string[][] = [];
    const f = fixture({
      input: async (args) => {
        inputs.push([...args]);
        if (args[0] === "mousedown") f.authority.abort();
      },
    });
    await expect(
      f.executor.execute({
        kind: "drag",
        path: [
          { x: 1, y: 1 },
          { x: 60, y: 50 },
        ],
      }),
    ).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(inputs).toEqual([
      ["mousemove", "1", "1"],
      ["mousedown", "1"],
    ]);
    expect(f.onTerminal).toHaveBeenCalledOnce();
    await expect(f.executor.execute({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({
      code: "session_revoked",
    });
    expect(inputs).toHaveLength(2);
  });
  it("never retries a failed native operation or exposes its payload", async () => {
    const f = fixture({
      input: async () => {
        throw new Error("private action contents");
      },
    });
    await expect(f.executor.execute({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
      message: "Desktop executor could not complete the request.",
    });
    expect(f.onTerminal).toHaveBeenCalledOnce();
    await expect(f.executor.observe()).rejects.toMatchObject({ code: "session_revoked" });
  });
  it("rejects overlapping actions instead of queueing after a cancelled owner", async () => {
    let resume!: () => void;
    const f = fixture({
      prepareText: () =>
        new Promise((resolve) => {
          resume = () => resolve({ paste: async () => {}, close: async () => {} });
        }),
    });
    const first = f.executor.execute({ kind: "type", text: "hello" });
    await expect(f.executor.execute({ kind: "click", x: 1, y: 1 })).rejects.toMatchObject({
      code: "executor_busy",
      disposition: "not_dispatched",
    });
    f.authority.abort();
    resume();
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
    await expect(
      f.executor.execute({ kind: "scroll", x: 1, y: 1, dx: 1_000_000, dy: 0 }),
    ).rejects.toMatchObject({ disposition: "not_dispatched" });
    expect(f.tools.input).not.toHaveBeenCalled();
  });
});

describe("guest held modifiers", () => {
  it("holds modifiers around the pointer input as one keydown and one keyup", async () => {
    const inputs: string[][] = [];
    const f = fixture({ input: async (args) => void inputs.push([...args]) });
    await f.executor.execute({ kind: "click", x: 10, y: 20, heldKeys: ["SHIFT", "CTRL"] });
    await f.executor.execute({
      kind: "drag",
      path: [
        { x: 1, y: 1 },
        { x: 5, y: 5 },
      ],
      heldKeys: ["ALT"],
    });
    expect(inputs).toEqual([
      ["keydown", "shift+ctrl"],
      ["mousemove", "10", "20"],
      ["click", "1"],
      ["keyup", "shift+ctrl"],
      ["keydown", "alt"],
      ["mousemove", "1", "1"],
      ["mousedown", "1"],
      ["mousemove", "5", "5"],
      ["mouseup", "1"],
      ["keyup", "alt"],
    ]);
    // A scroll that sends no wheel steps presses nothing.
    await f.executor.execute({ kind: "scroll", x: 1, y: 1, dx: 0, dy: 0, heldKeys: ["SHIFT"] });
    expect(inputs).toHaveLength(10);
  });
  it.each([["a"], ["HYPER"], ["CTRL", "CONTROL"], ["--window"]])(
    "refuses held key %j before any input",
    async (...heldKeys) => {
      const f = fixture();
      await expect(
        f.executor.execute({ kind: "click", x: 1, y: 1, heldKeys }),
      ).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
      expect(f.tools.input).not.toHaveBeenCalled();
      expect(f.onTerminal).not.toHaveBeenCalled();
    },
  );
  it("releases held modifiers when the pointer input fails, then ends the session", async () => {
    const inputs: string[][] = [];
    const f = fixture({
      input: async (args) => {
        inputs.push([...args]);
        if (args[0] === "click") throw new Error("synthetic click failure");
      },
    });
    await expect(
      f.executor.execute({ kind: "click", x: 1, y: 1, heldKeys: ["SHIFT"] }),
    ).rejects.toMatchObject({ code: "execution_failed", disposition: "outcome_uncertain" });
    expect(inputs).toEqual([
      ["keydown", "shift"],
      ["mousemove", "1", "1"],
      ["click", "1"],
      ["keyup", "shift"],
    ]);
    expect(f.onTerminal).toHaveBeenCalledOnce();
  });
  it("does not retry a failed keyup or release after revocation", async () => {
    const failedRelease: string[][] = [];
    const releaseFails = fixture({
      input: async (args) => {
        failedRelease.push([...args]);
        if (args[0] === "keyup") throw new Error("synthetic keyup failure");
      },
    });
    await expect(
      releaseFails.executor.execute({ kind: "move", x: 1, y: 1, heldKeys: ["SHIFT"] }),
    ).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(failedRelease.filter((args) => args[0] === "keyup")).toHaveLength(1);

    const revoked: string[][] = [];
    const f = fixture({
      input: async (args) => {
        revoked.push([...args]);
        if (args[0] === "mousemove") f.authority.abort();
      },
    });
    await expect(
      f.executor.execute({ kind: "click", x: 1, y: 1, heldKeys: ["SHIFT"] }),
    ).rejects.toMatchObject({ disposition: "outcome_uncertain" });
    expect(revoked).toEqual([
      ["keydown", "shift"],
      ["mousemove", "1", "1"],
    ]);
  });
});

/** Where a typing action's text channel fails, if anywhere. */
interface TextFailures {
  prepare?: Error;
  paste?: Error;
  close?: Error;
}

/** A fixture that records every native input. */
function recorded(overrides: Partial<GuestDesktopTools> = {}) {
  const inputs: string[][] = [];
  const f = fixture({ input: async (args) => void inputs.push([...args]), ...overrides });
  return { ...f, inputs };
}

// What the executor does today, pinned before its split into named steps (commit 1 of that PR).
describe("guest executor commands the split keeps", () => {
  it.each([
    [0, 80],
    [100, 0],
    [-1, 80],
    [100.5, 80],
    [BROWSER_CONTROL_LIMITS.dimension + 1, 1],
    [BROWSER_CONTROL_LIMITS.dimension, BROWSER_CONTROL_LIMITS.dimension],
  ])("refuses a %j by %j frame at construction", (width, height) => {
    expect(() =>
      createGuestDesktopExecutor({
        width,
        height,
        tools: fixture().tools,
        authoritySignal: new AbortController().signal,
        onTerminal: () => {},
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_request", disposition: "not_dispatched" }));
  });

  it("accepts a frame whose area is exactly the pixel cap", () => {
    const side = Math.sqrt(BROWSER_CONTROL_LIMITS.pixels);
    expect(Number.isSafeInteger(side)).toBe(true);
    expect(() =>
      createGuestDesktopExecutor({
        width: side,
        height: side,
        tools: fixture().tools,
        authoritySignal: new AbortController().signal,
        onTerminal: () => {},
      }),
    ).not.toThrow();
  });

  it.each([
    [{ kind: "move", x: 10, y: 20 }, [["mousemove", "10", "20"]]],
    [
      { kind: "click", x: 10, y: 20 },
      [
        ["mousemove", "10", "20"],
        ["click", "1"],
      ],
    ],
    [
      { kind: "click", x: 10, y: 20, button: "middle" },
      [
        ["mousemove", "10", "20"],
        ["click", "2"],
      ],
    ],
    [
      { kind: "click", x: 10, y: 20, button: "right" },
      [
        ["mousemove", "10", "20"],
        ["click", "3"],
      ],
    ],
    [
      { kind: "double_click", x: 10, y: 20 },
      [
        ["mousemove", "10", "20"],
        ["click", "--repeat", "2", "--delay", "100", "1"],
      ],
    ],
    [{ kind: "keypress", keys: ["CTRL", "a"] }, [["key", "--clearmodifiers", "ctrl+a"]]],
    [
      {
        kind: "drag",
        path: [
          { x: 1, y: 2 },
          { x: 3, y: 4 },
          { x: 5, y: 6 },
        ],
      },
      [
        ["mousemove", "1", "2"],
        ["mousedown", "1"],
        ["mousemove", "3", "4"],
        ["mousemove", "5", "6"],
        ["mouseup", "1"],
      ],
    ],
    [
      { kind: "scroll", x: 10, y: 20, dx: 240, dy: -121 },
      [
        ["mousemove", "10", "20"],
        ["click", "7"],
        ["click", "7"],
        ["click", "4"],
        ["click", "4"],
      ],
    ],
    [
      { kind: "scroll", x: 10, y: 20, dx: -1, dy: 1 },
      [
        ["mousemove", "10", "20"],
        ["click", "6"],
        ["click", "5"],
      ],
    ],
    [{ kind: "move", x: 99.6, y: 79.4 }, [["mousemove", "99", "79"]]],
    [{ kind: "move", x: 0.4, y: 0.5 }, [["mousemove", "0", "1"]]],
    [{ kind: "scroll", x: 10, y: 20, dx: 0, dy: 0 }, []],
    [{ kind: "screenshot" }, []],
    [{ kind: "wait", ms: 1 }, []],
  ] as [CuaAction, string[][]][])(
    "sends %j as exactly its native commands",
    async (action, expected) => {
      const f = recorded();
      await f.executor.execute(action);
      expect(f.inputs).toEqual(expected);
      expect(f.onTerminal).not.toHaveBeenCalled();
    },
  );

  it("sends 100 wheel steps and refuses 101 before any input", async () => {
    const f = recorded();
    await f.executor.execute({ kind: "scroll", x: 1, y: 1, dx: 0, dy: 12_000 });
    expect(f.inputs).toHaveLength(101);
    const over = recorded();
    await expect(
      over.executor.execute({ kind: "scroll", x: 1, y: 1, dx: 0, dy: 12_001 }),
    ).rejects.toMatchObject({ code: "action_rejected", disposition: "not_dispatched" });
    expect(over.inputs).toEqual([]);
  });

  it.each([
    [{ kind: "speak", text: "hello" }],
    [{ kind: "drag", path: [{ x: 1, y: 1 }] }],
    [{ kind: "not-an-action" }],
  ])("refuses %j before any input and keeps the session", async (action) => {
    const f = recorded();
    await expect(f.executor.execute(action as unknown as CuaAction)).rejects.toMatchObject({
      disposition: "not_dispatched",
    });
    expect(f.inputs).toEqual([]);
    expect(f.onTerminal).not.toHaveBeenCalled();
    await f.executor.execute({ kind: "move", x: 1, y: 1 });
    expect(f.inputs).toEqual([["mousemove", "1", "1"]]);
  });
});

describe("guest executor observations the split keeps", () => {
  it("maps a failed capture to execution_failed and ends the session", async () => {
    const f = fixture({
      capture: async () => {
        throw new Error("private capture failure");
      },
    });
    await expect(f.executor.observe()).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "not_dispatched",
    });
    expect(f.onTerminal).toHaveBeenCalledOnce();
  });

  it("revokes an observation whose authority ended during the capture", async () => {
    const f = fixture();
    f.tools.capture = async () => {
      f.authority.abort();
      return PNG.sync.write(new PNG({ width: 100, height: 80 }));
    };
    await expect(f.executor.observe()).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
    expect(f.onTerminal).toHaveBeenCalledOnce();
  });

  it("clears busy after each observation", async () => {
    const f = fixture();
    await f.executor.observe();
    await f.executor.observe();
    await f.executor.execute({ kind: "move", x: 1, y: 1 });
    expect(f.tools.input).toHaveBeenCalledOnce();
  });

  it("returns the frame's perceptual signature", async () => {
    const png = PNG.sync.write(new PNG({ width: 100, height: 80 }));
    const f = fixture({ capture: async () => png });
    const observation = await f.executor.observe();
    expect(observation.stateSignature).toBe(perceptualSignature(png));
  });
});

describe("guest executor text the split keeps", () => {
  it("sends nothing for empty text and prepares, pastes and closes in order for text", async () => {
    const calls: string[] = [];
    const f = fixture({
      prepareText: async (text) => {
        calls.push(`prepare ${text}`);
        return {
          paste: async () => void calls.push("paste"),
          close: async () => void calls.push("close"),
        };
      },
    });
    await f.executor.execute({ kind: "type", text: "" });
    expect(calls).toEqual([]);
    await f.executor.execute({ kind: "type", text: "hi" });
    expect(calls).toEqual(["prepare hi", "paste", "close"]);
    expect(f.tools.input).not.toHaveBeenCalled();
  });

  it("does not paste when the authority ends while the text is prepared", async () => {
    const paste = vi.fn(async () => {});
    const f = fixture();
    f.tools.prepareText = async () => {
      f.authority.abort();
      return { paste, close: async () => {} };
    };
    await expect(f.executor.execute({ kind: "type", text: "hi" })).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
    expect(paste).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a paste that proves nothing was sent",
      { paste: new ComputerUseExecutorError("execution_failed", "not_dispatched") },
      { code: "execution_failed", disposition: "not_dispatched" },
      true,
    ],
    [
      "a paste refused as action_rejected",
      { paste: new ComputerUseExecutorError("action_rejected", "not_dispatched") },
      { code: "action_rejected", disposition: "not_dispatched" },
      false,
    ],
    [
      "a paste that fails without proof",
      { paste: new Error("private paste failure") },
      { code: "execution_failed", disposition: "outcome_uncertain" },
      true,
    ],
    [
      "a preparation refused as action_rejected",
      { prepare: new ComputerUseExecutorError("action_rejected", "not_dispatched") },
      { code: "action_rejected", disposition: "not_dispatched" },
      false,
    ],
    [
      "a preparation that fails",
      { prepare: new Error("private preparation failure") },
      { code: "execution_failed", disposition: "not_dispatched" },
      true,
    ],
    [
      "a close failure after a paste",
      { close: new Error("private close failure") },
      { code: "execution_failed", disposition: "outcome_uncertain" },
      true,
    ],
    [
      "a paste and then its close that both fail",
      { paste: new Error("private paste failure"), close: new Error("private close failure") },
      { code: "execution_failed", disposition: "outcome_uncertain" },
      true,
    ],
    [
      "a close failure after a paste that proved nothing was sent",
      {
        paste: new ComputerUseExecutorError("action_rejected", "not_dispatched"),
        close: new Error("private close failure"),
      },
      { code: "execution_failed", disposition: "not_dispatched" },
      true,
    ],
  ] as [string, TextFailures, Record<string, string>, boolean][])(
    "types through %s",
    async (_name, failures, expected, terminates) => {
      const fail = (error: Error | undefined) => {
        if (error) throw error;
      };
      const f = fixture({
        prepareText: async () => {
          fail(failures.prepare);
          return {
            paste: async () => fail(failures.paste),
            close: async () => fail(failures.close),
          };
        },
      });
      await expect(f.executor.execute({ kind: "type", text: "hi" })).rejects.toMatchObject(
        expected,
      );
      expect(f.onTerminal).toHaveBeenCalledTimes(terminates ? 1 : 0);
      expect(f.tools.input).not.toHaveBeenCalled();
      if (!terminates) {
        await f.executor.execute({ kind: "move", x: 1, y: 1 });
        expect(f.tools.input).toHaveBeenCalledOnce();
      }
    },
  );
});

describe("guest executor sessions the split keeps", () => {
  it("revokes a wait whose authority ends and ends the session", async () => {
    const f = fixture();
    const waiting = f.executor.execute({ kind: "wait", ms: 30_000 });
    f.authority.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
    expect(f.onTerminal).toHaveBeenCalledOnce();
  });

  it("ends the session when the caller's signal aborts, and leaves the authority signal alone", async () => {
    const f = fixture();
    const cancel = new AbortController();
    const waiting = f.executor.execute({ kind: "wait", ms: 30_000 }, cancel.signal);
    cancel.abort();
    await expect(waiting).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
    expect(f.onTerminal).toHaveBeenCalledOnce();
    expect(f.authority.signal.aborted).toBe(false);
    await expect(f.executor.execute({ kind: "move", x: 1, y: 1 })).rejects.toMatchObject({
      code: "session_revoked",
    });
  });

  it("reads the signal again after onTerminal, which may abort it", async () => {
    // The owner's onTerminal can stop the desktop and abort the authority. The error a failure
    // throws is chosen after that call, so an undispatched failure then reads as revoked.
    const authority = new AbortController();
    const make = (tools: Partial<GuestDesktopTools>) =>
      createGuestDesktopExecutor({
        width: 100,
        height: 80,
        tools: { ...fixture().tools, ...tools },
        authoritySignal: authority.signal,
        onTerminal: () => authority.abort(),
      });
    const preparing = make({
      prepareText: async () => {
        throw new Error("private preparation failure");
      },
    });
    await expect(preparing.execute({ kind: "type", text: "hi" })).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
  });

  it("reads the signal on a failure only where the decision needs it", async () => {
    // A dispatched failure is outcome_uncertain without reading the signal, so a signal that
    // throws on read after the input changes nothing.
    const failure = new ComputerUseExecutorError("execution_failed", "not_dispatched");
    const dispatchedSignal = new AbortController().signal;
    let armed = false;
    Object.defineProperty(dispatchedSignal, "aborted", {
      configurable: true,
      get() {
        if (armed) throw new Error("aborted read");
        return false;
      },
    });
    let terminals = 0;
    const dispatched = createGuestDesktopExecutor({
      width: 100,
      height: 80,
      tools: {
        ...fixture().tools,
        input: async () => {
          armed = true;
          throw failure;
        },
      },
      authoritySignal: dispatchedSignal,
      onTerminal: () => void (terminals += 1),
    });
    await expect(dispatched.execute({ kind: "move", x: 1, y: 1 })).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    expect(terminals).toBe(1);

    // A preparation that fails ends the session before the signal is read; the error then reads
    // it once, so a signal that reports aborted only on its third read keeps the original error.
    const preparingSignal = new AbortController().signal;
    let reads = 0;
    Object.defineProperty(preparingSignal, "aborted", {
      configurable: true,
      get: () => ++reads >= 3,
    });
    const preparing = createGuestDesktopExecutor({
      width: 100,
      height: 80,
      tools: {
        ...fixture().tools,
        prepareText: async () => {
          throw failure;
        },
      },
      authoritySignal: preparingSignal,
      onTerminal: () => {},
    });
    await expect(preparing.execute({ kind: "type", text: "x" })).rejects.toBe(failure);
  });

  it("rejects calls on a busy or closed executor without throwing synchronously", async () => {
    // observe and execute report every refusal as a rejected promise; the call itself returns.
    const call = (start: () => Promise<unknown>): Promise<unknown> => {
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = start();
      }).not.toThrow();
      expect(pending).toBeInstanceOf(Promise);
      return pending!;
    };
    const f = fixture();
    const waiting = f.executor.execute({ kind: "wait", ms: 30_000 });
    await expect(
      call(() => f.executor.execute({ kind: "move", x: 1, y: 1 })),
    ).rejects.toMatchObject({ code: "executor_busy" });
    await expect(call(() => f.executor.observe())).rejects.toMatchObject({ code: "executor_busy" });
    f.authority.abort();
    await expect(waiting).rejects.toMatchObject({ code: "session_revoked" });
    await expect(
      call(() => f.executor.execute({ kind: "move", x: 1, y: 1 })),
    ).rejects.toMatchObject({ code: "session_revoked" });
    await expect(call(() => f.executor.observe())).rejects.toMatchObject({
      code: "session_revoked",
    });
    // A caller signal that is not an AbortSignal fails inside the call as a rejection too.
    const g = fixture();
    await expect(
      call(() => g.executor.execute({ kind: "move", x: 1, y: 1 }, {} as AbortSignal)),
    ).rejects.toBeInstanceOf(Error);
  });

  it("calls onTerminal once, and stays closed when onTerminal throws", async () => {
    const f = fixture({
      input: async () => {
        throw new Error("private input failure");
      },
    });
    await expect(f.executor.execute({ kind: "move", x: 1, y: 1 })).rejects.toBeDefined();
    await expect(f.executor.observe()).rejects.toBeDefined();
    expect(f.onTerminal).toHaveBeenCalledOnce();

    let calls = 0;
    const throwing = createGuestDesktopExecutor({
      width: 100,
      height: 80,
      tools: f.tools,
      authoritySignal: new AbortController().signal,
      onTerminal: () => {
        calls += 1;
        throw new Error("owner failed");
      },
    });
    await expect(throwing.execute({ kind: "move", x: 1, y: 1 })).rejects.toMatchObject({
      code: "execution_failed",
      disposition: "outcome_uncertain",
    });
    await expect(throwing.execute({ kind: "move", x: 1, y: 1 })).rejects.toMatchObject({
      code: "session_revoked",
      disposition: "not_dispatched",
    });
    expect(calls).toBe(1);
  });
});
