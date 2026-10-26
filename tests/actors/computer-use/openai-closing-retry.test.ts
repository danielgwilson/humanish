import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  runComputerUseLoop,
  type CuaLoopOptions,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { createOpenAiResponsesProvider } from "../../../src/actors/computer-use/openai-provider.js";
import { type FetchLike } from "../../../src/actors/computer-use/provider-http.js";
import { ComputerUseAdmissionLimitError } from "../../../src/actors/computer-use/admission-limit.js";

// The closing request sent without text.format, and the strict request the loop may send after
// it. Response shapes are excerpts of a captured live run (see the fixtures' provenance note);
// replies that are not the schema's JSON mutate that real response.
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      new URL(`../../fixtures/openai-closing-report/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
const pending = fixture("pending-computer-call");
const closing = fixture("typed-closing-report");
const withImpressions = fixture("typed-closing-report-impressions");
const impressionsOnly = fixture("impressions-only");
const request: CuaTurnRequest = {
  instructions: "Use the synthetic task list.",
  observation: { screenshot: Buffer.from("synthetic-frame"), stateSignature: "saved" },
  contextHint: "The interaction has ended. Report what you observed.",
};
const signal = new AbortController().signal;

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

describe("a closing reply that gives the schema's JSON with other text", () => {
  const report = withImpressions.output[0].content[0].text as string;
  const debrief = async (reply: unknown) => {
    const h = scripted([pending, reply]);
    await h.provider.nextTurn(request, signal);
    return h.provider.debrief!(request, signal);
  };

  it("is accepted from a code fence without a retry", async () => {
    const result = await debrief(closingSaying(`\`\`\`json\n${report}\n\`\`\``));
    expect(result.closingRetry).toBeUndefined();
    expect(result.closingReport).toEqual(JSON.parse(report));
  });

  it("is accepted after a message of its own without a retry", async () => {
    const reply = closingSaying(report);
    reply.output.unshift({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Here is my closing account." }],
    });
    const result = await debrief(reply);
    expect(result.closingRetry).toBeUndefined();
    expect(result.closingReport).toEqual(JSON.parse(report));
  });

  it("is not asked for again after a refusal", async () => {
    const reply = closingSaying(report);
    reply.output[0].content = [{ type: "refusal", refusal: "I can't help with that." }];
    const result = await debrief(reply);
    expect(result.closingRetry).toBeUndefined();
    expect(result.closingReport).toBeUndefined();
  });
});

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

// tokenUsage.turns rows: the participant's turn, a closing reply sent without the schema, and the
// captured reply to the strict request.
const turnRow = { input: 11541, output: 229, cachedInput: 9849, cacheWriteInput: 1689 };
const withoutSchemaRow = { input: 13600, output: 90, cachedInput: 11541, cacheWriteInput: 2000 };
const withSchemaRow = { input: 13543, output: 221, cachedInput: 0, cacheWriteInput: 13468 };

describe("the trace of a closing report", () => {
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
    expect(trace.debrief).toMatchObject({
      trigger: "stop_when",
      status: "completed",
      reason:
        "one read-only report; no additional desktop actions; original stop and task outcomes preserved; asked twice: the first reply was not the JSON the request asked for",
    });
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
      reason:
        "the closing response did not contain a valid structured participant report; asked twice: the first reply was not the JSON the request asked for",
      usageReported: true,
    });
    expect(trace.tokenUsage?.turns).toEqual([turnRow, withoutSchemaRow, withoutSchemaRow]);
  });
});

describe("a closing request asked once more", () => {
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

  it("does not ask once more under a spend cap when the first closing reply reported no usage", async () => {
    const { usage: _usage, ...unreported } = closingSaying("I renamed it.");
    const { trace, bodies } = await stoppedSession([unreported, withImpressions], {
      maxUsd: 10,
      estimateTurnCostUsd: () => 0.1,
    });
    expect(bodies).toHaveLength(2);
    expect(trace.debrief).toEqual({
      trigger: "stop_when",
      status: "failed",
      reason:
        "the closing response did not contain a valid structured participant report; not asked again: the closing request did not report complete usage, so the remaining model budget is unknown",
      usageReported: false,
    });
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
