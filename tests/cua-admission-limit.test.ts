import { describe, expect, it, vi } from "vitest";
import { CuaAdmissionLimitError } from "../src/index.js";
import { runComputerUseLoop, type CuaProvider, type CuaTurn } from "../src/computer-use.js";
import { createOpenAiResponsesProvider, OPENAI_RESPONSES_CU_CAPABILITIES } from "../src/openai-responses-cu.js";
import { participantFeedbackCandidates } from "../src/cua-actor-lab.js";
import { defaultRedactionHooks } from "../src/redaction.js";
import { syntheticPng1x1 } from "./image-fixtures.js";

const screenshot = syntheticPng1x1();
const persona = { id: "synthetic", traitsApplied: [], promptDigest: "fixture" };
const request = { instructions: "Save the item.", observation: { screenshot, stateSignature: "initial" } };
const neverAbort = new AbortController().signal;
const actionTurn: CuaTurn = {
  actions: [{ kind: "keypress", keys: ["ENTER"] }], pendingSafetyChecks: [], done: false,
  usage: { input: 10, output: 5, cachedInput: 0, cacheWriteInput: 0 }
};

// All refusals are local events, not provider-response fixtures. No transport dispatch occurs.
function admission(error: unknown = new CuaAdmissionLimitError()) {
  const transport = vi.fn(async (): Promise<never> => { throw new Error("transport must not run"); });
  const fetchFn = vi.fn(async (): Promise<never> => {
    if (error) throw error;
    return transport();
  });
  const delayFn = vi.fn(async () => {});
  const provider = createOpenAiResponsesProvider({ apiKey: "synthetic-unused-key", fetchFn, delayFn, env: {} });
  return { provider, fetchFn, delayFn, transport };
}

async function run(provider: CuaProvider, overrides: { execute?: () => Promise<void>; turnTimeoutMs?: number } = {}) {
  let actions = 0;
  const execute = vi.fn(async () => { actions++; await overrides.execute?.(); });
  const result = await runComputerUseLoop({
    instructions: request.instructions, persona, provider, redaction: defaultRedactionHooks,
    executor: {
      observe: async () => ({ screenshot, stateSignature: `state-${actions}`, text: actions ? "saved" : "editing" }),
      execute
    },
    tasks: [{ id: "save", goal: "Save the item.", success: { any: [{ textIncludes: "saved" }] } }],
    writeScreenshot: async name => `screenshots/${name}`, now: Date.now, timeoutMs: 1000,
    ...(overrides.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: overrides.turnTimeoutMs })
  });
  return { result, execute };
}

describe("explicit adapter admission limits", () => {
  it("preserves only the fixed typed payload without retrying a pre-dispatch refusal", async () => {
    const error = new CuaAdmissionLimitError();
    error.message = "synthetic-private-payload";
    const s = admission(error);
    await expect(s.provider.nextTurn(request, neverAbort)).rejects.toThrow(CuaAdmissionLimitError);
    expect(s.fetchFn).toHaveBeenCalledTimes(1);
    expect(s.delayFn).not.toHaveBeenCalled();
    expect(s.transport).not.toHaveBeenCalled();
    // The adapter recreates the safe instance rather than forwarding caller-added text.
    const s2 = admission(error);
    await expect(s2.provider.nextTurn(request, neverAbort)).rejects.toThrow(new CuaAdmissionLimitError().message);
  });

  it.each([
    Object.assign(new Error("synthetic-private admission limit"), { name: "CuaAdmissionLimitError" }),
    { name: "CuaAdmissionLimitError", message: "synthetic-private admission limit" },
    Object.assign(Object.create(CuaAdmissionLimitError.prototype), { message: "synthetic-private admission limit" })
  ])("keeps a same-name/text lookalike on the existing sanitized error path (%j)", async error => {
    const s = admission(error);
    await expect(s.provider.nextTurn(request, neverAbort)).rejects.toThrow("OpenAI Responses network error");
    expect(s.fetchFn).toHaveBeenCalledTimes(4);
    expect(s.delayFn.mock.calls).toHaveLength(3);
    expect(s.transport).not.toHaveBeenCalled();
  });

  it.each(["custom-provider", "injected-transport"] as const)("preserves evidence before and after activity through %s", async route => {
    for (const precedingActions of [0, 1]) {
      const s = admission();
      const nextTurn = vi.fn<CuaProvider["nextTurn"]>(async (req, signal) => {
        if (nextTurn.mock.calls.length <= precedingActions) return actionTurn;
        if (route === "custom-provider") throw new CuaAdmissionLimitError();
        return s.provider.nextTurn(req, signal);
      });
      const debrief = vi.fn<CuaProvider["nextTurn"]>();
      const { result, execute } = await run({ id: "synthetic", capabilities: OPENAI_RESPONSES_CU_CAPABILITIES, nextTurn, debrief });
      expect(result.trace).toMatchObject({ status: "incomplete", completionReason: "budget_reached", stopCause: "adapter_limit" });
      expect(result.trace.counts.turns).toBe(precedingActions);
      expect(execute).toHaveBeenCalledTimes(precedingActions);
      expect(nextTurn).toHaveBeenCalledTimes(precedingActions + 1);
      expect(debrief).not.toHaveBeenCalled();
      expect(s.transport).not.toHaveBeenCalled();
      expect(s.delayFn).not.toHaveBeenCalled();
      expect(s.fetchFn).toHaveBeenCalledTimes(route === "custom-provider" ? 0 : 1);
      expect(result.trace.items.filter(item => item.title === "adapter admission limit reached")).toHaveLength(1);
      expect(result.trace.items.filter(item => item.kind === "screenshot")).toHaveLength(precedingActions + 1);
      if (precedingActions) {
        expect(result.trace.tokenUsage).toMatchObject({ input: 10, output: 5, total: 15, turns: [actionTurn.usage] });
        expect(result.trace.taskFunnel?.completed).toBe(1);
      } else {
        expect(result.trace.tokenUsage).toBeUndefined();
        expect(result.trace.taskFunnel?.completed).toBe(0);
        expect(participantFeedbackCandidates({
          runId: "admission-fixture", scenarioId: "save", adapterId: "fixture", goal: "Save the item.", substrate: "e2b-desktop",
          lanes: [{ laneId: "lane-1", streamId: "stream-1", personaId: persona.id, session: result,
            traceArtifactPath: "actors/stream-1.json", screenshots: [] }]
        })).toEqual([]);
      }
    }
  });

  it("handles refusal of the existing stalled-turn retry without a third attempt", async () => {
    const nextTurn = vi.fn<CuaProvider["nextTurn"]>()
      .mockImplementationOnce(async () => new Promise<CuaTurn>(() => {}))
      .mockRejectedValueOnce(new CuaAdmissionLimitError());
    const { result, execute } = await run({ id: "synthetic", capabilities: OPENAI_RESPONSES_CU_CAPABILITIES, nextTurn }, { turnTimeoutMs: 5 });
    expect(result.trace.stopCause).toBe("adapter_limit");
    expect(nextTurn).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
    expect(result.trace.counts.turns).toBe(0);
    expect(result.trace.tokenUsage).toBeUndefined();
  });

  it("does not classify an executor exception as a provider admission declaration", async () => {
    const nextTurn = vi.fn<CuaProvider["nextTurn"]>().mockResolvedValue(actionTurn);
    const { result } = await run({ id: "synthetic", capabilities: OPENAI_RESPONSES_CU_CAPABILITIES, nextTurn }, {
      execute: async () => { throw new CuaAdmissionLimitError(); }
    });
    expect(result.trace.status).toBe("failed");
    expect(result.trace.stopCause).toBeUndefined();
  });
});
