import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { createRestrictedCodexParticipant } from "../src/restricted-codex-participant.js";
import {
  PARTICIPANT_FINAL_SCHEMA,
  PARTICIPANT_TOOL_SCHEMA,
  parseParticipantFinal,
  parseParticipantTool
} from "../src/restricted-codex-participant-policy.js";
import { createRestrictedCodexSession } from "../src/restricted-codex-session.js";
import type { RestrictedCodexRequest, RestrictedCodexResult } from "../src/restricted-codex-policy.js";

const { run, sessionClose } = vi.hoisted(() => ({
  run: vi.fn<(request: RestrictedCodexRequest) => Promise<RestrictedCodexResult>>(),
  sessionClose: vi.fn<() => Promise<boolean>>()
}));
vi.mock("../src/restricted-codex-session.js", () => ({
  createRestrictedCodexSession: vi.fn(() => ({ run, close: sessionClose }))
}));
const createSession = vi.mocked(createRestrictedCodexSession);

function frame(red = 0): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data[0] = red;
  image.data[3] = 255;
  return PNG.sync.write(image);
}
const request = (screenshot = frame()) => ({ instructions: "Use the synthetic page as a cautious newcomer.",
  observation: { screenshot, stateSignature: "synthetic", appState: { hidden: "DO_NOT_SEND" }, text: "DO_NOT_SEND", url: "DO_NOT_SEND" } });
const finalOutput = (changes: Record<string, unknown> = {}) => ({ outcome: "reached", summary: "I saved the note.",
  frictionReports: ["The first click was skipped, so I retried."], ...changes });
const result = (output: unknown = finalOutput(), changes: Partial<RestrictedCodexResult> = {}): RestrictedCodexResult => ({
  status: "completed", output, usage: { input: 20, output: 5 }, usageComplete: true, dispatched: true, errorCode: null, ...changes
});

type NativeTool = (args: unknown) => Promise<string>;
function nativeTool(): NativeTool {
  const options = createSession.mock.calls.at(-1)?.[0] as unknown as { participant?: { tool?: { call?: NativeTool } } };
  if (!options?.participant?.tool?.call) throw new Error("participant tool was not configured");
  return options.participant.tool.call;
}

beforeEach(() => {
  run.mockReset();
  sessionClose.mockReset().mockResolvedValue(true);
  createSession.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe("restricted participant conversation", () => {
  it("strictly validates native tool batches and final accounts without rounding or filtering", () => {
    expect(parseParticipantTool({ narration: "I will click Save.", actions: [{ kind: "click", x: 1.5, y: 2.25 }] })).toMatchObject({
      actions: [{ kind: "click", x: 1.5, y: 2.25 }], done: false, providerRequestPending: true
    });
    for (const value of [
      { narration: "x", actions: [], extra: true },
      { narration: "x", actions: [] },
      { narration: "x", actions: [{ kind: "shell", command: "invalid" }] },
      { narration: "x", actions: Array(5).fill({ kind: "wait", ms: 1 }) },
      { narration: "🙂".repeat(1000), actions: [{ kind: "wait", ms: 1 }] },
      { narration: "x", actions: [{ kind: "type", text: "x".repeat(65537) }] }
    ]) expect(() => parseParticipantTool(value)).toThrow();
    for (const action of [{ kind: "click", x: 1.5, y: 2.25, button: null }, { kind: "wait", ms: null },
      { kind: "type", text: null }]) expect(() => parseParticipantTool({ narration: "x", actions: [action] })).toThrow();
    expect(parseParticipantFinal(finalOutput()).closingReport).toEqual({
      summary: "I saved the note.", frictionReports: ["The first click was skipped, so I retried."]
    });
    for (const value of [{ ...finalOutput(), actions: [] }, { ...finalOutput(), outcome: "maybe" },
      { outcome: "reached", summary: "", frictionReports: [] }]) expect(() => parseParticipantFinal(value)).toThrow();
  });

  it("publishes strict native tool and final schemas", () => {
    expect(PARTICIPANT_TOOL_SCHEMA).toMatchObject({ type: "object", additionalProperties: false,
      required: ["narration", "actions"], properties: { narration: { type: "string" }, actions: { type: "array", minItems: 1, maxItems: 4 } } });
    expect(PARTICIPANT_FINAL_SCHEMA).toMatchObject({ type: "object", additionalProperties: false });
    expect(PARTICIPANT_FINAL_SCHEMA.required).toEqual(["outcome", "summary", "frictionReports"]);
  });

  it("keeps one native run across tool callbacks, returns acknowledgments and fresh screenshots, then closes in the same persona session", async () => {
    const replies: Record<string, unknown>[] = [];
    run.mockImplementationOnce(async () => {
      replies.push(JSON.parse(await nativeTool()({ narration: "I will try Save.", actions: [{ kind: "click", x: 1.5, y: 2.25 }] })));
      replies.push(JSON.parse(await nativeTool()({ narration: "That missed; I will retry.", actions: [{ kind: "click", x: 1.75, y: 2.5 }] })));
      return result();
    }).mockResolvedValueOnce(result(finalOutput({ summary: "As the same cautious newcomer, I saved the note." })));
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;

    const first = await h.provider.nextTurn({ ...request(frame(1)), contextHint: "FIRST_SCREEN" }, signal);
    expect(first).toMatchObject({ providerRequestPending: true, actions: [{ kind: "click", x: 1.5, y: 2.25 }] });
    await expect(h.provider.nextTurn({ ...request(frame(2)), previousExecution: {
      actions: [{ index: 0, status: "rejected" as never }]
    } }, signal)).rejects.toMatchObject({ code: "request_rejected", receipt: { dispatched: false } });
    const second = await h.provider.nextTurn({ ...request(frame(2)), contextHint: "RETRY_AFTER_SKIP", previousExecution: {
      actions: [{ index: 0, status: "skipped" as const }]
    } }, signal);
    expect(second).toMatchObject({ providerRequestPending: true, actions: [{ kind: "click", x: 1.75, y: 2.5 }] });
    const terminal = await h.provider.nextTurn({ ...request(frame(3)), previousExecution: {
      actions: [{ index: 0, status: "completed" as const }]
    } }, signal);
    expect(terminal).toMatchObject({ done: true, outcome: "reached", providerRequest: { dispatched: true, usageComplete: true },
      closingReport: { summary: "I saved the note." } });
    expect(run).toHaveBeenCalledTimes(1);
    expect(replies[0]).toEqual({ acknowledgments: [{ index: 0, status: "skipped" }],
      imageUrl: `data:image/png;base64,${frame(2).toString("base64")}`, contextHint: "RETRY_AFTER_SKIP", closing: false });
    expect(replies[1]).toEqual({ acknowledgments: [{ index: 0, status: "completed" }],
      imageUrl: `data:image/png;base64,${frame(3).toString("base64")}`, contextHint: null, closing: false });
    expect(JSON.stringify(run.mock.calls[0]![0])).not.toContain("DO_NOT_SEND");

    const closingExecution = { actions: [{ index: 0, status: "completed" as const }] };
    const closing = await h.provider.debrief!({ ...request(frame(4)), contextHint: "Closing only.", previousExecution: closingExecution }, signal);
    expect(closing.closingReport?.summary).toContain("same cautious newcomer");
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(new Set(run.mock.calls.map(([native]) => native.instructions)).size).toBe(1);
    expect(JSON.parse(run.mock.calls[1]![0].evidence)).toMatchObject({ phase: "closing", contextHint: "Closing only.", previousExecution: closingExecution });
    expect(run.mock.calls[0]![0].schema).toBe(PARTICIPANT_FINAL_SCHEMA);
    expect(run.mock.calls[1]![0].schema).toBe(PARTICIPANT_FINAL_SCHEMA);
    await h.close();
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("refuses changed instructions, unsupported continuation fields and invalid evidence without launching another native turn", async () => {
    run.mockResolvedValue(result());
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    await h.provider.nextTurn(request(), signal);
    for (const candidate of [{ ...request(), instructions: "different" }, { ...request(), previousResponseId: "unsupported" },
      { ...request(), contextHint: "x".repeat(8193) }, { ...request(), observation: { stateSignature: "no-frame" } }]) {
      await expect(h.provider.nextTurn(candidate, signal)).rejects.toMatchObject({ code: "request_rejected" });
    }
    expect(run).toHaveBeenCalledTimes(1);
    expect(sessionClose).not.toHaveBeenCalled();
    await h.close();
  });

  it("retains malformed-final usage and incomplete accounting without claiming completion", async () => {
    run.mockResolvedValueOnce(result({ unexpected: true })).mockResolvedValueOnce(result(finalOutput(), { usage: null, usageComplete: false }));
    const malformed = createRestrictedCodexParticipant();
    await expect(malformed.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({
      code: "invalid_response", failurePhase: "response", receipt: { dispatched: true, cleanup: "confirmed" },
      usage: { input: 20, output: 5 }
    });
    await expect(malformed.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
    await malformed.close();

    const incomplete = createRestrictedCodexParticipant();
    const turn = await incomplete.provider.nextTurn(request(), new AbortController().signal);
    expect(turn.providerRequest).toEqual({ dispatched: true, usageComplete: false, cleanup: "confirmed" });
    expect(turn.usage).toBeUndefined();
    expect(incomplete.provider.interactionUsageIncomplete).toBe(true);
    await incomplete.close();
  });

  it("delivers a native failure that arrives while the yielded action is executing on the next continuation", async () => {
    let nativeSettled!: () => void;
    const settled = new Promise<void>(resolve => { nativeSettled = resolve; });
    run.mockImplementation(async () => {
      void nativeTool()({ narration: "I will click Save.", actions: [{ kind: "click", x: 1, y: 1 }] }).catch(() => undefined);
      const failure = result(null, { status: "failed", errorCode: "codex_process_failed", failurePhase: "response",
        usage: { input: 7, output: 1 }, usageComplete: false });
      nativeSettled();
      return failure;
    });
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    const proposal = await h.provider.nextTurn(request(frame(1)), signal);
    expect(proposal).toMatchObject({ providerRequestPending: true, actions: [{ kind: "click", x: 1, y: 1 }] });
    await settled;
    await vi.waitFor(() => expect(h.provider.interactionUsageIncomplete).toBe(true));

    await expect(h.provider.nextTurn({ ...request(frame(2)), previousExecution: {
      actions: [{ index: 0, status: "completed" as const }]
    } }, signal)).rejects.toMatchObject({ code: "process_failed", failurePhase: "response",
      receipt: { dispatched: true, usageComplete: false, cleanup: "confirmed" }, usage: { input: 7, output: 1 } });
    expect(run).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it("cancels the native request, starts cleanup immediately and waits for native settlement plus cleanup", async () => {
    let finish!: (value: RestrictedCodexResult) => void;
    let confirmCleanup!: (value: boolean) => void;
    run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    sessionClose.mockImplementation(() => new Promise(resolve => { confirmCleanup = resolve; }));
    const h = createRestrictedCodexParticipant();
    const abort = new AbortController();
    const turn = h.provider.nextTurn(request(), abort.signal);
    void turn.catch(() => undefined);
    abort.abort();
    await vi.waitFor(() => expect(sessionClose).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0]![0].signal?.aborted).toBe(true);
    const closing = h.close();
    expect(h.close()).toBe(closing);
    finish(result());
    await expect(turn).rejects.toMatchObject({ code: "cancelled", usage: { input: 20, output: 5 } });
    let settled = false;
    void closing.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    confirmCleanup(true);
    expect(await closing).toEqual({ status: "confirmed" });
    await expect(h.provider.nextTurn(request(), new AbortController().signal)).rejects.toMatchObject({ code: "request_rejected" });
  });

  it.each([false, "throws"])("does not claim native cleanup confirmation when close returns %s", async mode => {
    if (mode === false) sessionClose.mockResolvedValue(false);
    else sessionClose.mockRejectedValue(new Error("synthetic"));
    const h = createRestrictedCodexParticipant();
    const closing = h.close();
    expect(h.close()).toBe(closing);
    expect(await closing).toEqual({ status: "unconfirmed" });
    expect(run).not.toHaveBeenCalled();
    expect(sessionClose).toHaveBeenCalledTimes(1);
  });

  it("rejects a concurrent continuation while one provider request is pending", async () => {
    let finish!: (value: RestrictedCodexResult) => void;
    run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const h = createRestrictedCodexParticipant();
    const signal = new AbortController().signal;
    const first = h.provider.nextTurn(request(), signal);
    await expect(h.provider.nextTurn(request(), signal)).rejects.toMatchObject({ code: "busy", receipt: { dispatched: false } });
    finish(result());
    await expect(first).resolves.toMatchObject({ done: true, outcome: "reached" });
    await h.close();
  });
});
