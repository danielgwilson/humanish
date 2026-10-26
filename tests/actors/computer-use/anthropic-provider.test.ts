import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import {
  createAnthropicMessagesProvider,
  type AnthropicMessagesProviderOptions,
} from "../../../src/actors/computer-use/anthropic-provider.js";
import type { CuaTurnRequest } from "../../../src/actors/computer-use/loop.js";
import type { FetchLike } from "../../../src/actors/computer-use/provider-http.js";

// The provider at its transport: headers, retries, errors, settings and what it records. Replies
// are captured or documented shapes from tests/fixtures/anthropic-messages/.

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
  const sent: Array<{ url: string; headers: Record<string, string>; body: Json }> = [];
  const delays: number[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Json });
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
      "anthropic-beta": "context-management-2025-06-27,thinking-binding-controls-2026-08-01",
      "content-type": "application/json",
    });
  });

  it("send and record medium effort and 16,000 output tokens when the caller names neither", async () => {
    const { provider, sent } = scripted([reply(fixture("batch"))]);
    await provider.nextTurn(request, signal);
    expect(provider.modelSettings).toEqual({ reasoningEffort: "medium", maxOutputTokens: 16_000 });
    expect(sent[0]!.body).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: 16_000,
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
  it("says every request carried the whole conversation, and what clearing removed", async () => {
    const { provider } = scripted([reply(fixture("cleared-tool-uses"))]);
    await provider.nextTurn(request, signal);
    expect(provider.conversation).toEqual({
      mode: "explicit_context",
      explicitReason: "stateless_api",
      summarizedTurns: 0,
      requests: [
        {
          mode: "explicit_context",
          carriedExchanges: 0,
          carriedScreenshots: 1,
          clearedInputTokens: 535_248,
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
