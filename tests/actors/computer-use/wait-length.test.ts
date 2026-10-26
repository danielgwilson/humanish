import { PNG } from "pngjs";
import { describe, expect, it, vi } from "vitest";

import type { ActorCapabilities, ActorPersonaRef } from "../../../src/actors/contract.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaExecutor,
  type CuaLoopOptions,
  type CuaLoopResult,
  type CuaProvider,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { createGuestDesktopExecutor } from "../../../src/guest/desktop-executor.js";
import {
  createE2BDesktopExecutor,
  type E2BDesktopLike,
} from "../../../src/substrates/e2b/desktop-executor.js";

// How long a wait that names no duration lasts, through the loop and each desktop's executor.
// OpenAI's computer-use `wait` action carries no duration, so the harness picks one. A turn with
// another action sends its waits to the desktop; a turn that only waits is watched by the loop,
// which sleeps through the injected `sleep` and looks at the screen, sending no wait.

const CAPS: ActorCapabilities = {
  headless: true,
  structuredTrace: true,
  lanes: ["computer-use"],
  producesScreenshots: true,
  byoModel: true,
  preGrantableApprovals: false,
  inProcessTools: false,
  license: "open",
};
const persona: ActorPersonaRef = { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" };

function frame(width = 100, height = 80): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

/** A participant that sends one batch of actions, then finishes. */
function participant(actions: CuaAction[]): CuaProvider {
  let turns = 0;
  return {
    id: "waiting-participant",
    version: "w",
    capabilities: CAPS,
    async nextTurn() {
      turns += 1;
      return turns === 1
        ? { actions, pendingSafetyChecks: [], done: false }
        : { actions: [], pendingSafetyChecks: [], done: true, message: "done" };
    },
  };
}

type WaitOptions = Pick<CuaLoopOptions, "maxWaitMs" | "idleWaitMs">;

/** The loop's clock moves only when it sleeps; `slept` lists each sleep. */
let slept: number[] = [];

function runLoop(
  executor: CuaExecutor,
  actions: CuaAction[],
  options: WaitOptions = {},
): Promise<CuaLoopResult> {
  let t = 0;
  slept = [];
  return runComputerUseLoop({
    instructions: "Wait on this page until it changes.",
    provider: participant(actions),
    executor,
    persona,
    redaction: defaultRedactionHooks,
    timeoutMs: 600_000,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    ...options,
  });
}

/** An E2B desktop that records each SDK call and answers at once. */
function hostedDesktop(): { desktop: E2BDesktopLike; calls: [string, ...unknown[]][] } {
  const calls: [string, ...unknown[]][] = [];
  const record =
    (method: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push([method, ...args]);
    };
  return {
    calls,
    desktop: {
      screenshot: async () => frame(),
      commands: {
        run: async (command: string) => {
          calls.push(["run", command]);
          return { exitCode: 0, stdout: "" };
        },
      },
      files: { write: async () => undefined },
      wait: record("wait"),
    },
  };
}

async function hostedWaits(actions: CuaAction[], options: WaitOptions = {}) {
  const { desktop, calls } = hostedDesktop();
  const result = await runLoop(createE2BDesktopExecutor(desktop), actions, options);
  return { result, calls, waits: calls.filter(([method]) => method === "wait") };
}

/**
 * The guest desktop's executor with its native tools faked, timing each action it runs. The
 * recorder passes every call through to the real executor.
 */
function guestDesktop() {
  const tools = {
    capture: vi.fn(async () => frame()),
    input: vi.fn(async () => {}),
    prepareText: vi.fn(async () => ({ paste: async () => {}, close: async () => {} })),
  };
  const guest = createGuestDesktopExecutor({
    width: 100,
    height: 80,
    tools,
    authoritySignal: new AbortController().signal,
    onTerminal: () => {},
  });
  const ran: { action: CuaAction; elapsedMs: number }[] = [];
  const executor: CuaExecutor = {
    ...guest,
    observe: () => guest.observe(),
    async execute(action, signal) {
      const started = performance.now();
      await guest.execute(action, signal);
      ran.push({ action, elapsedMs: performance.now() - started });
    },
  };
  return { executor, ran, tools };
}

const shortened = (result: CuaLoopResult) =>
  result.trace.items.filter((item) => item.kind === "notice" && item.title === "wait shortened");

const waitTitles = (result: CuaLoopResult) =>
  result.trace.items
    .filter((item) => item.kind === "ui_action" && item.title.startsWith("wait"))
    .map((item) => item.title);

describe("a wait with no duration on a hosted desktop", () => {
  it("lasts five seconds when the participant's turn only waits, and no wait goes to the desktop", async () => {
    const { waits, result } = await hostedWaits([{ kind: "wait" }]);

    expect(waits).toEqual([]);
    expect(slept).toEqual([5_000]);
    expect(waitTitles(result)).toEqual(["wait 5000ms"]);
    expect(result.completionReason).toBe("goal_satisfied");
  });

  it("lasts half a second after the participant acts in the same turn", async () => {
    const { calls } = await hostedWaits([{ kind: "click", x: 10, y: 10 }, { kind: "wait" }]);

    expect(calls).toEqual([
      ["run", "xdotool getmouselocation"],
      ["run", "xdotool mousemove --sync 10 10"],
      ["run", "xdotool click 1"],
      ["wait", 500],
    ]);
  });

  it("lasts the study's actor.idleWaitMs when the participant's turn only waits", async () => {
    const { waits, result } = await hostedWaits([{ kind: "wait" }], { idleWaitMs: 45_000 });

    expect(waits).toEqual([]);
    expect(slept).toEqual([45_000]);
    expect(shortened(result)).toEqual([]);
  });

  it("is never longer than the study's longest wait, and the participant is not told it was shortened", async () => {
    const { waits, result } = await hostedWaits([{ kind: "wait" }], { maxWaitMs: 4_000 });

    expect(waits).toEqual([]);
    expect(slept).toEqual([4_000]);
    expect(shortened(result)).toEqual([]);
  });

  it("keeps a wait that names its duration", async () => {
    // The watch looks at 5 s, every idleWaitMs, and again at its limit.
    const { result } = await hostedWaits([{ kind: "wait", ms: 7_500 }]);

    expect(slept).toEqual([5_000, 2_500]);
    expect(waitTitles(result)).toEqual(["wait 7500ms"]);
  });

  it("keeps a wait that names its duration after an action, sent to the desktop", async () => {
    const { waits } = await hostedWaits([
      { kind: "click", x: 10, y: 10 },
      { kind: "wait", ms: 2_500 },
    ]);

    expect(waits).toEqual([["wait", 2_500]]);
    expect(slept).toEqual([]);
  });

  it("is labelled in the trace with the length it lasted", async () => {
    const { result } = await hostedWaits([{ kind: "click", x: 10, y: 10 }, { kind: "wait" }]);

    expect(
      result.trace.items.filter((item) => item.kind === "ui_action").map((item) => item.title),
    ).toEqual(["click (10, 10)", "wait 500ms"]);
  });

  it("records the wait settings the session applied in the trace", async () => {
    const defaults = await hostedWaits([{ kind: "wait" }]);
    const studySet = await hostedWaits([{ kind: "wait" }], {
      maxWaitMs: 90_000,
      idleWaitMs: 20_000,
    });

    expect(defaults.result.trace.waitSettings).toEqual({
      maxWaitMs: 120_000,
      idleWaitMs: 5_000,
      settleWaitMs: 500,
    });
    expect(studySet.result.trace.waitSettings).toEqual({
      maxWaitMs: 90_000,
      idleWaitMs: 20_000,
      settleWaitMs: 500,
    });
  });

  it.each([Number.NaN, -1, 0, 999, 1.5, 600_001])(
    "refuses an idle wait of %s before the session starts",
    async (idleWaitMs) => {
      const { desktop, calls } = hostedDesktop();
      await expect(
        runLoop(createE2BDesktopExecutor(desktop), [{ kind: "wait" }], { idleWaitMs }),
      ).rejects.toThrow(RangeError);
      expect(calls).toEqual([]);
    },
  );

  it("refuses an idle wait longer than the longest wait the caller set", async () => {
    const { desktop } = hostedDesktop();
    await expect(
      runLoop(createE2BDesktopExecutor(desktop), [{ kind: "wait" }], {
        idleWaitMs: 20_000,
        maxWaitMs: 10_000,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("a wait with no duration on a guest desktop", () => {
  it("looks at the desktop at the study's idle wait when the participant's turn only waits", async () => {
    const { executor, ran, tools } = guestDesktop();

    const result = await runLoop(executor, [{ kind: "wait" }], { idleWaitMs: 1_000 });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(ran).toEqual([]);
    expect(slept).toEqual([1_000]);
    // The opening observation and the look that ended the watch; no observation after it.
    expect(tools.capture).toHaveBeenCalledTimes(2);
  });

  it("lasts half a second after the participant acts in the same turn", async () => {
    const { executor, ran, tools } = guestDesktop();

    await runLoop(executor, [{ kind: "click", x: 10, y: 10 }, { kind: "wait" }]);

    expect(tools.input).toHaveBeenCalled();
    expect(ran.map((entry) => entry.action)).toEqual([
      { kind: "click", x: 10, y: 10 },
      { kind: "wait", ms: 500 },
    ]);
    expect(ran[1]?.elapsedMs).toBeGreaterThanOrEqual(490);
  });
});
