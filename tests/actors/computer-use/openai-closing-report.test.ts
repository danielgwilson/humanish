import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  runComputerUseLoop,
  type CuaLoopOptions,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import { ComputerUseAdmissionLimitError } from "../../../src/actors/computer-use/admission-limit.js";

// See the adjacent provenance note. Both positive response shapes are excerpts
// of a captured live run; negative cases deliberately mutate that real response.
const pending = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openai-closing-report/pending-computer-call.json", import.meta.url),
    "utf8",
  ),
);
const closing = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openai-closing-report/typed-closing-report.json", import.meta.url),
    "utf8",
  ),
);
const withImpressions = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/openai-closing-report/typed-closing-report-impressions.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const impressionsOnly = JSON.parse(
  readFileSync(
    new URL("../../fixtures/openai-closing-report/impressions-only.json", import.meta.url),
    "utf8",
  ),
);
const request: CuaTurnRequest = {
  instructions: "Use the synthetic task list.",
  observation: { screenshot: Buffer.from("synthetic-frame"), stateSignature: "saved" },
  contextHint: "The interaction has ended. Report what you observed.",
};
const signal = new AbortController().signal;

function harness(second: unknown = closing, status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const delayFn = vi.fn(async () => undefined);
  const fetchFn: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    const value = bodies.length === 1 ? pending : second;
    const code = bodies.length === 1 ? 200 : status;
    return {
      ok: code === 200,
      status: code,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
  return {
    bodies,
    delayFn,
    provider: createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn,
      delayFn,
      maxRetries: 3,
      env: {},
    }),
  };
}

describe("captured OpenAI closing-report contract", () => {
  it("preserves a local closing-request refusal after a captured interaction without dispatch or retry", async () => {
    const transport = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => pending,
    }));
    const admission = vi.fn(async () => {
      if (transport.mock.calls.length > 0) {
        const error = new ComputerUseAdmissionLimitError();
        error.message = "synthetic-private-payload";
        throw error;
      }
      return transport();
    });
    const delayFn = vi.fn(async () => {});
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn: admission,
      delayFn,
      env: {},
    });
    await provider.nextTurn(request, signal);
    await expect(provider.debrief!(request, signal)).rejects.toThrow(
      new ComputerUseAdmissionLimitError().message,
    );
    expect(admission).toHaveBeenCalledTimes(2);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(delayFn).not.toHaveBeenCalled();
  });

  it("continues the actual pending computer call once, disables tools, and preserves typed report and usage", async () => {
    const h = harness(withImpressions);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({
      previous_response_id: pending.id,
      tool_choice: "none",
      max_output_tokens: 3072,
    });
    expect(h.bodies[1]).not.toHaveProperty("text");
    expect(h.bodies[1]!.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "computer_call_output",
          call_id: pending.output[0].call_id,
        }),
      ]),
    );
    expect(result.closingReport).toEqual(JSON.parse(withImpressions.output[0].content[0].text));
    expect(result.actions).toEqual([]);
    expect(result.usage).toMatchObject({ input: 13543, output: 221, cacheWriteInput: 13468 });
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it.each([
    ["incomplete", undefined],
    ["invalid-json", true],
    ["extra-key", true],
    ["empty-summary", true],
  ])("rejects a %s report while retaining usage; closingRetry %s", async (kind, closingRetry) => {
    const invalid = structuredClone(closing);
    if (kind === "incomplete") invalid.status = "incomplete";
    if (kind === "invalid-json") invalid.output[0].content[0].text = "{broken";
    if (kind === "extra-key")
      invalid.output[0].content[0].text = JSON.stringify({
        summary: "Saved.",
        frictionReports: [],
        extra: true,
      });
    if (kind === "empty-summary")
      invalid.output[0].content[0].text = JSON.stringify({ summary: "", frictionReports: [] });
    const h = harness(invalid);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(result.closingReport).toBeUndefined();
    expect(result.closingRetry).toBe(closingRetry);
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
    expect(h.bodies).toHaveLength(2);
  });

  it.each([429, 500])("does not retry a closing request after HTTP %i", async (status) => {
    const h = harness({}, status);
    await h.provider.nextTurn(request, signal);
    await expect(h.provider.debrief!(request, signal)).rejects.toThrow(
      `OpenAI Responses ${status}`,
    );
    expect(h.bodies).toHaveLength(2);
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it("asks for the report on the conversation the client carries, with tools off", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      zeroDataRetention: true,
      env: {},
      fetchFn: async (_url: string, init?: { body?: unknown }) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const value = bodies.length === 1 ? pending : withImpressions;
        return { ok: true, status: 200, text: async () => "", json: async () => value };
      },
    });
    await provider.nextTurn(request, signal);
    await provider.debrief!(request, signal);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ store: false, tool_choice: "none" });
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    // The report request carries the first turn's opening message and reply.
    expect(JSON.stringify(bodies[1]!.input)).toContain(
      JSON.stringify(bodies[0]!.input).slice(1, 40),
    );
  });
});

describe("a closing request that reads the session's cache", () => {
  // OpenAI's cache reads a request's prefix: the model, instructions, tools, reasoning settings,
  // text.format and the conversation before the new input. A closing request that changes any of
  // them pays to write the whole session again.
  async function nextBodies(zeroDataRetention: boolean, close: boolean) {
    const bodies: Record<string, unknown>[] = [];
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      maxOutputTokens: 8192,
      env: {},
      ...(zeroDataRetention ? { zeroDataRetention: true } : {}),
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        const value = bodies.length === 1 ? pending : closing;
        return { ok: true, status: 200, text: async () => "", json: async () => value };
      },
    });
    await provider.nextTurn(request, signal);
    await (close ? provider.debrief!(request, signal) : provider.nextTurn(request, signal));
    return bodies;
  }

  it.each([false, true])(
    "sends the next turn's prefix with tools off and no text.format, explicit context %s",
    async (zeroDataRetention) => {
      const turn = (await nextBodies(zeroDataRetention, false))[1]!;
      const closingBody = (await nextBodies(zeroDataRetention, true))[1]!;
      const { input: turnInput, max_output_tokens: _turnLimit, ...turnFields } = turn;
      const { input: closingInput, tool_choice, max_output_tokens, ...closingFields } = closingBody;
      expect(closingFields).toEqual(turnFields);
      expect(closingBody).not.toHaveProperty("text");
      expect(tool_choice).toBe("none");
      expect(max_output_tokens).toBe(3072);
      expect((closingInput as unknown[]).slice(0, (turnInput as unknown[]).length)).toEqual(
        turnInput,
      );
    },
  );
});

/** How the transport answers one request other than with a completed reply. */
type Answer = () => ReturnType<FetchLike>;

/**
 * Replies in order, one per request, each a response body or an Answer; the bodies the provider
 * sent.
 */
function scripted(replies: unknown[], options: { zeroDataRetention?: boolean } = {}) {
  const bodies: Record<string, unknown>[] = [];
  const delayFn = vi.fn(async () => undefined);
  const provider = createOpenAiResponsesProvider({
    apiKey: "synthetic-key",
    delayFn,
    env: {},
    ...(options.zeroDataRetention ? { zeroDataRetention: true } : {}),
    fetchFn: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const value = replies[bodies.length - 1];
      if (typeof value === "function") return (value as Answer)();
      return { ok: true, status: 200, text: async () => "", json: async () => value };
    },
  });
  return { bodies, delayFn, provider };
}

/** An answer that gives `reply` after `ms` of wall-clock time. */
const after =
  (ms: number, reply: unknown): Answer =>
  async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true, status: 200, text: async () => "", json: async () => reply };
  };

/** The captured closing reply with `text` in place of its JSON, read partly from the cache. */
function closingSaying(text: string) {
  const reply = structuredClone(closing);
  reply.id = "fixture-closing-reply-without-schema";
  reply.output[0].content[0].text = text;
  reply.usage = {
    input_tokens: 13600,
    input_tokens_details: { cached_tokens: 11541, cache_write_tokens: 2000 },
    output_tokens: 90,
  };
  return reply;
}

describe("a closing reply that is not the schema's JSON", () => {
  const debrief = (h: ReturnType<typeof scripted>) => h.provider.debrief!(request, signal);
  const impressions = (h: ReturnType<typeof scripted>) =>
    h.provider.requestImpressions!(request, signal);

  it.each([false, true])(
    "is marked for a retry that sends the same request with the strict schema, explicit context %s",
    async (zeroDataRetention) => {
      const h = scripted([pending, closingSaying("I renamed the task."), closing], {
        zeroDataRetention,
      });
      await h.provider.nextTurn(request, signal);
      const first = await debrief(h);
      expect(h.bodies).toHaveLength(2);
      expect(first.closingRetry).toBe(true);
      expect(first.closingReport).toBeUndefined();
      expect(first.usage).toEqual({
        input: 13600,
        output: 90,
        cachedInput: 11541,
        cacheWriteInput: 2000,
      });
      const second = await debrief(h);
      expect(h.bodies).toHaveLength(3);
      const { text, ...retried } = h.bodies[2]!;
      expect(retried).toEqual(h.bodies[1]);
      expect(text).toMatchObject({
        format: {
          type: "json_schema",
          name: "participant_closing_report",
          strict: true,
          schema: { required: ["outcome", "summary", "frictionReports", "impressions"] },
        },
      });
      expect(second.closingRetry).toBeUndefined();
      expect(second.closingReport).toEqual(JSON.parse(closing.output[0].content[0].text));
      expect(second.usage).toEqual({
        input: 13543,
        output: 221,
        cachedInput: 0,
        cacheWriteInput: 13468,
      });
      expect(h.delayFn).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["closing report", debrief],
    ["impressions", impressions],
  ])("gives no %s and no retry mark when the strict request fails too", async (_name, close) => {
    const h = scripted([pending, closingSaying("I renamed the task."), closingSaying("{broken")]);
    await h.provider.nextTurn(request, signal);
    await close(h);
    const result = await close(h);
    expect(h.bodies).toHaveLength(3);
    expect(result.closingRetry).toBeUndefined();
    expect(result.closingReport).toBeUndefined();
    expect(result.impressions).toBeUndefined();
    expect(result.actions).toEqual([]);
    expect(result.usage).toEqual({
      input: 13600,
      output: 90,
      cachedInput: 11541,
      cacheWriteInput: 2000,
    });
  });

  it("sends the strict request once when it meets an HTTP error", async () => {
    const failed: Answer = async () => ({
      ok: false,
      status: 500,
      text: async () => "",
      json: async () => ({}),
    });
    const h = scripted([pending, closingSaying("I renamed the task."), failed]);
    await h.provider.nextTurn(request, signal);
    await debrief(h);
    await expect(debrief(h)).rejects.toThrow("OpenAI Responses 500");
    expect(h.bodies).toHaveLength(3);
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it("lists each impressions request in the conversation record", async () => {
    const asked = scripted([pending, closingSaying("I renamed the task."), impressionsOnly]);
    await asked.provider.nextTurn(request, signal);
    await impressions(asked);
    await impressions(asked);
    expect(asked.provider.conversation?.requests).toEqual([
      { mode: "threaded" },
      { mode: "threaded", kind: "impressions" },
      { mode: "threaded", kind: "impressions" },
    ]);
    const once = scripted([pending, impressionsOnly]);
    await once.provider.nextTurn(request, signal);
    await impressions(once);
    expect(once.provider.conversation?.requests).toEqual([
      { mode: "threaded" },
      { mode: "threaded", kind: "impressions" },
    ]);
  });

  it.each([
    ["closing report", debrief],
    ["impressions", impressions],
  ])("was told in the first request the %s schema the retry sets", async (_name, close) => {
    const h = scripted([pending, closingSaying("I renamed the task."), closing]);
    await h.provider.nextTurn(request, signal);
    await close(h);
    await close(h);
    const schema = (h.bodies[2]!.text as { format: { schema: unknown } }).format.schema;
    const texts = JSON.stringify(h.bodies[1]!.input);
    expect(texts).toContain(JSON.stringify(JSON.stringify(schema)).slice(1, -1));
  });
});

describe("the trace of a closing report", () => {
  /** A session that stops when the screen shows "saved", then asks for the closing report. */
  async function stoppedSession(
    closingReplies: unknown[],
    limits: Pick<CuaLoopOptions, "turnTimeoutMs" | "maxUsd" | "estimateTurnCostUsd"> = {},
  ) {
    const h = scripted([pending, ...closingReplies]);
    let actions = 0;
    let time = 0;
    const result = await runComputerUseLoop({
      instructions: request.instructions,
      provider: h.provider,
      executor: {
        observe: async () => ({
          screenshot: Buffer.from(`synthetic-frame-${actions}`),
          stateSignature: `screen-${actions}`,
          text: actions > 0 ? "saved" : "editing",
        }),
        execute: async () => {
          actions += 1;
        },
      },
      persona: { id: "synthetic", traitsApplied: [], promptDigest: "fixture" },
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      timeoutMs: 60_000,
      stopWhen: { any: [{ textIncludes: "saved" }] },
      redaction: defaultRedactionHooks,
      ...limits,
    });
    return { trace: result.trace, bodies: h.bodies };
  }
  const turnRow = { input: 11541, output: 229, cachedInput: 9849, cacheWriteInput: 1689 };
  const withoutSchemaRow = { input: 13600, output: 90, cachedInput: 11541, cacheWriteInput: 2000 };
  const withSchemaRow = { input: 13543, output: 221, cachedInput: 0, cacheWriteInput: 13468 };

  it.each([
    ["an outcome", { summary: "I saved the task.", frictionReports: [], impressions: [] }],
    ["impressions", { outcome: "reached", summary: "I saved the task.", frictionReports: [] }],
  ])("asks once more for a reply without the schema that leaves out %s", async (_field, report) => {
    const { trace, bodies } = await stoppedSession([
      closingSaying(JSON.stringify(report)),
      withImpressions,
    ]);
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toHaveProperty("text.format.strict", true);
    expect(trace.debrief).toMatchObject({ status: "completed" });
    expect(trace.debrief?.report?.summary).toMatch(/^Added “Draft proposal,”/);
  });

  it("has one usage row past the participant's requests when the reply needed no retry", async () => {
    const reply = closingSaying(withImpressions.output[0].content[0].text);
    const { trace, bodies } = await stoppedSession([reply]);
    expect(bodies).toHaveLength(2);
    expect(trace.debrief).toMatchObject({ trigger: "stop_when", status: "completed" });
    expect(trace.conversation?.requests).toHaveLength(1);
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow]);
  });

  it("has a usage row for each closing request when the reply was asked once more", async () => {
    const { trace, bodies } = await stoppedSession([closingSaying("I renamed it."), closing]);
    expect(bodies).toHaveLength(3);
    expect(trace.debrief).toMatchObject({ trigger: "stop_when", status: "completed" });
    expect(trace.conversation?.requests).toHaveLength(1);
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow, withSchemaRow]);
  });

  it("records the failed debrief one bad reply gave when the retry fails too", async () => {
    const broken = closingSaying("{broken");
    const { trace, bodies } = await stoppedSession([closingSaying("I renamed it."), broken]);
    expect(bodies).toHaveLength(3);
    expect(trace.debrief).toEqual({
      trigger: "stop_when",
      status: "failed",
      reason: "the closing response did not contain a valid structured participant report",
      usageReported: true,
    });
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow, withoutSchemaRow]);
  });

  it("keeps the first closing reply's usage when asking once more meets an HTTP error", async () => {
    const failed: Answer = async () => ({
      ok: false,
      status: 500,
      text: async () => "",
      json: async () => ({}),
    });
    const { trace, bodies } = await stoppedSession([closingSaying("I renamed it."), failed]);
    expect(bodies).toHaveLength(3);
    expect(trace.debrief).toEqual({
      trigger: "stop_when",
      status: "failed",
      reason:
        "the closing response did not contain a valid structured participant report; asked once more: OpenAI Responses 500; closing request usage is unreported",
      usageReported: false,
    });
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow]);
  });

  it("says the first closing request was sent when the adapter refuses to ask once more", async () => {
    const refused: Answer = async () => {
      throw new ComputerUseAdmissionLimitError();
    };
    const { trace, bodies } = await stoppedSession([closingSaying("I renamed it."), refused]);
    expect(bodies).toHaveLength(3);
    expect(trace.debrief).toEqual({
      trigger: "stop_when",
      status: "failed",
      reason:
        "the closing response did not contain a valid structured participant report; not asked again: the adapter reported a local admission limit before provider dispatch",
      usageReported: true,
    });
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow]);
  });

  it("keeps the first closing reply's usage when the reply asked once more reports none", async () => {
    const { usage: _usage, ...unreported } = withImpressions;
    const { trace } = await stoppedSession([closingSaying("I renamed it."), unreported]);
    expect(trace.debrief).toMatchObject({ status: "completed", usageReported: false });
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow]);
  });

  it("gives the request asked once more a time bound of its own", async () => {
    const { trace } = await stoppedSession(
      [after(150, closingSaying("I renamed it.")), after(150, withImpressions)],
      { turnTimeoutMs: 200 },
    );
    expect(trace.debrief).toMatchObject({ status: "completed", usageReported: true });
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow, withSchemaRow]);
  });

  it("does not ask once more after the first closing reply crossed the spend cap", async () => {
    const { trace, bodies } = await stoppedSession(
      [closingSaying("I renamed it."), withImpressions],
      { maxUsd: 1, estimateTurnCostUsd: (usage) => (usage.turns?.length ?? 0) * 0.75 },
    );
    expect(bodies).toHaveLength(2);
    expect(trace.debrief).toEqual({
      trigger: "stop_when",
      status: "failed",
      reason:
        "the closing response did not contain a valid structured participant report; not asked again: the estimated model budget was reached",
      usageReported: true,
    });
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow]);
  });
});

describe("limits the OpenAI participant is told", () => {
  const said = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
  const impressionsWire = {
    type: "array",
    maxItems: 6,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "text"],
      properties: {
        kind: {
          type: "string",
          enum: ["unclear", "unfinished", "untrustworthy", "liked", "missing", "unlike_my_work"],
        },
        text: said(500),
      },
    },
  };
  /** The schema the strict retry sets, which the first request states in its input. */
  const schemaOf = (body: Record<string, unknown> | undefined) =>
    (body?.text as { format: { schema: unknown } } | undefined)?.format.schema;
  const retried = () => scripted([pending, closingSaying("I renamed the task."), closing]);

  it("asks for a closing report within the limits its reply is checked against", async () => {
    const h = retried();
    await h.provider.nextTurn(request, signal);
    await h.provider.debrief!(request, signal);
    await h.provider.debrief!(request, signal);
    expect(schemaOf(h.bodies[2])).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["outcome", "summary", "frictionReports", "impressions"],
      properties: {
        outcome: { type: "string", enum: ["reached", "not_reached", "blocked"] },
        summary: said(4000),
        frictionReports: { type: "array", maxItems: 8, items: said(2000) },
        impressions: impressionsWire,
      },
    });
  });

  it("asks for impressions only within the same limits", async () => {
    const h = retried();
    await h.provider.nextTurn(request, signal);
    await h.provider.requestImpressions!(request, signal);
    await h.provider.requestImpressions!(request, signal);
    expect(schemaOf(h.bodies[2])).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["impressions"],
      properties: { impressions: impressionsWire },
    });
  });
});

describe("impressions in the captured OpenAI closing report", () => {
  it("keeps the participant's typed impressions from a closing reply", async () => {
    const h = harness(withImpressions);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(result.closingReport?.impressions).toEqual([
      {
        kind: "unclear",
        text: "The Save button looked the same as the task text, so I could not tell it was a button at first.",
      },
      {
        kind: "unlike_my_work",
        text: "On my paper list I cross out the old name and write the new one beside it. Here the old name just disappeared, so I could not check what I had changed.",
      },
    ]);
  });

  it.each([
    ["seven impressions", Array(7).fill({ kind: "liked", text: "The list was easy to scan." })],
    ["an unknown kind", [{ kind: "annoying", text: "The list was slow." }]],
    ["an empty text", [{ kind: "liked", text: " " }]],
    ["a text over 500 characters", [{ kind: "missing", text: "x".repeat(501) }]],
    ["an extra key", [{ kind: "liked", text: "Fast.", screen: "list" }]],
  ])("rejects a report with %s while retaining usage", async (_name, impressions) => {
    const invalid = structuredClone(withImpressions);
    const report = JSON.parse(invalid.output[0].content[0].text);
    invalid.output[0].content[0].text = JSON.stringify({ ...report, impressions });
    const h = harness(invalid);
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.debrief!(request, signal);
    expect(result.closingReport).toBeUndefined();
    expect(result.closingRetry).toBe(true);
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
    expect(h.bodies).toHaveLength(2);
  });
});

describe("impressions-only request after the participant ends the session itself", () => {
  const cutOff = JSON.parse(
    readFileSync(
      new URL("../../fixtures/openai-incomplete/partial-message.json", import.meta.url),
      "utf8",
    ),
  );
  // The captured final answer has no computer call, so as an interaction reply it ends the session.
  const finalAnswer = closing;
  const hint = { ...request, contextHint: "Return only impressions." };

  function sequence(
    replies: unknown[],
    options: { zeroDataRetention?: boolean; status?: number } = {},
  ) {
    const bodies: Record<string, unknown>[] = [];
    const delayFn = vi.fn(async () => undefined);
    const fetchFn: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const value = replies[bodies.length - 1];
      const code = bodies.length === replies.length ? (options.status ?? 200) : 200;
      return {
        ok: code === 200,
        status: code,
        text: async () => JSON.stringify(value),
        json: async () => value,
      };
    };
    const provider = createOpenAiResponsesProvider({
      apiKey: "synthetic-key",
      fetchFn,
      delayFn,
      maxRetries: 3,
      env: {},
      ...(options.zeroDataRetention ? { zeroDataRetention: true } : {}),
    });
    return { bodies, delayFn, provider };
  }

  it("continues the threaded conversation once with tools off and states a schema of impressions only", async () => {
    const h = sequence([finalAnswer, impressionsOnly]);
    const ended = await h.provider.nextTurn(request, signal);
    expect(ended.actions).toEqual([]);
    const result = await h.provider.requestImpressions!(hint, signal);
    expect(h.bodies).toHaveLength(2);
    expect(h.bodies[1]).toMatchObject({
      previous_response_id: finalAnswer.id,
      tool_choice: "none",
      max_output_tokens: 3072,
    });
    expect(h.bodies[1]).not.toHaveProperty("text");
    expect(JSON.stringify(h.bodies[1]!.input)).toContain("Return only impressions.");
    expect(result.impressions).toEqual(
      JSON.parse(impressionsOnly.output[0].content[0].text).impressions,
    );
    expect(result.closingReport).toBeUndefined();
    expect(result.actions).toEqual([]);
    expect(result.usage).toMatchObject({ input: 13543, output: 221 });
    expect(h.delayFn).not.toHaveBeenCalled();
  });

  it("carries the conversation itself in explicit_context", async () => {
    const h = sequence([finalAnswer, impressionsOnly], { zeroDataRetention: true });
    await h.provider.nextTurn(request, signal);
    const result = await h.provider.requestImpressions!(hint, signal);
    expect(h.bodies[1]).not.toHaveProperty("previous_response_id");
    expect(h.bodies[1]).toMatchObject({ store: false, tool_choice: "none" });
    const input = JSON.stringify(h.bodies[1]!.input);
    expect(input).toContain(request.instructions);
    expect(input).toContain("REACHED THE GOAL.");
    expect(result.impressions).toHaveLength(2);
  });

  it.each([
    ["cut off by the output limit", 2, () => cutOff],
    [
      "an extra key",
      3,
      () => {
        const reply = structuredClone(impressionsOnly);
        reply.output[0].content[0].text = JSON.stringify({ summary: "Saved.", impressions: [] });
        return reply;
      },
    ],
    [
      "an unknown kind",
      3,
      () => {
        const reply = structuredClone(impressionsOnly);
        reply.output[0].content[0].text = JSON.stringify({
          impressions: [{ kind: "annoying", text: "Slow." }],
        });
        return reply;
      },
    ],
  ])("keeps no impressions from a reply %s, after %i requests", async (_name, requests, reply) => {
    const h = sequence([finalAnswer, reply(), reply()]);
    await h.provider.nextTurn(request, signal);
    // As the loop asks: once, and once more for a reply marked closingRetry.
    const first = await h.provider.requestImpressions!(hint, signal);
    const result = first.closingRetry ? await h.provider.requestImpressions!(hint, signal) : first;
    expect(result.impressions).toBeUndefined();
    expect(result.usage?.input).toBeGreaterThan(0);
    expect(h.bodies).toHaveLength(requests);
  });

  it("does not retry an impressions request after HTTP 429", async () => {
    const h = sequence([finalAnswer, {}], { status: 429 });
    await h.provider.nextTurn(request, signal);
    await expect(h.provider.requestImpressions!(hint, signal)).rejects.toThrow(
      "OpenAI Responses 429",
    );
    expect(h.bodies).toHaveLength(2);
    expect(h.delayFn).not.toHaveBeenCalled();
  });
});
