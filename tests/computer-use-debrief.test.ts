import { describe, expect, it, vi } from "vitest";
import { runComputerUseLoop, type CuaLoopOptions, type CuaProvider, type CuaTurn } from "../src/computer-use.js";
import { buildCuaCostSummary, resolveSelfReportedBlocker, resolveSelfReportedFriction } from "../src/cua-actor-lab.js";
import { defaultRedactionHooks } from "../src/redaction.js";

const report = "The Save button did nothing. I used Enter and finished the task.";
const closing = (overrides: Partial<CuaTurn> = {}): CuaTurn => ({
  actions: [], pendingSafetyChecks: [], done: true, message: report,
  usage: { input: 20, output: 10 },
  closingReport: { summary: "I renamed the item.", frictionReports: [report] }, ...overrides
});
function setup(overrides: Partial<CuaLoopOptions> = {}) {
  let time = 0;
  let actions = 0;
  const execute = vi.fn(async () => { actions++; });
  const observe = vi.fn(async () => ({ stateSignature: String(actions), text: actions ? "saved" : "editing" }));
  const debrief = vi.fn<CuaProvider["nextTurn"]>(async () => closing());
  const onMessage = vi.fn();
  const onObservedUrl = vi.fn();
  const onTrace = vi.fn();
  const nextTurn = vi.fn<CuaProvider["nextTurn"]>(async () => ({
    actions: [{ kind: "keypress", keys: ["ENTER"] }], pendingSafetyChecks: [], done: false,
    responseId: "previous", usage: { input: 10, output: 5 }
  }));
  const provider: CuaProvider = { id: "internal-debrief-port", capabilities: {
    headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: false,
    byoModel: true, preGrantableApprovals: false, inProcessTools: false, license: "open"
  }, nextTurn, debrief };
  const options: CuaLoopOptions = {
    instructions: "Rename the item.", provider, executor: { observe, execute },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    now: () => time, sleep: async (ms) => { time += ms; }, timeoutMs: 10_000,
    redaction: defaultRedactionHooks, stopWhen: { any: [{ id: "hidden-rule", textIncludes: "saved" }] },
    tasks: [{ id: "rename", goal: "Rename the item.", success: { any: [{ textIncludes: "saved" }] } }],
    onMessage, onObservedUrl, onTrace, ...overrides
  };
  return { options, provider, debrief, nextTurn, execute, observe, onMessage, onObservedUrl, onTrace,
    setTime: (value: number) => { time = value; }, run: () => runComputerUseLoop(options) };
}

describe("read-only participant debrief", () => {
  it("recovers a previously unspoken report without further actions or changed completion", async () => {
    const s = setup();
    const result = await s.run();
    expect(result.reason).toBe("stopWhen matched hidden-rule (textIncludes)");
    expect(result.trace.debrief).toMatchObject({ trigger: "stop_when", status: "completed", usageReported: true });
    expect(result.trace.counts).toMatchObject({ turns: 1, debriefCalls: 1, actions: 1, messages: 1 });
    expect(result.trace.tokenUsage).toMatchObject({ input: 30, output: 15, total: 45 });
    expect(result.trace.tokenUsage?.turns).toHaveLength(2);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.observe).toHaveBeenCalledTimes(2);
    expect(s.onMessage).not.toHaveBeenCalled();
    expect(s.onObservedUrl).toHaveBeenCalledTimes(2);
    expect(s.debrief.mock.calls[0]?.[0]).toMatchObject({ previousResponseId: "previous", observation: { text: "saved" } });
    const prompt = s.debrief.mock.calls[0]?.[0];
    expect(prompt?.instructions + String(prompt?.contextHint)).not.toContain("hidden-rule");
    expect(resolveSelfReportedFriction(result)).toBe(report);
    expect(s.onTrace.mock.lastCall?.[0]).toEqual(result.trace.items);
  });

  it("also collects a closing report after dwell stop", async () => {
    const s = setup();
    delete s.options.stopWhen;
    s.options.dwell = { when: { any: [{ textIncludes: "saved" }] }, ms: 100, everyMs: 50, then: "stop" };
    expect((await s.run()).trace.debrief).toMatchObject({ trigger: "dwell", status: "completed" });
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps structured success when a closing reply declares blocked", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(closing({ outcome: "blocked", message: "BLOCKED. The Save button did nothing." }));
    const result = await s.run();
    expect(result.status).toBe("passed");
    expect(result.trace.declaredOutcome).toBeUndefined();
    expect(resolveSelfReportedBlocker(result)).toBeUndefined();
    expect(resolveSelfReportedFriction(result)).toContain("Save button");
  });

  it.each([
    closing({ actions: [{ kind: "click", x: 0, y: 0 }] }),
    closing({ pendingSafetyChecks: [{ id: "safety", code: "check", message: "check" }] }),
    closing({ closingReport: { summary: "", frictionReports: [] } })
  ])("rejects an unusable report while accounting for its usage", async (turn) => {
    const s = setup(); s.debrief.mockResolvedValue(turn);
    const result = await s.run();
    expect(result.trace.debrief).toMatchObject({ status: "failed", usageReported: true });
    expect(result.trace.counts.messages).toBe(0);
    expect(result.trace.tokenUsage?.input).toBe(30);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("passed");
  });

  it("skips an already matched initial observation without inventing experience", async () => {
    const s = setup(); s.options.stopWhen = { any: [{ textIncludes: "editing" }] };
    expect((await s.run()).trace.debrief).toMatchObject({ status: "skipped", reason: "the study stopped before any participant turn" });
    expect(s.nextTurn).not.toHaveBeenCalled(); expect(s.debrief).not.toHaveBeenCalled();
  });

  it("does not request a second report after a natural ending", async () => {
    const s = setup(); s.nextTurn.mockResolvedValue(closing());
    expect((await s.run()).trace.debrief).toBeUndefined(); expect(s.debrief).not.toHaveBeenCalled();
  });

  it("skips providers without the optional contract", async () => {
    const s = setup(); delete s.provider.debrief;
    expect((await s.run()).trace.debrief?.reason).toContain("does not support");
  });

  it.each([0.5, null, Number.NaN])("skips at the cap or with unknown estimate %s", async (estimate) => {
    const s = setup({ maxUsd: 0.5, estimateTurnCostUsd: () => estimate });
    const result = await s.run();
    expect(s.debrief).not.toHaveBeenCalled();
    if (Number.isNaN(estimate)) expect(result.completionReason).toBe("harness_error");
    else expect(result.trace.debrief?.status).toBe("skipped");
  });

  it("refreshes shared budget after closing usage and preserves success on overage", async () => {
    const budget = vi.fn((usage: { input?: number }) => (usage.input ?? 0) >= 30 ? "spent" : null);
    const s = setup({ overRunBudget: budget }); const result = await s.run();
    expect(budget.mock.lastCall?.[0]).toMatchObject({ input: 30 });
    expect(result.status).toBe("passed");
  });

  it("passes cancellation to a hung provider and records unknown usage without retries", async () => {
    const s = setup({ turnTimeoutMs: 5 });
    let aborted = false;
    s.debrief.mockImplementation(async (_req, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
    }));
    const result = await s.run();
    expect(aborted).toBe(true); expect(s.debrief).toHaveBeenCalledTimes(1);
    expect(result.trace.debrief).toMatchObject({ status: "failed", usageReported: false });
    expect(result.status).toBe("passed");
  });

  it("applies known-value scrub and pattern redaction to report and provider error", async () => {
    for (const error of [false, true]) {
      const s = setup({ scrubText: (text) => text.replaceAll("opaque-private-value", "[scrubbed]") });
      const fakeSecret = `sk-proj-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
      const text = `The Save button did nothing. opaque-private-value ${fakeSecret}`;
      if (error) s.debrief.mockRejectedValue(new Error(text)); else s.debrief.mockResolvedValue(closing({ closingReport: { summary: "Renamed the item.", frictionReports: [text] } }));
      const result = await s.run(); const encoded = JSON.stringify(result.trace);
      expect(encoded).not.toContain("opaque-private-value"); expect(encoded).not.toContain(fakeSecret);
    }
  });
  it("marks missing closing usage as unknown alongside priced interaction", async () => {
    const s = setup(); s.debrief.mockRejectedValue(new Error("provider unavailable"));
    const result = await s.run();
    result.trace.estimatedCost = { schema: "humanish.actor-estimated-cost.v1", estimatedCostUsd: 0.02, ratesAsOf: "2026-09-03", modelId: "internal-fixture" };
    const cost = buildCuaCostSummary({ lanes: [{ laneId: "lane-1", trace: result.trace }], desktopMinutes: undefined });
    expect(cost).toMatchObject({ estimatedTotalUsd: 0.02, fullyEstimated: false,
      breakdown: [{ reason: "closing_usage_unreported", estimatedCostUsd: null }, { estimatedCostUsd: 0.02 }] });
    expect(cost?.note).toContain("LOWER BOUND");
  });

  it("treats the typed friction list as authoritative for its summary", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(closing({ closingReport: {
      summary: "I read the accessibility guide and the error-handling docs. The plan was to check whether Save failed.",
      frictionReports: []
    } }));
    const result = await s.run();
    expect(resolveSelfReportedFriction(result)).toBeUndefined();
    expect(result.trace.debrief?.messageId).toBeDefined();
    expect(result.trace.debrief?.report?.frictionReports).toEqual([]);
  });

  it("retains uncertainty in a typed report with phrasing the old heuristic missed", async () => {
    const text = "Clicking Save did not appear to work after two attempts; pressing Enter saved the rename.";
    const s = setup(); s.debrief.mockResolvedValue(closing({ closingReport: { summary: "Renamed it.", frictionReports: [text, text] } }));
    const result = await s.run();
    expect(resolveSelfReportedFriction(result)).toBe(text);
    expect(result.trace.debrief?.report?.frictionReports).toEqual([text]);
  });

  it.each([{}, { input: 20 }, { output: 10 }, { cachedInput: 5 }, { input: Number.NaN, output: 10 }, { input: 20, output: Number.POSITIVE_INFINITY }])(
    "keeps incomplete closing usage unknown and preserves known finite totals (%j)", async (usage) => {
      const s = setup(); s.debrief.mockResolvedValue(closing({ usage }));
      const result = await s.run();
      expect(result.trace.debrief?.usageReported).toBe(false);
      expect(Number.isFinite(result.trace.tokenUsage?.input)).toBe(true);
      expect(Number.isFinite(result.trace.tokenUsage?.output)).toBe(true);
      const cost = buildCuaCostSummary({ lanes: [{ trace: result.trace }], desktopMinutes: undefined });
      expect(cost?.fullyEstimated).toBe(false);
      expect(cost?.breakdown[0]?.reason).toBe("closing_usage_unreported");
    }
  );

  it("skips optional spend if any earlier interaction turn omitted usage", async () => {
    const s = setup({ maxUsd: 0.5, estimateTurnCostUsd: () => 0.01 });
    s.options.stopWhen = { any: [{ textIncludes: "done" }] };
    s.observe.mockResolvedValueOnce({ stateSignature: "0", text: "editing" })
      .mockResolvedValueOnce({ stateSignature: "1", text: "editing" })
      .mockResolvedValueOnce({ stateSignature: "2", text: "done" });
    s.nextTurn.mockResolvedValueOnce({ actions: [{ kind: "click", x: 1, y: 1 }], pendingSafetyChecks: [], done: false });
    const result = await s.run();
    expect(s.debrief).not.toHaveBeenCalled();
    expect(result.trace.debrief?.reason).toContain("earlier participant turn");
  });

});
