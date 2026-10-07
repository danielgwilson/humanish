import { describe, expect, it, vi } from "vitest";
import {
  runComputerUseLoopWithTaps,
  type CuaProvider,
  type CuaTurn,
} from "../../../src/actors/computer-use/loop.js";
import type { LoopRunOptions } from "../../../src/actors/computer-use/loop/types.js";
import { buildRunCostSummary } from "../../../src/run/cost-summary.js";
import {
  resolveSelfReportedBlocker,
  resolveSelfReportedFriction,
  sessionEnding,
} from "../../../src/routes/computer-use/self-report.js";
import { hollowCompletion } from "../../../src/run/judge.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { ComputerUseAdmissionLimitError } from "../../../src/actors/computer-use/admission-limit.js";
import type { ParticipantImpression } from "../../../src/actors/contract.js";

const report = "The Save button did nothing. I used Enter and finished the task.";
const closing = (overrides: Partial<CuaTurn> = {}): CuaTurn => ({
  actions: [],
  pendingSafetyChecks: [],
  done: true,
  message: report,
  usage: { input: 20, output: 10 },
  closingReport: { summary: "I renamed the item.", frictionReports: [report] },
  ...overrides,
});
function setup(overrides: Partial<LoopRunOptions> = {}) {
  let time = 0;
  let actions = 0;
  const execute = vi.fn(async () => {
    actions++;
  });
  const observe = vi.fn(async () => ({
    stateSignature: String(actions),
    text: actions ? "saved" : "editing",
  }));
  const debrief = vi.fn<CuaProvider["nextTurn"]>(async () => closing());
  const onMessage = vi.fn();
  const onObservedUrl = vi.fn();
  const onTrace = vi.fn();
  const nextTurn = vi.fn<CuaProvider["nextTurn"]>(async () => ({
    actions: [{ kind: "keypress", keys: ["ENTER"] }],
    pendingSafetyChecks: [],
    done: false,
    responseId: "previous",
    usage: { input: 10, output: 5 },
  }));
  const provider: CuaProvider = {
    id: "internal-debrief-port",
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: false,
      byoModel: true,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "open",
    },
    nextTurn,
    debrief,
  };
  const options: LoopRunOptions = {
    instructions: "Rename the item.",
    provider,
    executor: { observe, execute },
    persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    timeoutMs: 10_000,
    redaction: defaultRedactionHooks,
    stopWhen: { any: [{ id: "hidden-rule", textIncludes: "saved" }] },
    tasks: [
      { id: "rename", goal: "Rename the item.", success: { any: [{ textIncludes: "saved" }] } },
    ],
    onMessage,
    onObservedUrl,
    onTrace,
    ...overrides,
  };
  return {
    options,
    provider,
    debrief,
    nextTurn,
    execute,
    observe,
    onMessage,
    onObservedUrl,
    onTrace,
    setTime: (value: number) => {
      time = value;
    },
    run: () => runComputerUseLoopWithTaps(options),
  };
}

describe("read-only participant debrief", () => {
  it("keeps observed success and known usage when admission refuses the closing request before dispatch", async () => {
    const s = setup();
    const error = new ComputerUseAdmissionLimitError();
    error.message = "synthetic-private-payload";
    s.debrief.mockRejectedValue(error);
    const result = await s.run();
    expect(result.status).toBe("passed");
    expect(result.trace.stopCause).toBeUndefined();
    expect(result.trace.interactionUsageIncomplete).toBeUndefined();
    expect(result.trace.debrief).toMatchObject({ status: "skipped" });
    expect(result.trace.debrief?.usageReported).toBeUndefined();
    expect(result.trace.debrief?.report).toBeUndefined();
    expect(result.trace.tokenUsage).toMatchObject({
      input: 10,
      output: 5,
      turns: [{ input: 10, output: 5 }],
    });
    expect(result.trace.taskFunnel?.completed).toBe(1);
    expect(s.debrief).toHaveBeenCalledTimes(1);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.trace)).not.toContain("synthetic-private-payload");
    result.trace.estimatedCost = {
      schema: "humanish.actor-estimated-cost.v1",
      estimatedCostUsd: 0.02,
      ratesAsOf: "2026-09-03",
      modelId: "internal-fixture",
    };
    const cost = buildRunCostSummary({ participants: [{ trace: result.trace }] });
    expect(cost?.fullyEstimated).toBe(true);
    expect(cost?.breakdown).toHaveLength(1);
    expect(cost?.breakdown[0]?.estimatedCostUsd).toBe(0.02);
  });

  it("skips optional paid debrief after a provider reports an ambiguous interactive retry", async () => {
    const s = setup({ maxUsd: 1, estimateTurnCostUsd: () => 0.01 });
    Object.defineProperty(s.provider, "interactionUsageIncomplete", { get: () => true });
    const result = await s.run();
    expect(result.status).toBe("passed");
    expect(result.trace.interactionUsageIncomplete).toBe(true);
    expect(result.trace.debrief).toMatchObject({ status: "skipped" });
    expect(s.debrief).not.toHaveBeenCalled();
  });

  it("recovers a previously unspoken report without further actions or changed completion", async () => {
    const s = setup();
    const result = await s.run();
    expect(result.reason).toBe("stopWhen matched hidden-rule (textIncludes)");
    expect(result.trace.debrief).toMatchObject({
      trigger: "stop_when",
      status: "completed",
      usageReported: true,
    });
    expect(result.trace.counts).toMatchObject({
      turns: 1,
      debriefCalls: 1,
      actions: 1,
      messages: 1,
    });
    expect(result.trace.tokenUsage).toMatchObject({ input: 30, output: 15, total: 45 });
    expect(result.trace.tokenUsage?.turns).toHaveLength(2);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.observe).toHaveBeenCalledTimes(2);
    expect(s.onMessage).not.toHaveBeenCalled();
    expect(s.onObservedUrl).toHaveBeenCalledTimes(2);
    expect(s.debrief.mock.calls[0]?.[0]).toMatchObject({
      previousResponseId: "previous",
      observation: { text: "saved" },
    });
    const prompt = s.debrief.mock.calls[0]?.[0];
    expect(prompt?.instructions + String(prompt?.contextHint)).not.toContain("hidden-rule");
    expect(resolveSelfReportedFriction(result)).toBe(report);
    expect(s.onTrace.mock.lastCall?.[0]).toEqual(result.trace.items);
  });

  it("also collects a closing report after dwell stop", async () => {
    const s = setup();
    delete s.options.stopWhen;
    s.options.dwell = {
      when: { any: [{ textIncludes: "saved" }] },
      ms: 100,
      everyMs: 50,
      then: "stop",
    };
    expect((await s.run()).trace.debrief).toMatchObject({ trigger: "dwell", status: "completed" });
    expect(s.execute).toHaveBeenCalledTimes(1);
  });

  it("keeps structured success when a closing reply declares blocked", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(
      closing({ outcome: "blocked", message: "BLOCKED. The Save button did nothing." }),
    );
    const result = await s.run();
    expect(result.status).toBe("passed");
    expect(result.trace.declaredOutcome).toBeUndefined();
    expect(resolveSelfReportedBlocker(result)).toBeUndefined();
    expect(resolveSelfReportedFriction(result)).toContain("Save button");
  });

  it.each([
    closing({ actions: [{ kind: "click", x: 0, y: 0 }] }),
    closing({ pendingSafetyChecks: [{ id: "safety", code: "check", message: "check" }] }),
    closing({ closingReport: { summary: "", frictionReports: [] } }),
  ])("rejects an unusable report while accounting for its usage", async (turn) => {
    const s = setup();
    s.debrief.mockResolvedValue(turn);
    const result = await s.run();
    expect(result.trace.debrief).toMatchObject({ status: "failed", usageReported: true });
    expect(result.trace.counts.messages).toBe(0);
    expect(result.trace.tokenUsage?.input).toBe(30);
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("passed");
  });

  it("skips an already matched initial observation without inventing experience", async () => {
    const s = setup();
    s.options.stopWhen = { any: [{ textIncludes: "editing" }] };
    expect((await s.run()).trace.debrief).toMatchObject({
      status: "skipped",
      reason: "the study stopped before any participant turn",
    });
    expect(s.nextTurn).not.toHaveBeenCalled();
    expect(s.debrief).not.toHaveBeenCalled();
  });

  it("asks only for impressions after a natural ending, and changes nothing else", async () => {
    const ending = (s: ReturnType<typeof setup>) => {
      s.nextTurn.mockResolvedValue({
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        message: report,
        usage: { input: 20, output: 10 },
      });
      return s;
    };
    const before = await ending(setup()).run();
    const s = ending(setup());
    const ask = vi.fn<NonNullable<CuaProvider["requestImpressions"]>>(async () => ({
      actions: [],
      pendingSafetyChecks: [],
      done: true,
      usage: { input: 30, output: 8 },
      impressions: [{ kind: "liked", text: "Pressing Enter saved the name at once." }],
    }));
    s.provider.requestImpressions = ask;
    const after = await s.run();

    expect(s.debrief).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0]?.[0].contextHint).toContain("Return only impressions");
    expect(after.trace.impressions).toMatchObject({
      status: "collected",
      items: [{ kind: "liked", text: "Pressing Enter saved the name at once." }],
    });
    expect(after.trace.debrief).toEqual({
      trigger: "participant_end",
      status: "completed",
      reason: expect.any(String),
      usageReported: true,
    });
    expect(after.trace.tokenUsage).toMatchObject({ input: 50, output: 18 });
    // The participant's own ending is what it was without the request.
    expect(before.trace.debrief).toBeUndefined();
    for (const run of [before, after]) expect(run.status).toBe("passed");
    expect(after.reason).toBe(before.reason);
    expect(after.completionReason).toBe(before.completionReason);
    expect(after.trace.declaredOutcome).toBe(before.trace.declaredOutcome);
    expect(resolveSelfReportedFriction(after)).toBe(resolveSelfReportedFriction(before));
    expect(sessionEnding(after)).toEqual(sessionEnding(before));
  });

  it("skips providers without the optional contract", async () => {
    const s = setup();
    delete s.provider.debrief;
    expect((await s.run()).trace.debrief?.reason).toContain("does not support");
  });

  it.each([0.5, null, Number.NaN])(
    "skips at the cap or with unknown estimate %s",
    async (estimate) => {
      const s = setup({ maxUsd: 0.5, estimateTurnCostUsd: () => estimate });
      const result = await s.run();
      expect(s.debrief).not.toHaveBeenCalled();
      if (Number.isNaN(estimate)) expect(result.completionReason).toBe("harness_error");
      else expect(result.trace.debrief?.status).toBe("skipped");
    },
  );

  it("records a shared study spend stop before action or debrief", async () => {
    const s = setup({ overRunBudget: () => "the study spend limit was reached" });
    const result = await s.run();
    expect(result.trace.stopCause).toBe("study_spend_limit");
    expect(result.trace.status).toBe("incomplete");
    expect(s.execute).not.toHaveBeenCalled();
    expect(s.debrief).not.toHaveBeenCalled();
  });

  it("refreshes shared budget after closing usage and preserves success on overage", async () => {
    const budget = vi.fn((usage: { input?: number }) =>
      (usage.input ?? 0) >= 30 ? "spent" : null,
    );
    const s = setup({ overRunBudget: budget });
    const result = await s.run();
    expect(budget.mock.lastCall?.[0]).toMatchObject({ input: 30 });
    expect(result.status).toBe("passed");
  });

  it("passes cancellation to a hung provider and records unknown usage without retries", async () => {
    const s = setup({ turnTimeoutMs: 5 });
    let aborted = false;
    s.debrief.mockImplementation(
      async (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const result = await s.run();
    expect(aborted).toBe(true);
    expect(s.debrief).toHaveBeenCalledTimes(1);
    expect(result.trace.debrief).toMatchObject({ status: "failed", usageReported: false });
    expect(result.status).toBe("passed");
  });

  it("applies known-value scrub and pattern redaction to report and provider error", async () => {
    for (const error of [false, true]) {
      const s = setup({
        scrubText: (text) => text.replaceAll("opaque-private-value", "[scrubbed]"),
      });
      const fakeSecret = `sk-proj-${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
      const text = `The Save button did nothing. opaque-private-value ${fakeSecret}`;
      if (error) s.debrief.mockRejectedValue(new Error(text));
      else
        s.debrief.mockResolvedValue(
          closing({ closingReport: { summary: "Renamed the item.", frictionReports: [text] } }),
        );
      const result = await s.run();
      const encoded = JSON.stringify(result.trace);
      expect(encoded).not.toContain("opaque-private-value");
      expect(encoded).not.toContain(fakeSecret);
    }
  });
  it("marks missing closing usage as unknown alongside priced interaction", async () => {
    const s = setup();
    s.debrief.mockRejectedValue(new Error("provider unavailable"));
    const result = await s.run();
    result.trace.estimatedCost = {
      schema: "humanish.actor-estimated-cost.v1",
      estimatedCostUsd: 0.02,
      ratesAsOf: "2026-09-03",
      modelId: "internal-fixture",
    };
    const cost = buildRunCostSummary({
      participants: [{ participantId: "lane-1", trace: result.trace }],
      desktopMinutes: undefined,
    });
    expect(cost).toMatchObject({
      estimatedTotalUsd: 0.02,
      fullyEstimated: false,
      breakdown: [
        { reason: "closing_usage_unreported", estimatedCostUsd: null },
        { estimatedCostUsd: 0.02 },
      ],
    });
    expect(cost?.note).toContain("a lower bound");
  });

  it("treats the typed friction list as authoritative for its summary", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(
      closing({
        closingReport: {
          summary:
            "I read the accessibility guide and the error-handling docs. The plan was to check whether Save failed.",
          frictionReports: [],
        },
      }),
    );
    const result = await s.run();
    expect(resolveSelfReportedFriction(result)).toBeUndefined();
    expect(result.trace.debrief?.messageId).toBeDefined();
    expect(result.trace.debrief?.report?.frictionReports).toEqual([]);
  });

  it("retains uncertainty in a typed report with phrasing the old heuristic missed", async () => {
    const text =
      "Clicking Save did not appear to work after two attempts; pressing Enter saved the rename.";
    const s = setup();
    s.debrief.mockResolvedValue(
      closing({ closingReport: { summary: "Renamed it.", frictionReports: [text, text] } }),
    );
    const result = await s.run();
    expect(resolveSelfReportedFriction(result)).toBe(text);
    expect(result.trace.debrief?.report?.frictionReports).toEqual([text]);
  });

  it.each([
    {},
    { input: 20 },
    { output: 10 },
    { cachedInput: 5 },
    { input: Number.NaN, output: 10 },
    { input: 20, output: Number.POSITIVE_INFINITY },
  ])(
    "keeps incomplete closing usage unknown and preserves known finite totals (%j)",
    async (usage) => {
      const s = setup();
      s.debrief.mockResolvedValue(closing({ usage }));
      const result = await s.run();
      expect(result.trace.debrief?.usageReported).toBe(false);
      expect(Number.isFinite(result.trace.tokenUsage?.input)).toBe(true);
      expect(Number.isFinite(result.trace.tokenUsage?.output)).toBe(true);
      const cost = buildRunCostSummary({
        participants: [{ trace: result.trace }],
        desktopMinutes: undefined,
      });
      expect(cost?.fullyEstimated).toBe(false);
      expect(cost?.breakdown[0]?.reason).toBe("closing_usage_unreported");
    },
  );

  it("stops before another paid request once an interaction turn omitted usage", async () => {
    const s = setup({ maxUsd: 0.5, estimateTurnCostUsd: () => 0.01 });
    s.options.stopWhen = { any: [{ textIncludes: "done" }] };
    s.observe
      .mockResolvedValueOnce({ stateSignature: "0", text: "editing" })
      .mockResolvedValueOnce({ stateSignature: "1", text: "editing" })
      .mockResolvedValueOnce({ stateSignature: "2", text: "done" });
    s.nextTurn.mockResolvedValueOnce({
      actions: [{ kind: "click", x: 1, y: 1 }],
      pendingSafetyChecks: [],
      done: false,
    });
    const result = await s.run();
    // The capped session does not send a second request whose spend it could not add up.
    expect(s.nextTurn).toHaveBeenCalledTimes(1);
    expect(s.debrief).not.toHaveBeenCalled();
    expect(result.trace).toMatchObject({
      stopCause: "usage_unreported",
      interactionUsageIncomplete: true,
    });
  });
});

describe("participant impressions at the end of a session", () => {
  const unclear =
    "The Save button looked the same as the task text, so I could not tell it was a button at first.";
  const unlike =
    "On my paper list I cross out the old name and write the new one beside it. Here the old name just disappeared.";
  const impressions = [
    { kind: "unclear" as const, text: unclear },
    { kind: "unlike_my_work" as const, text: unlike },
  ];
  const withImpressions = (list: ParticipantImpression[] = impressions) =>
    closing({
      closingReport: { summary: "I renamed the item.", frictionReports: [], impressions: list },
    });

  it("asks for each kind of impression, including how the persona does the same task", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(withImpressions());
    await s.run();
    const hint = String(s.debrief.mock.calls[0]?.[0].contextHint);
    for (const kind of [
      "unclear",
      "unfinished",
      "untrustworthy",
      "liked",
      "missing",
      "unlike_my_work",
    ])
      expect(hint).toContain(kind);
    expect(hint).toContain("own work or life");
  });

  it("records the closing account's impressions as quotable participant statements", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(withImpressions());
    const { trace } = await s.run();
    expect(trace.impressions).toEqual({
      status: "collected",
      items: [
        { kind: "unclear", text: unclear, messageId: expect.any(String) },
        { kind: "unlike_my_work", text: unlike, messageId: expect.any(String) },
      ],
    });
    const items = trace.impressions?.status === "collected" ? trace.impressions.items : [];
    for (const impression of items) {
      const message = trace.items.find((item) => item.id === impression.messageId);
      expect(message?.kind).toBe("message");
      expect(message?.text).toContain(impression.text);
    }
    expect(trace.items.find((item) => item.id === items[1]?.messageId)?.text).toContain(
      "unlike my work",
    );
    // Impressions answer the harness's question, so they do not count as the participant speaking.
    expect(trace.counts.messages).toBe(1);
    expect(trace.debrief?.report).toEqual({ summary: "I renamed the item.", frictionReports: [] });
  });

  it("keeps impressions out of the participant's reported friction", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(withImpressions());
    expect(resolveSelfReportedFriction(await s.run())).toBeUndefined();
  });

  it("records an empty list when the participant had no impressions", async () => {
    const s = setup();
    s.debrief.mockResolvedValue(withImpressions([]));
    expect((await s.run()).trace.impressions).toEqual({ status: "collected", items: [] });
  });

  it("redacts impressions like the rest of the closing account", async () => {
    const s = setup({ scrubText: (text) => text.replaceAll("opaque-private-value", "[scrubbed]") });
    s.debrief.mockResolvedValue(
      withImpressions([{ kind: "missing", text: "I expected opaque-private-value on the list." }]),
    );
    const { trace } = await s.run();
    expect(JSON.stringify(trace)).not.toContain("opaque-private-value");
    expect(trace.impressions).toMatchObject({
      items: [{ kind: "missing", text: "I expected [scrubbed] on the list." }],
    });
  });

  it("keeps the impressions in a participant's own final account", async () => {
    const s = setup();
    s.nextTurn.mockResolvedValue(withImpressions());
    const { trace } = await s.run();
    expect(trace.debrief).toBeUndefined();
    expect(trace.impressions).toMatchObject({
      status: "collected",
      items: [{ kind: "unclear" }, { kind: "unlike_my_work" }],
    });
  });

  const withoutReport = (): CuaTurn => {
    const { closingReport: _report, ...turn } = closing();
    return turn;
  };

  it.each([
    [
      "the provider has no closing report",
      (s: ReturnType<typeof setup>) => delete s.provider.debrief,
      /closing report was skipped: this provider does not support/,
    ],
    [
      "the closing report failed",
      (s: ReturnType<typeof setup>) => s.debrief.mockRejectedValue(new Error("network down")),
      /closing report failed: network down/,
    ],
    [
      "the closing report has no impressions",
      () => undefined,
      /closing account did not include impressions/,
    ],
    [
      "the participant ended without a structured account",
      (s: ReturnType<typeof setup>) => s.nextTurn.mockResolvedValue(withoutReport()),
      /ended the session without a structured closing account/,
    ],
    [
      "the session stopped before a closing account",
      (s: ReturnType<typeof setup>) => s.nextTurn.mockRejectedValue(new Error("provider down")),
      /stopped before a closing account/,
    ],
  ])("says why impressions were not collected when %s", async (_name, arrange, reason) => {
    const s = setup();
    arrange(s);
    const { trace } = await s.run();
    expect(trace.impressions?.status).toBe("not_collected");
    expect(trace.impressions?.status === "not_collected" && trace.impressions.reason).toMatch(
      reason,
    );
  });
});

describe("impressions after the participant ends the session itself", () => {
  const ended: CuaTurn = {
    actions: [],
    pendingSafetyChecks: [],
    done: true,
    message: report,
    usage: { input: 20, output: 10 },
  };
  const run = async (
    ask: NonNullable<CuaProvider["requestImpressions"]>,
    overrides: Partial<LoopRunOptions> = {},
  ) => {
    const s = setup(overrides);
    s.nextTurn.mockResolvedValue(ended);
    s.provider.requestImpressions = vi.fn(ask);
    return s.run();
  };
  const without = async () => {
    const s = setup();
    s.nextTurn.mockResolvedValue(ended);
    return s.run();
  };

  it.each([
    [
      "fails",
      async () => {
        throw new Error("network down");
      },
      /impressions request failed: network down/,
    ],
    [
      "times out",
      (_req: unknown, signal: AbortSignal) =>
        new Promise<CuaTurn>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      /impressions request failed: impressions request deadline reached/,
    ],
    [
      "is cut off",
      async (): Promise<CuaTurn> => ({
        actions: [],
        pendingSafetyChecks: [],
        done: true,
        interruption: "output_limit",
        usage: { input: 30, output: 3072 },
      }),
      /impressions request failed: the reply was cut off by the output limit/,
    ],
  ] as const)(
    "records not_collected with the reason when the request %s, and changes nothing else",
    async (_name, ask, reason) => {
      const before = await without();
      const after = await run(ask as NonNullable<CuaProvider["requestImpressions"]>, {
        turnTimeoutMs: 5,
      });
      expect(after.trace.impressions?.status).toBe("not_collected");
      expect(
        after.trace.impressions?.status === "not_collected" && after.trace.impressions.reason,
      ).toMatch(reason);
      expect(after.trace.debrief).toMatchObject({ trigger: "participant_end", status: "failed" });
      expect(after.trace.debrief?.report).toBeUndefined();
      expect(after.status).toBe(before.status);
      expect(after.reason).toBe(before.reason);
      expect(resolveSelfReportedFriction(after)).toBe(resolveSelfReportedFriction(before));
      expect(sessionEnding(after)).toEqual(sessionEnding(before));
    },
  );

  it("keeps a participant that acted on nothing and said nothing a hollow completion", async () => {
    const s = setup();
    s.nextTurn.mockResolvedValue({ actions: [], pendingSafetyChecks: [], done: true });
    s.provider.requestImpressions = vi.fn(async () => ({
      actions: [],
      pendingSafetyChecks: [],
      done: true,
      usage: { input: 30, output: 8 },
      impressions: [{ kind: "unfinished" as const, text: "The page was blank." }],
    }));
    const result = await s.run();
    expect(result.trace.impressions).toMatchObject({ status: "collected" });
    expect(hollowCompletion(sessionEnding(result))).toBe(true);
  });

  it("does not ask a participant whose own final account carried impressions", async () => {
    const s = setup();
    s.nextTurn.mockResolvedValue({
      ...ended,
      closingReport: {
        summary: "I renamed it.",
        frictionReports: [],
        impressions: [{ kind: "liked", text: "Enter saved it." }],
      },
    });
    const ask = vi.fn<NonNullable<CuaProvider["requestImpressions"]>>();
    s.provider.requestImpressions = ask;
    const result = await s.run();
    expect(ask).not.toHaveBeenCalled();
    expect(result.trace.debrief).toBeUndefined();
    expect(result.trace.impressions).toMatchObject({ status: "collected" });
  });
});
