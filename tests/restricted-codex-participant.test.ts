import { afterEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { createRestrictedCodexParticipant } from "../src/restricted-codex-participant.js";
import { PARTICIPANT_PROFILE, PARTICIPANT_LIMITS, PARTICIPANT_TURN_SCHEMA, parseParticipantTurn, parseParticipantClosing } from "../src/restricted-codex-participant-policy.js";
import { runRestrictedCodexSession } from "../src/restricted-codex-session.js";
import type { RestrictedCodexResult } from "../src/restricted-codex-policy.js";
vi.mock("../src/restricted-codex-session.js", () => ({ runRestrictedCodexSession: vi.fn() }));
const run = vi.mocked(runRestrictedCodexSession);
const frame = PNG.sync.write(new PNG({ width: 2, height: 2 }));
const request = () => ({ instructions: "Use the synthetic page.", observation: { screenshot: frame, stateSignature: "synthetic",
  appState: { hidden: "DO_NOT_SEND" }, text: "DO_NOT_SEND", url: "DO_NOT_SEND" } });
const envelope = (changes = {}) => ({ schema: PARTICIPANT_PROFILE.participantSchema, narration: "I will click Save.", done: false,
  outcome: null, actions: [{ kind: "click", x: 1.5, y: 2.25 }], ...changes });
/** Humanish port/domain result, not a fabricated Codex wire notification. */
const result = (output: unknown = envelope()): RestrictedCodexResult => ({ status: "completed", output,
  usage: { input: 20, output: 5 }, usageComplete: true, dispatched: true, errorCode: null });
afterEach(() => { run.mockReset(); vi.useRealTimers(); });
describe("restricted participant output and explicit memory", () => {
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
  it("sends only current frame and bounded explicit acknowledged history", async () => {
    run.mockResolvedValue(result()); const handle = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    for (let i = 0; i < 11; i++) await handle.provider.nextTurn({ ...request(), ...(i ? { previousExecution: { actions: [{ index: 0, status: "completed" as const }] } } : {}) }, signal);
    const sent = run.mock.calls.at(-1)![0]; expect(sent.maxOutputTokens).toBeNull(); expect(sent.images).toHaveLength(1);
    const evidence = JSON.parse(sent.evidence); expect(evidence.history).toHaveLength(8); expect(evidence.omittedTurns).toBe(2);
    expect(Buffer.byteLength(JSON.stringify(evidence.history))).toBeLessThanOrEqual(PARTICIPANT_LIMITS.history);
    expect(evidence.history.at(-1).execution.actions[0].status).toBe("completed");
    expect(JSON.stringify(sent)).not.toContain("DO_NOT_SEND"); expect(handle.provider.historyTurnsOmitted).toBe(3);
    await handle.close(); const second = createRestrictedCodexParticipant(); await second.provider.nextTurn(request(), signal);
    expect(JSON.parse(run.mock.calls.at(-1)![0].evidence).history).toEqual([]); await second.close();
  });
  it("refuses changed instructions, continuation, oversized current evidence before any model call", async () => {
    run.mockResolvedValue(result()); const h = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    await h.provider.nextTurn(request(), signal);
    for (const r of [{ ...request(), instructions: "different" }, { ...request(), previousResponseId: "not-supported" },
      { ...request(), contextHint: "x".repeat(8193) }, { ...request(), observation: { stateSignature: "no-frame" } }]) {
      await expect(h.provider.nextTurn(r, signal)).rejects.toMatchObject({ code: "request_rejected" });
    }
    expect(run).toHaveBeenCalledTimes(1); await h.close();
  });
  it("retains failed usage and does not map malformed output to completion", async () => {
    run.mockResolvedValue(result({ unexpected: true })); const h = createRestrictedCodexParticipant();
    await expect(h.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({ code: "invalid_response",
      failurePhase: "response", receipt: { dispatched: true, cleanup: "confirmed" }, usage: { input: 20 } }); await h.close();
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
  it("accepts multiple successfully settled turns but never a second concurrent request", async () => {
    let finish!: (v: RestrictedCodexResult) => void; run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const h = createRestrictedCodexParticipant(); const signal = new AbortController().signal;
    const first = h.provider.nextTurn(request(), signal);
    await expect(h.provider.nextTurn(request(), signal)).rejects.toMatchObject({ code: "busy", receipt: { dispatched: false } });
    finish(result()); await first; run.mockResolvedValue(result()); await h.provider.nextTurn(request(), signal); expect(run).toHaveBeenCalledTimes(2); await h.close();
  });
});
