import { readFileSync } from "node:fs";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { runComputerUseLoop } from "../../../src/actors/computer-use/loop.js";
import { createOpenAiResponsesProvider } from "../../../src/actors/computer-use/openai-provider.js";
import type { FetchLike } from "../../../src/actors/computer-use/provider-http.js";
import { isComputerUseOutOfCreditsError } from "../../../src/actors/computer-use/provider-error.js";
import { actorEnding } from "../../../src/actors/stop-cause.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";

/** The 429 body the Responses API sent on an account with no credits left (see its readme in that folder). */
const exhaustedBody = readFileSync(
  new URL("../../fixtures/openai-out-of-credits/credit-balance-exhausted.json", import.meta.url),
  "utf8",
);
const exhaustedMessage = (JSON.parse(exhaustedBody) as { error: { message: string } }).error
  .message;

/** A fetch that answers every request with `body` at `status`, counting the requests. */
function answering(status: number, body: string): { fetchFn: FetchLike; requests: () => number } {
  let requests = 0;
  return {
    fetchFn: async () => {
      requests += 1;
      return {
        ok: false,
        status,
        text: async () => body,
        json: async () => JSON.parse(body) as unknown,
      };
    },
    requests: () => requests,
  };
}

const FRAME = PNG.sync.write(new PNG({ width: 4, height: 4 }));

function provider(fetchFn: FetchLike) {
  return createOpenAiResponsesProvider({ apiKey: "test-key", fetchFn, delayFn: async () => {} });
}

async function firstTurnError(fetchFn: FetchLike): Promise<unknown> {
  return provider(fetchFn)
    .nextTurn(
      { instructions: "Add one task.", observation: { stateSignature: "s" } },
      new AbortController().signal,
    )
    .catch((thrown: unknown) => thrown);
}

describe("an OpenAI account with no credits left", () => {
  it("is a typed error from one request, never retried, that names credits", async () => {
    const fake = answering(429, exhaustedBody);
    const error = await firstTurnError(fake.fetchFn);
    expect(fake.requests()).toBe(1);
    expect(isComputerUseOutOfCreditsError(error)).toBe(true);
    expect((error as Error).message).toBe(
      "OpenAI reports the account is out of credits (429 credit_balance_exhausted)",
    );
    expect((error as Error).message).not.toContain(exhaustedMessage);
  });

  it("is named from the type when the captured body's code is set to null (not a captured body)", async () => {
    const captured = JSON.parse(exhaustedBody) as { error: Record<string, unknown> };
    const typeOnly = JSON.stringify({ error: { ...captured.error, code: null } });
    const fake = answering(429, typeOnly);
    const error = await firstTurnError(fake.fetchFn);
    expect(fake.requests()).toBe(1);
    expect((error as Error).message).toBe(
      "OpenAI reports the account is out of credits (429 insufficient_quota)",
    );
  });

  it("ends the participant's session with its own stop cause", async () => {
    const fake = answering(429, exhaustedBody);
    const result = await runComputerUseLoop({
      instructions: "Add one task.",
      provider: provider(fake.fetchFn),
      executor: {
        observe: async () => ({ screenshot: FRAME, stateSignature: "s" }),
        execute: async () => {},
      },
      persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
      redaction: defaultRedactionHooks,
      now: Date.now,
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ status: "failed", completionReason: "actor_error" });
    expect(result.trace.stopCause).toBe("provider_out_of_credits");
    expect(actorEnding(result.trace)?.label).toBe("provider account out of credits");
    expect(result.reason).toBe(
      "OpenAI reports the account is out of credits (429 credit_balance_exhausted); the request was not sent again",
    );
    expect(fake.requests()).toBe(1);
  });

  it("keeps its stop cause when the session must stop on any failed request under a cap", async () => {
    const fake = answering(429, exhaustedBody);
    const result = await runComputerUseLoop({
      instructions: "Add one task.",
      provider: provider(fake.fetchFn),
      executor: {
        observe: async () => ({ screenshot: FRAME, stateSignature: "s" }),
        execute: async () => {},
      },
      persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
      redaction: defaultRedactionHooks,
      now: Date.now,
      timeoutMs: 60_000,
      maxUsd: 1,
      estimateTurnCostUsd: () => 0,
      requireReportedUsageForSpendCap: true,
    });
    expect(result.trace.stopCause).toBe("provider_out_of_credits");
    expect(fake.requests()).toBe(1);
  });
});
