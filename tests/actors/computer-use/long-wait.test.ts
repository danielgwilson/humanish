import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorCapabilities, ActorPersonaRef } from "../../../src/actors/contract.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaLoopResult,
  type CuaProvider,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { CUA_WAIT_LIMITS } from "../../../src/actors/computer-use/wait.js";
import { BROWSER_CONTROL_LIMITS } from "../../../src/browser-control/protocol.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

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

function frame(): Buffer {
  return PNG.sync.write(new PNG({ width: 2, height: 2 }));
}

/** A participant that asks for one wait, then finishes. */
function waitingProvider(ms: number): CuaProvider & { readonly seen: CuaTurnRequest[] } {
  const seen: CuaTurnRequest[] = [];
  return {
    id: "waiting-participant",
    version: "w",
    capabilities: CAPS,
    seen,
    async nextTurn(req) {
      seen.push(req);
      return seen.length === 1
        ? { actions: [{ kind: "wait", ms }], pendingSafetyChecks: [], done: false }
        : { actions: [], pendingSafetyChecks: [], done: true, message: "done" };
    },
  };
}

/**
 * Runs one waiting participant; the desktop records each call and answers at once. `calls` fills
 * while the loop runs.
 */
function startWait(
  ms: number,
  options: {
    maxWaitMs?: number;
    speechEnabled?: boolean;
    execute?: (action: CuaAction, call: number) => Promise<void>;
  } = {},
): { done: Promise<CuaLoopResult>; calls: CuaAction[]; seen: CuaTurnRequest[] } {
  const provider = waitingProvider(ms);
  const calls: CuaAction[] = [];
  let t = 0;
  const done = runComputerUseLoop({
    instructions: "Wait in the lobby until the other person arrives.",
    provider,
    executor: {
      ...(options.speechEnabled === true ? { speechEnabled: true } : {}),
      observe: async () => ({ screenshot: frame(), stateSignature: `s${calls.length}` }),
      execute: async (action) => {
        calls.push(action);
        await options.execute?.(action, calls.length);
      },
    },
    persona,
    redaction: defaultRedactionHooks,
    timeoutMs: 10_000_000,
    observationTimeoutMs: 30,
    now: () => (t += 1),
    ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
  });
  return { done, calls, seen: provider.seen };
}

async function runWait(
  ms: number,
  options: Parameters<typeof startWait>[1] = {},
): Promise<{ result: CuaLoopResult; calls: CuaAction[]; seen: CuaTurnRequest[] }> {
  const { done, calls, seen } = startWait(ms, options);
  return { result: await done, calls, seen };
}

const shortenedNotices = (result: CuaLoopResult) =>
  result.trace.items.filter((item) => item.kind === "notice" && item.title === "wait shortened");

afterEach(() => vi.useRealTimers());

describe("a participant's long wait", () => {
  it("sends steps no longer than one desktop call accepts", () => {
    expect(CUA_WAIT_LIMITS.stepMs).toBe(BROWSER_CONTROL_LIMITS.waitMs);
  });

  it("runs as consecutive desktop calls no longer than one browser-control request carries", async () => {
    const { result, calls, seen } = await runWait(70_000);

    expect(result.completionReason).toBe("goal_satisfied");
    expect(calls).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 10_000 },
    ]);
    expect(BROWSER_CONTROL_LIMITS.waitMs).toBe(30_000);
    // One action to the participant: recorded once and never shortened.
    expect(seen[1]?.contextHint ?? "").not.toContain("shortened");
    expect(
      result.trace.items.filter((item) => item.kind === "ui_action").map((item) => item.title),
    ).toEqual(["wait 70000ms"]);
    expect(shortenedNotices(result)).toEqual([]);
  });

  it("is shortened to the study's longest wait, recorded, and the participant is told", async () => {
    const { result, calls, seen } = await runWait(100_000, { maxWaitMs: 45_000 });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(calls).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 15_000 },
    ]);
    const notices = shortenedNotices(result);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ status: "warn" });
    expect(notices[0]?.text).toContain("requested: 100000ms");
    expect(notices[0]?.text).toContain("waited: 45000ms");
    expect(seen[1]?.contextHint).toContain("shortened to 45000ms");
  });

  it("is shortened to two minutes when the study sets no longest wait", async () => {
    const { calls, result } = await runWait(300_000);

    expect(calls).toHaveLength(4);
    expect(calls.reduce((sum, call) => sum + (call.kind === "wait" ? (call.ms ?? 0) : 0), 0)).toBe(
      120_000,
    );
    expect(shortenedNotices(result)[0]?.text).toContain("waited: 120000ms");
  });

  it("keeps a wait of exactly the study's longest", async () => {
    const { calls, result } = await runWait(45_000, { maxWaitMs: 45_000 });

    expect(calls).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 15_000 },
    ]);
    expect(shortenedNotices(result)).toEqual([]);
  });

  it("skips the rest of a wait whose step stalls, and the session continues", async () => {
    vi.useFakeTimers();
    // A 70 s wait is three steps; the first never answers.
    const { done, calls } = startWait(70_000, {
      execute: (_action, call) => (call === 1 ? new Promise<void>(() => {}) : Promise.resolve()),
    });
    // The step's bound is observationTimeoutMs (30) plus its own 30 s.
    await vi.advanceTimersByTimeAsync(30_030 + 1);
    const result = await done;

    expect(calls).toEqual([{ kind: "wait", ms: 30_000 }]);
    expect(
      result.trace.items.some(
        (item) => item.kind === "notice" && item.title === "observation action stalled; skipped",
      ),
    ).toBe(true);
    expect(result.completionReason).toBe("goal_satisfied");
  });

  it("is one desktop call by default on a desktop with speech, which hears nothing during a wait", async () => {
    const { calls, result, seen } = await runWait(120_000, { speechEnabled: true });

    expect(calls).toEqual([{ kind: "wait", ms: 30_000 }]);
    const notices = shortenedNotices(result);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("requested: 120000ms");
    expect(notices[0]?.text).toContain("waited: 30000ms");
    expect(seen[1]?.contextHint).toContain("shortened to 30000ms");
  });

  it("keeps the study's longest wait on a desktop with speech", async () => {
    const { calls, result } = await runWait(90_000, { speechEnabled: true, maxWaitMs: 90_000 });

    expect(calls).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 30_000 },
    ]);
    expect(shortenedNotices(result)).toEqual([]);
  });

  it.each([Number.NaN, -1, 0, 999, 1.5, 600_001, Infinity])(
    "refuses a longest wait of %s before the session starts",
    async (maxWaitMs) => {
      const { done, calls, seen } = startWait(1_000, { maxWaitMs });

      await expect(done).rejects.toThrow(RangeError);
      expect(seen).toEqual([]);
      expect(calls).toEqual([]);
    },
  );
});
