import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import type { ActorCapabilities, ActorPersonaRef } from "../../../src/actors/contract.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaLoopResult,
  type CuaProvider,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
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

/** Runs one waiting participant; the desktop records each call and answers at once. */
async function runWait(
  ms: number,
  options: {
    maxWaitMs?: number;
    execute?: (action: CuaAction, call: number) => Promise<void>;
  } = {},
): Promise<{ result: CuaLoopResult; calls: CuaAction[]; seen: CuaTurnRequest[] }> {
  const provider = waitingProvider(ms);
  const calls: CuaAction[] = [];
  let t = 0;
  const result = await runComputerUseLoop({
    instructions: "Wait in the lobby until the other person arrives.",
    provider,
    executor: {
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
  return { result, calls, seen: provider.seen };
}

const shortenedNotices = (result: CuaLoopResult) =>
  result.trace.items.filter((item) => item.kind === "notice" && item.title === "wait shortened");

describe("a participant's long wait", () => {
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
    const { calls, result } = await runWait(30_010, {
      execute: (_action, call) => (call === 2 ? new Promise<void>(() => {}) : Promise.resolve()),
    });

    expect(result.completionReason).toBe("goal_satisfied");
    expect(calls).toEqual([
      { kind: "wait", ms: 30_000 },
      { kind: "wait", ms: 10 },
    ]);
    expect(
      result.trace.items.some(
        (item) => item.kind === "notice" && item.title === "observation action stalled; skipped",
      ),
    ).toBe(true);
  });
});
