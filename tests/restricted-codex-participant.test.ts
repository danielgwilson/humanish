import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { createRestrictedCodexParticipant } from "../src/restricted-codex-participant.js";
import { PARTICIPANT_PROFILE, PARTICIPANT_TURN_SCHEMA, PARTICIPANT_CLOSING_SCHEMA, parseParticipantTurn, parseParticipantClosing } from "../src/restricted-codex-participant-policy.js";
import { createRestrictedCodexSession } from "../src/restricted-codex-session.js";
import type { RestrictedCodexRequest, RestrictedCodexResult } from "../src/restricted-codex-policy.js";
const { run, sessionClose } = vi.hoisted(() => ({
  run: vi.fn<(request: RestrictedCodexRequest) => Promise<RestrictedCodexResult>>(),
  sessionClose: vi.fn<() => Promise<boolean>>()
}));
vi.mock("../src/restricted-codex-session.js", () => ({ createRestrictedCodexSession: vi.fn(() => ({ run, close: sessionClose })) }));
const createSession = vi.mocked(createRestrictedCodexSession);
const frame = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const request = () => ({ instructions: "Use the synthetic page.", observation: { screenshot: frame, stateSignature: "synthetic",
  appState: { hidden: "DO_NOT_SEND" }, text: "DO_NOT_SEND", url: "DO_NOT_SEND" } });
const envelope = (changes = {}) => ({ schema: PARTICIPANT_PROFILE.participantSchema, narration: "I will click Save.", done: false,
  outcome: null, actions: [{ kind: "click", x: 1.5, y: 2.25 }], ...changes });
/** Humanish port/domain result, not a fabricated Codex wire notification. */
const result = (output: unknown = envelope()): RestrictedCodexResult => ({ status: "completed", output,
  usage: { input: 20, output: 5 }, usageComplete: true, dispatched: true, errorCode: null });
beforeEach(() => { run.mockReset(); sessionClose.mockReset().mockResolvedValue(true); createSession.mockClear(); });
afterEach(() => { vi.useRealTimers(); });
describe("restricted participant conversation", () => {
  it("strictly validates full proposals without rounding or silent filtering", () => {
    expect(parseParticipantTurn(envelope()).actions).toEqual([{ kind: "click", x: 1.5, y: 2.25 }]);
    for (const value of [envelope({ extra: true }), envelope({ actions: [] }), envelope({ outcome: "reached" }),
      envelope({ done: true }), envelope({ actions: [{ kind: "click", x: 1, y: 1 }, { kind: "shell", command: "invalid" }] }),
      envelope({ actions: Array(5).fill({ kind: "screenshot" }) }), envelope({ narration: "🙂".repeat(1000) }),
      envelope({ actions: [{ kind: "type", text: "x".repeat(65537) }] })]) expect(() => parseParticipantTurn(value)).toThrow();
    expect(parseParticipantTurn(envelope({ done: true, actions: [], outcome: "blocked" })).outcome).toBe("blocked");
    expect(() => parseParticipantClosing({ summary: "saved", frictionReports: [], actions: [] })).toThrow();
  });
  it("projects strict structured output with explicit nullable browser defaults", () => {
    function inspect(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(inspect); return; }
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      expect(object).not.toHaveProperty("$schema"); expect(object).not.toHaveProperty("oneOf");
      if (object.type === "object") {
        expect(object.additionalProperties).toBe(false);
        expect(object.required).toEqual(Object.keys(object.properties as object));
      }
      Object.values(object).forEach(inspect);
    }
    inspect(PARTICIPANT_TURN_SCHEMA);
    expect(parseParticipantTurn(envelope({ actions: [{ kind: "click", x: 1.5, y: 2.25, button: null }, { kind: "wait", ms: null }] })).actions)
      .toEqual([{ kind: "click", x: 1.5, y: 2.25 }, { kind: "wait" }]);
    expect(() => parseParticipantTurn(envelope({ actions: [{ kind: "type", text: null }] }))).toThrow();
  });
  it("keeps one session beyond eight turns without replaying or dropping its early context", async () => {
    run.mockResolvedValue(result()); const handle = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    for (let i = 0; i < 12; i++) await handle.provider.nextTurn({ ...request(), contextHint: i ? `Current step ${i}` : "EARLY_CONTEXT",
      ...(i ? { previousExecution: { actions: [{ index: 0, status: "completed" as const }] } } : {}) }, signal);
    expect(createSession).toHaveBeenCalledTimes(1); expect(sessionClose).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(12);
    expect(JSON.parse(run.mock.calls[0]![0].evidence).contextHint).toBe("EARLY_CONTEXT");
    const sent = run.mock.calls.at(-1)![0]; expect(sent.maxOutputTokens).toBeNull(); expect(sent.images).toHaveLength(1);
    expect(JSON.parse(sent.evidence)).toEqual({ phase: "interaction", instruction: expect.any(String), width: 2, height: 2,
      contextHint: "Current step 11", memoryPolicy: "continuing-thread-v1", previousExecution: { actions: [{ index: 0, status: "completed" }] } });
    expect(sent.evidence).not.toContain("EARLY_CONTEXT"); expect(sent.evidence).not.toContain("I will click Save");
    expect(JSON.stringify(sent)).not.toContain("DO_NOT_SEND"); expect(handle.provider.historyTurnsOmitted).toBe(0);
    expect(new Set(run.mock.calls.map(([r]) => r.instructions)).size).toBe(1);
    await handle.close(); expect(sessionClose).toHaveBeenCalledTimes(1);
    const second = createRestrictedCodexParticipant(); await second.provider.nextTurn(request(), signal);
    expect(createSession).toHaveBeenCalledTimes(2); expect(JSON.parse(run.mock.calls.at(-1)![0].evidence).previousExecution).toBeNull();
    await second.close();
  });
  it("retains the same persona and conversation for closing after an acknowledged final action", async () => {
    const closing = { summary: "I saved the note.", frictionReports: [] };
    run.mockResolvedValueOnce(result()).mockResolvedValueOnce(result(envelope({ done: true, actions: [], outcome: "reached" })))
      .mockResolvedValueOnce(result(closing));
    const h = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    await h.provider.nextTurn(request(), signal);
    const acknowledged = { ...request(), previousExecution: { actions: [{ index: 0, status: "completed" as const }] } };
    await h.provider.nextTurn(acknowledged, signal);
    expect((await h.provider.debrief!(acknowledged, signal)).closingReport).toEqual(closing);
    expect(createSession).toHaveBeenCalledTimes(1); expect(run).toHaveBeenCalledTimes(3);
    expect(new Set(run.mock.calls.map(([r]) => r.instructions)).size).toBe(1);
    expect(run.mock.calls[0]![0].schema).toBe(PARTICIPANT_TURN_SCHEMA);
    expect(run.mock.calls[2]![0].schema).toBe(PARTICIPANT_CLOSING_SCHEMA);
    expect(JSON.parse(run.mock.calls[2]![0].evidence)).toMatchObject({ phase: "closing", previousExecution: acknowledged.previousExecution });
    await h.close(); expect(sessionClose).toHaveBeenCalledTimes(1);
  });
  it("validates acknowledgment counts against the last proposed batch before dispatch", async () => {
    run.mockResolvedValueOnce(result(envelope({ actions: [{ kind: "click", x: 1, y: 1 }, { kind: "wait", ms: 1 }] })))
      .mockResolvedValue(result());
    const h = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    await expect(h.provider.nextTurn({ ...request(), previousExecution: { actions: [] } }, signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(run).not.toHaveBeenCalled();
    await h.provider.nextTurn(request(), signal);
    for (const actions of [[], [{ index: 0, status: "completed" as const }],
      [{ index: 0, status: "completed" as const }, { index: 0, status: "completed" as const }]]) {
      await expect(h.provider.nextTurn({ ...request(), previousExecution: { actions } }, signal)).rejects.toMatchObject({ code: "request_rejected" });
    }
    expect(run).toHaveBeenCalledTimes(1); expect(sessionClose).not.toHaveBeenCalled();
    await h.provider.nextTurn({ ...request(), previousExecution: { actions: [{ index: 0, status: "completed" }, { index: 1, status: "skipped" }] } }, signal);
    expect(JSON.parse(run.mock.calls[1]![0].evidence).previousExecution.actions).toHaveLength(2);
    await h.close();
  });
  it("refuses changed instructions, continuation, oversized current evidence before any model call", async () => {
    run.mockResolvedValue(result()); const h = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    await h.provider.nextTurn(request(), signal);
    for (const r of [{ ...request(), instructions: "different" }, { ...request(), previousResponseId: "not-supported" },
      { ...request(), contextHint: "x".repeat(8193) }, { ...request(), observation: { stateSignature: "no-frame" } }]) {
      await expect(h.provider.nextTurn(r, signal)).rejects.toMatchObject({ code: "request_rejected" });
    }
    expect(run).toHaveBeenCalledTimes(1); expect(sessionClose).not.toHaveBeenCalled();
    await h.provider.nextTurn(request(), signal); expect(createSession).toHaveBeenCalledTimes(1); await h.close();
  });
  it("retains failed usage and does not map malformed output to completion", async () => {
    run.mockResolvedValue(result({ unexpected: true })); const h = createRestrictedCodexParticipant();
    await expect(h.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({ code: "invalid_response",
      failurePhase: "response", receipt: { dispatched: true, cleanup: "confirmed" }, usage: { input: 20 } });
    await expect(h.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    await h.close(); expect(sessionClose).toHaveBeenCalledTimes(1); expect(createSession).toHaveBeenCalledTimes(1);
  });
  it("preserves cleanup failure phase through the early closed-participant branch", async () => {
    run.mockResolvedValue({ ...result(), status: "failed", errorCode: "codex_cleanup_failed", failurePhase: "cleanup" });
    const h = createRestrictedCodexParticipant();
    await expect(h.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({
      code: "cleanup_unconfirmed", failurePhase: "cleanup", receipt: { cleanup: "unconfirmed" }
    });
    expect(await h.close()).toEqual({ status: "unconfirmed" });
  });
  it("has one total cleanup grace and irreversibly refuses after an aborted attempt", async () => {
    vi.useFakeTimers(); let finish!: (v: RestrictedCodexResult) => void;
    run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const h = createRestrictedCodexParticipant(); const abort = new AbortController();
    const pending = h.provider.nextTurn(request(), abort.signal); void pending.catch(() => undefined);
    abort.abort(); await vi.advanceTimersByTimeAsync(4999);
    let done = false; const closed = h.close().then(v => { done = true; return v; });
    expect(done).toBe(false); await vi.advanceTimersByTimeAsync(1); expect(await closed).toEqual({ status: "unconfirmed" });
    finish(result()); await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    await expect(h.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    expect(await h.close()).toEqual({ status: "unconfirmed" }); expect(run).toHaveBeenCalledTimes(1);
  });
  it("starts session cleanup immediately on abort and waits for both pending turn and process cleanup", async () => {
    let finish!: (r: RestrictedCodexResult) => void; let cleanup!: (value: boolean) => void;
    run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    sessionClose.mockImplementation(() => new Promise(resolve => { cleanup = resolve; }));
    const h = createRestrictedCodexParticipant(); const abort = new AbortController();
    const turn = h.provider.nextTurn(request(), abort.signal); void turn.catch(() => undefined);
    abort.abort(); await Promise.resolve(); expect(run.mock.calls[0]![0].signal!.aborted).toBe(true);
    expect(sessionClose).toHaveBeenCalledTimes(1);
    const closing = h.close(); expect(h.close()).toBe(closing);
    let settled = false; void closing.then(() => { settled = true; });
    finish(result()); await expect(turn).rejects.toMatchObject({ code: "cancelled", usage: { input: 20, output: 5 } });
    expect(settled).toBe(false); cleanup(true); expect(await closing).toEqual({ status: "confirmed" });
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });
  it.each([false, "throws"])("does not claim cleanup confirmation when the session close returns %s", async mode => {
    if (mode === false) sessionClose.mockResolvedValue(false); else sessionClose.mockRejectedValue(new Error("synthetic"));
    const h = createRestrictedCodexParticipant(); const closing = h.close();
    expect(h.close()).toBe(closing); expect(await closing).toEqual({ status: "unconfirmed" });
    expect(run).not.toHaveBeenCalled(); expect(sessionClose).toHaveBeenCalledTimes(1);
    await expect(h.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
  });
  it("bounds a hung session close even when the turn has already settled", async () => {
    vi.useFakeTimers(); run.mockResolvedValue(result()); sessionClose.mockImplementation(() => new Promise(() => undefined));
    const h = createRestrictedCodexParticipant(); await h.provider.nextTurn(request(), new AbortController().signal);
    const closing = h.close(); await vi.advanceTimersByTimeAsync(5000);
    expect(await closing).toEqual({ status: "unconfirmed" }); expect(sessionClose).toHaveBeenCalledTimes(1);
  });
  it("retains incomplete per-turn accounting without resetting it on later successful turns", async () => {
    run.mockResolvedValueOnce({ ...result(), usage: null, usageComplete: false }).mockResolvedValue(result());
    const h = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    const first = await h.provider.nextTurn(request(), signal); expect(first.providerRequest?.usageComplete).toBe(false);
    const next = await h.provider.nextTurn(request(), signal); expect(next.providerRequest?.usageComplete).toBe(true);
    expect(next.usage).toEqual({ input: 20, output: 5 }); expect(h.provider.interactionUsageIncomplete).toBe(true);
    expect(createSession).toHaveBeenCalledTimes(1); await h.close();
  });
  it("accepts multiple successfully settled turns but never a second concurrent request", async () => {
    let finish!: (v: RestrictedCodexResult) => void; run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const h = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    const first = h.provider.nextTurn(request(), signal);
    await expect(h.provider.nextTurn(request(), signal)).rejects.toMatchObject({ code: "busy", receipt: { dispatched: false } });
    finish(result()); await first; run.mockResolvedValue(result()); await h.provider.nextTurn(request(), signal); expect(run).toHaveBeenCalledTimes(2); await h.close();
  });
});
