import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAnthropicMessagesProvider,
  type AnthropicMessagesProviderOptions,
} from "../../../src/actors/computer-use/anthropic-provider.js";
import { screenJpeg } from "../../../src/actors/computer-use/screen-jpeg.js";
import {
  runComputerUseLoop,
  type CuaAction,
  type CuaTurnRequest,
} from "../../../src/actors/computer-use/loop.js";
import type { FetchLike } from "../../../src/actors/computer-use/provider-http.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { estimateActorCost } from "../../../src/run/pricing.js";

// The provider at its transport: headers, retries, errors, settings and what it records. Replies
// are captured or documented shapes from tests/fixtures/anthropic-messages/.

// The byte-budget test sends the frame as it is: noise is the JPEG encoder's slowest input, and
// the budget is what that test checks.
const encoder = vi.hoisted(() => ({ passThrough: false }));
vi.mock("../../../src/actors/computer-use/screen-jpeg.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/actors/computer-use/screen-jpeg.js")>();
  return {
    screenJpeg: async (png: Buffer) => (encoder.passThrough ? png : actual.screenJpeg(png)),
  };
});
afterEach(() => {
  encoder.passThrough = false;
});

type Json = Record<string, unknown>;
const fixture = (name: string): Json =>
  JSON.parse(
    readFileSync(
      new URL(`../../fixtures/anthropic-messages/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as Json;

type Answer = { status: number; body: Json; retryAfter?: string } | Error;

function scripted(answers: Answer[], options: Partial<AnthropicMessagesProviderOptions> = {}) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: Json; bytes: number }> =
    [];
  const delays: number[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    sent.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Json,
      bytes: Buffer.byteLength(init.body),
    });
    const answer = answers[sent.length - 1] ?? answers.at(-1)!;
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status === 200,
      status: answer.status,
      headers: { get: (name) => (name === "retry-after" ? (answer.retryAfter ?? null) : null) },
      text: async () => JSON.stringify(answer.body),
      json: async () => answer.body,
    };
  };
  const provider = createAnthropicMessagesProvider({
    apiKey: "sk-ant-synthetic",
    fetchFn,
    delayFn: async (ms) => {
      delays.push(ms);
    },
    env: {},
    ...options,
  });
  return { provider, sent, delays };
}

const request: CuaTurnRequest = {
  instructions: "Add a task called Buy milk.",
  observation: {
    screenshot: PNG.sync.write(new PNG({ width: 1440, height: 950 })),
    stateSignature: "s",
  },
};
const signal = new AbortController().signal;
const reply = (body: Json): Answer => ({ status: 200, body });

describe("the Anthropic provider's requests", () => {
  it("authenticate with x-api-key and name the API version and the betas they use", async () => {
    const { provider, sent } = scripted([reply(fixture("batch"))]);
    await provider.nextTurn(request, signal);
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.headers).toEqual({
      "x-api-key": "sk-ant-synthetic",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "compact-2026-01-12,thinking-binding-controls-2026-08-01",
      "content-type": "application/json",
    });
  });

  it("send and record medium effort and 32,000 output tokens when the caller names neither", async () => {
    const { provider, sent } = scripted([reply(fixture("batch"))]);
    await provider.nextTurn(request, signal);
    expect(provider.modelSettings).toEqual({ reasoningEffort: "medium", maxOutputTokens: 32_000 });
    expect(sent[0]!.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 32_000,
      output_config: { effort: "medium" },
      tools: [{ type: "computer_toolset_20260801" }],
    });
  });

  it("refuse an effort level the Messages API does not have", () => {
    expect(() => scripted([], { reasoningEffort: "minimal" })).toThrow(/no Anthropic equivalent/);
  });
});

describe("an error from the Messages API", () => {
  it("is sent again after the 429's Retry-After hint and a 529's backoff", async () => {
    const { provider, sent, delays } = scripted([
      { status: 429, body: fixture("documented-error-429"), retryAfter: "7" },
      { status: 529, body: fixture("documented-error-529") },
      reply(fixture("batch")),
    ]);
    const turn = await provider.nextTurn(request, signal);
    expect(sent).toHaveLength(3);
    expect(delays).toEqual([7000, 400]);
    expect(turn.actions).toHaveLength(5);
    expect(provider.interactionUsageIncomplete).toBe(false);
  });

  it("names its status, type and request path, and never its message", async () => {
    const { provider } = scripted([
      { status: 400, body: fixture("error-400-missing-toolset-name") },
    ]);
    await expect(provider.nextTurn(request, signal)).rejects.toThrow(
      /^Anthropic Messages 400 invalid_request_error at messages\.2\.content\.0$/,
    );
  });

  it("is not sent again under single dispatch", async () => {
    const { provider, sent } = scripted(
      [{ status: 529, body: fixture("documented-error-529") }, reply(fixture("batch"))],
      { singleDispatch: true },
    );
    await expect(provider.nextTurn(request, signal)).rejects.toThrow(/529 overloaded_error/);
    expect(sent).toHaveLength(1);
  });

  it("lost in transit without a spend cap is sent again and leaves usage incomplete", async () => {
    const { provider, sent } = scripted([new TypeError("fetch failed"), reply(fixture("batch"))]);
    await provider.nextTurn(request, signal);
    expect(sent).toHaveLength(2);
    expect(provider.interactionUsageIncomplete).toBe(true);
  });
});

describe("a reply billed outside the rate table", () => {
  it("leaves the session's usage incomplete and says why once", async () => {
    const usInference = structuredClone(fixture("end-turn"));
    (usInference.usage as Json).inference_geo = "us";
    const { provider } = scripted([reply(usInference)]);
    const turn = await provider.nextTurn(request, signal);
    expect(provider.interactionUsageIncomplete).toBe(true);
    expect(turn.notices).toEqual([
      { title: "participant usage outside the rate table", text: expect.stringMatching(/"us"/) },
    ]);
  });
});

describe("the conversation record", () => {
  const next = (patch: Partial<CuaTurnRequest> = {}): CuaTurnRequest => ({
    ...request,
    previousExecution: {
      actions: [0, 1, 2, 3, 4].map((index) => ({ index, status: "completed" as const })),
    },
    ...patch,
  });

  it("says what each request carried, its size, and which one the server compacted", async () => {
    const { provider, sent } = scripted([
      reply(fixture("batch")),
      reply(fixture("compaction")),
      reply(fixture("end-turn")),
    ]);
    await provider.nextTurn(request, signal);
    await provider.nextTurn(next(), signal);
    await provider.nextTurn(
      next({ previousExecution: { actions: [{ index: 0, status: "completed" }] } }),
      signal,
    );
    expect(provider.conversation).toEqual({
      mode: "explicit_context",
      explicitReason: "stateless_api",
      summarizedTurns: 1,
      requests: [
        { mode: "explicit_context", carriedExchanges: 0, carriedScreenshots: 1 },
        { mode: "explicit_context", carriedExchanges: 1, carriedScreenshots: 2, compacted: true },
        { mode: "explicit_context", carriedExchanges: 1, carriedScreenshots: 1 },
      ].map((entry, index) => ({ ...entry, requestBytes: sent[index]!.bytes })),
    });
  });

  it("stops before a request near the 32 MB limit, as when screenshots outgrow compaction", async () => {
    // A 1440x950 frame of noise is about 4.7 MB as PNG, sent here as it is: six of them pass the
    // byte budget long before their tokens reach the compaction trigger.
    encoder.passThrough = true;
    const noise = new PNG({ width: 1440, height: 950 });
    let seed = 2_463_534_242;
    for (let at = 0; at < noise.data.length; at += 1) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      noise.data[at] = at % 4 === 3 ? 255 : seed & 0xff;
    }
    const busy = { screenshot: PNG.sync.write(noise), stateSignature: "s" };
    const { provider, sent } = scripted([reply(fixture("batch"))]);
    await provider.nextTurn({ ...request, observation: busy }, signal);
    const stopped = async (): Promise<unknown> => {
      for (let turn = 0; turn < 8; turn += 1)
        await provider.nextTurn(next({ observation: busy }), signal);
      return undefined;
    };
    await expect(stopped()).rejects.toThrow(/MB with its screenshots, near the .* 32 MB/);
    expect(JSON.stringify(sent.at(-1)!.body).length).toBeLessThan(30 * 2 ** 20);
  });

  it("asks the server to compact past 60,000 input tokens, with the participant's own notes", async () => {
    const { provider, sent } = scripted([reply(fixture("batch"))]);
    await provider.nextTurn(request, signal);
    expect(sent[0]!.body.context_management).toEqual({
      edits: [
        {
          type: "compact_20260112",
          trigger: { type: "input_tokens", value: 60_000 },
          instructions: expect.any(String),
        },
      ],
    });
  });
});

describe("wire capture", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir === undefined) return;
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a reply's usage when its capture cannot be written, and says so", async () => {
    dir = mkdtempSync(join(tmpdir(), "humanish-anthropic-capture-"));
    const captureDir = dir;
    const { provider } = scripted([reply(fixture("batch"))], {
      env: { HUMANISH_CUA_WIRE_CAPTURE_DIR: captureDir },
      // The directory turns read-only after the provider prepared the capture file.
      fetchFn: async () => {
        chmodSync(captureDir, 0o500);
        const body = fixture("batch");
        return { ok: true, status: 200, text: async () => "", json: async () => body };
      },
    });
    const turn = await provider.nextTurn(request, signal);
    expect(turn.usage?.input).toBe(5448);
    expect(turn.notices?.map((notice) => notice.title)).toEqual(["wire capture not written"]);
  });

  it("writes each reply without its thinking signatures", async () => {
    dir = mkdtempSync(join(tmpdir(), "humanish-anthropic-capture-"));
    const raw = structuredClone(fixture("thinking-batch"));
    (raw.content as Json[])[0]!.signature = "EsYBCkYIBhgCKkA-opaque-signature";
    const { provider: signed } = scripted([reply(raw)], {
      env: { HUMANISH_CUA_WIRE_CAPTURE_DIR: dir },
    });
    await signed.nextTurn(request, signal);
    expect(readdirSync(dir)).toEqual(["wire-001.json"]);
    const captured = readFileSync(join(dir, "wire-001.json"), "utf8");
    expect(captured).not.toContain("opaque-signature");
    expect(captured).toContain("<signature removed>");
  });
});

describe("a screenshot within a batch", () => {
  it("is captured where it stands and sent back as that call's image", async () => {
    // Captured: left_click, wait, screenshot, left_click, wait, screenshot.
    const batch = fixture("mid-batch-screenshot");
    const ids = (batch.content as Json[])
      .filter((block) => block.type === "tool_use")
      .map((block) => block.id);
    const { provider, sent } = scripted([reply(batch), reply(fixture("end-turn"))]);
    const screen = PNG.sync.write(new PNG({ width: 1440, height: 950 }));
    const captured = new PNG({ width: 1440, height: 950 });
    captured.data.fill(90);
    const frame = PNG.sync.write(captured);
    const executed: CuaAction["kind"][] = [];
    await runComputerUseLoop({
      instructions: request.instructions,
      provider,
      executor: {
        observe: async () => ({ screenshot: screen, stateSignature: `s${executed.length}` }),
        execute: async (action) => {
          executed.push(action.kind);
          return action.kind === "screenshot" ? { kind: "frame", screenshot: frame } : undefined;
        },
      },
      persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
      redaction: defaultRedactionHooks,
      now: Date.now,
      timeoutMs: 60_000,
    });
    // The last screenshot is the observation after the batch, so the desktop captures one.
    expect(executed).toEqual(["click", "wait", "screenshot", "click", "wait"]);
    const messages = sent[1]!.body.messages as Array<{ role: string; content: Json[] }>;
    const results = messages.findLast((entry) => entry.role === "user")!.content;
    const image = (result: Json | undefined) =>
      ((result?.content as Json[] | undefined)?.[1]?.source as Json | undefined)?.data;
    expect(results.map((result) => result.tool_use_id)).toEqual(ids);
    expect(image(results[2])).toBe((await screenJpeg(frame)).toString("base64"));
    expect(image(results[5])).toBe((await screenJpeg(screen)).toString("base64"));
  });
});

describe("a capped session", () => {
  it("counts a compaction toward the spend cap", async () => {
    // The captured compaction wrote 56,182 tokens to the cache and 1,762 of notes, about $0.0079;
    // the reply after it cost under $0.001. A $0.005 cap stops the session only when the compaction counts.
    const { provider, sent } = scripted([reply(fixture("compaction")), reply(fixture("batch"))]);
    const screen = PNG.sync.write(new PNG({ width: 1440, height: 950 }));
    const result = await runComputerUseLoop({
      instructions: request.instructions,
      provider,
      executor: {
        observe: async () => ({ screenshot: screen, stateSignature: `s${sent.length}` }),
        execute: async () => undefined,
      },
      persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
      redaction: defaultRedactionHooks,
      now: Date.now,
      timeoutMs: 60_000,
      maxUsd: 0.005,
      estimateTurnCostUsd: (usage) => estimateActorCost(usage, "claude-haiku-5-5").estimatedCostUsd,
    });
    expect(sent).toHaveLength(1);
    expect(result.trace.stopCause).toBe("spend_limit");
    expect(result.trace.tokenUsage?.turns).toHaveLength(2);
  });
});
