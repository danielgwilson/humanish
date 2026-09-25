import { afterEach, describe, expect, it, vi } from "vitest";
import { runComputerUseLoop, type CuaProvider, type CuaTurn, type CuaTurnRequest } from "../src/computer-use.js";
import { buildCuaCostSummary } from "../src/cua-actor-lab.js";
import type { ActorTokenUsage } from "../src/actor-contract.js";
import { CuaProviderError } from "../src/cua-provider-error.js";
import { defaultRedactionHooks } from "../src/redaction.js";
import { PARTICIPANT_PROFILE } from "../src/restricted-codex-participant-policy.js";

const receipt = { dispatched: true, usageComplete: true, cleanup: "confirmed" } as const;
const turn = (patch: Partial<CuaTurn> = {}): CuaTurn => ({ actions: [], pendingSafetyChecks: [], done: true,
  message: "Finished the synthetic task.", outcome: "reached", usage: { input: 10, output: 2 }, providerRequest: receipt, ...patch });
function setup(nextTurn: CuaProvider["nextTurn"]) {
  let state = 0;
  const execute = vi.fn(async () => { state++; });
  const observe = vi.fn(async () => ({ stateSignature: String(state), text: state ? "saved" : "ready" }));
  const provider: CuaProvider = { id: "synthetic-account", version: "gpt-6-astra", executionProfile: PARTICIPANT_PROFILE,
    requestPolicy: "fail_closed", capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"],
      producesScreenshots: false, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "open" }, nextTurn };
  const options = { instructions: "Save a synthetic note.", provider, executor: { execute, observe },
    redaction: defaultRedactionHooks, persona: { id: "synthetic", traitsApplied: [], promptDigest: "synthetic" },
    timeoutMs: 20_000, turnTimeoutMs: 100, now: () => Date.now() };
  return { options, provider, execute, observe, run: () => runComputerUseLoop(options) };
}
afterEach(() => vi.useRealTimers());
describe("single-dispatch participant request lifetime", () => {
  it("preserves a setup timeout phase in the recording and human-readable outcome", async () => {
    const s = setup(async () => { throw new CuaProviderError("timeout",
      { dispatched: false, usageComplete: false, cleanup: "confirmed" }, undefined, "thread/start"); });
    const r = await s.run();
    expect(r.completionReason).toBe("harness_error");
    expect(r.trace.providerRequests?.[0]).toMatchObject({ errorCode: "timeout", failurePhase: "thread/start",
      dispatched: false, profileVerified: false, cleanup: "confirmed" });
    expect(r.reason).toContain("timeout during thread/start");
    expect(s.execute).not.toHaveBeenCalled();
  });
  it("records complete account tokens once without inventing dollar cost", async () => {
    const s = setup(async () => turn()); const r = await s.run();
    expect(r.completionReason).toBe("goal_satisfied");
    expect(r.trace.providerRequests).toEqual([{ ...receipt, ordinal: 1, kind: "interaction", profileVerified: true, usage: { input: 10, output: 2 } }]);
    expect(r.trace.tokenUsage?.input).toBe(10); expect(r.trace.tokenUsage?.turns).toHaveLength(1);
    expect(r.trace.tokenUsage?.costUsd).toBeUndefined(); expect(s.execute).not.toHaveBeenCalled();
  });
  it("aborts an earlier outer timeout, settles the original request and discards late actions", async () => {
    vi.useFakeTimers(); let aborted = false;
    const next = vi.fn((_req, signal: AbortSignal) => new Promise<CuaTurn>(resolve => {
      signal.addEventListener("abort", () => { aborted = true; setTimeout(() => resolve(turn({ actions: [{ kind: "click", x: 1.25, y: 2.5 }], done: false })), 20); });
    }));
    const s = setup(next); const result = s.run(); await vi.advanceTimersByTimeAsync(121); const r = await result;
    expect(aborted).toBe(true); expect(next).toHaveBeenCalledTimes(1); expect(s.observe).toHaveBeenCalledTimes(1);
    expect(s.execute).not.toHaveBeenCalled(); expect(r.completionReason).toBe("harness_error");
    expect(r.trace.tokenUsage?.input).toBe(10); expect(r.trace.providerRequests).toHaveLength(1);
    expect(r.trace.items.some(i => i.kind === "message" || i.kind === "ui_action")).toBe(false);
  });
  it("finishes at the five-second grace with unknown dispatch; late settlement cannot mutate its trace", async () => {
    vi.useFakeTimers(); let finish!: (t: CuaTurn) => void;
    const next = vi.fn(() => new Promise<CuaTurn>(resolve => { finish = resolve; }));
    const s = setup(next); let settled = false; const result = s.run().then(r => { settled = true; return r; });
    await vi.advanceTimersByTimeAsync(5099); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const r = await result; const frozen = JSON.stringify(r);
    expect(r.trace.providerRequests?.[0]).toMatchObject({ dispatched: "unknown", cleanup: "unconfirmed", usageComplete: false });
    finish(turn({ actions: [{ kind: "click", x: 10, y: 10 }] })); await vi.advanceTimersByTimeAsync(10);
    expect(JSON.stringify(r)).toBe(frozen); expect(s.execute).not.toHaveBeenCalled(); expect(next).toHaveBeenCalledTimes(1);
  });
  it("retains cancellation classification and partial failed-request tokens", async () => {
    vi.useFakeTimers(); const abort = new AbortController();
    const s = setup((_r, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(
      new CuaProviderError("cancelled", { ...receipt, usageComplete: false }, { input: 7 })) )));
    const snapshots: ActorTokenUsage[] = [];
    const result = runComputerUseLoop({ ...s.options, signal: abort.signal, onTrace: (_items, usage) => snapshots.push(usage) }); await vi.advanceTimersByTimeAsync(1); abort.abort();
    const r = await result; expect(r.completionReason).toBe("harness_error"); expect(r.trace.stopCause).toBe("harness_aborted");
    expect(r.trace.interactionUsageIncomplete).toBe(true); expect(r.trace.tokenUsage?.input).toBe(7);
    expect(r.trace.tokenUsage?.turns).toEqual([{ input: 7 }]); expect(r.trace.tokenUsage).not.toHaveProperty("output");
    expect(r.trace.tokenUsage).not.toHaveProperty("total"); expect(s.execute).not.toHaveBeenCalled();
    expect(snapshots.at(-1)).not.toHaveProperty("output"); expect(snapshots.at(-1)).not.toHaveProperty("total");
    const summary = buildCuaCostSummary({ lanes: [{ laneId: "synthetic", trace: r.trace }] });
    expect(summary?.tokenUsage).toEqual({ input: 7 }); expect(summary?.fullyEstimated).toBe(false);
  });
  it("rejects dollar caps before observing or requesting", async () => {
    const next = vi.fn(async () => turn()); const s = setup(next);
    await expect(runComputerUseLoop({ ...s.options, maxUsd: 0 })).rejects.toMatchObject({ code: "request_rejected" });
    expect(next).not.toHaveBeenCalled(); expect(s.observe).not.toHaveBeenCalled();
  });
  it("delivers actual input acknowledgments, preserving fractional coordinates", async () => {
    const seen: CuaTurnRequest[] = [];
    const s = setup(async req => { seen.push(req); return seen.length === 1
      ? turn({ actions: [{ kind: "click", x: 1.25, y: 3.75 }], done: false }) : turn(); });
    await s.run(); expect(s.execute).toHaveBeenCalledWith({ kind: "click", x: 1.25, y: 3.75 }, expect.any(AbortSignal));
    expect(seen[1]?.previousExecution).toEqual({ actions: [{ index: 0, status: "completed" }] });
  });
  it("keeps complete failed closing usage distinct from an invalid closing report", async () => {
    const s = setup(async () => turn({ done: false, actions: [{ kind: "click", x: 1, y: 1 }] }));
    s.provider.debrief = async () => { throw new CuaProviderError("invalid_response", receipt, { input: 4, output: 2 }); };
    const r = await runComputerUseLoop({ ...s.options, stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] } });
    expect(r.completionReason).toBe("goal_satisfied"); expect(r.trace.debrief).toMatchObject({ status: "failed", usageReported: true });
    expect(r.trace.tokenUsage?.input).toBe(14); expect(r.trace.tokenUsage?.output).toBe(4);
    expect(r.trace.providerRequests?.[1]).toMatchObject({ kind: "debrief", usageComplete: true, cleanup: "confirmed", errorCode: "invalid_response" });
  });
  it("closing cleanup failure preserves corroborated outcome but records unknown cleanup and known tokens", async () => {
    const s = setup(async () => turn({ done: false, actions: [{ kind: "click", x: 1, y: 1 }] }));
    s.provider.debrief = async () => { throw new CuaProviderError("cleanup_unconfirmed", { ...receipt, cleanup: "unconfirmed", usageComplete: false }, { input: 4 }); };
    const r = await runComputerUseLoop({ ...s.options, stopWhen: { any: [{ id: "saved", textIncludes: "saved" }] } });
    expect(r.completionReason).toBe("goal_satisfied"); expect(r.trace.debrief?.status).toBe("failed");
    expect(r.trace.providerRequests?.[1]).toMatchObject({ kind: "debrief", cleanup: "unconfirmed" });
    expect(r.trace.tokenUsage?.input).toBe(14); expect(s.execute).toHaveBeenCalledTimes(1);
  });
});
