import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { ACTOR_STOP_CAUSES } from "../../../src/actors/contract.js";
import { runComputerUseLoop, type CuaProvider } from "../../../src/actors/computer-use/loop.js";
import {
  createOpenAiResponsesProvider,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import {
  CuaPromptRefusedError,
  isCuaPromptRefusedError,
} from "../../../src/actors/computer-use/provider-error.js";
import { actorEnding } from "../../../src/actors/stop-cause.js";
import {
  digestStudyAnalysisInput,
  validateStudyAnalysisArtifact,
} from "../../../src/analysis/validation.js";
import { defaultRedactionHooks } from "../../../src/evidence/redaction.js";
import { syntheticArtifact, syntheticInput } from "../../analysis/fixtures.js";

/** See tests/fixtures/openai-invalid-prompt/README.md for where this body came from. */
const refusalBody = readFileSync(
  new URL("../../fixtures/openai-invalid-prompt/refusal.json", import.meta.url),
  "utf8",
);
const refusalMessage = (JSON.parse(refusalBody) as { error: { message: string } }).error.message;

function refusingProvider(): CuaProvider & { nextTurn: ReturnType<typeof vi.fn> } {
  return {
    id: "fixture",
    version: "1",
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
    nextTurn: vi.fn(async () => {
      throw new CuaPromptRefusedError("OpenAI", "400 invalid_prompt");
    }),
  };
}

describe("a provider refusing the prompt under its usage policy", () => {
  it("is a typed refusal from the OpenAI provider, sent once and never retried", async () => {
    let calls = 0;
    const fetchFn: FetchLike = async () => {
      calls += 1;
      return {
        ok: false,
        status: 400,
        text: async () => refusalBody,
        json: async () => JSON.parse(refusalBody) as unknown,
      };
    };
    const provider = createOpenAiResponsesProvider({
      apiKey: "test-key",
      fetchFn,
      delayFn: async () => undefined,
    });
    const error: unknown = await provider
      .nextTurn(
        { instructions: "Add one task.", observation: { stateSignature: "s" } },
        new AbortController().signal,
      )
      .catch((thrown: unknown) => thrown);
    expect(isCuaPromptRefusedError(error)).toBe(true);
    expect((error as Error).message).toBe(
      "OpenAI refused the prompt under its usage policy (400 invalid_prompt)",
    );
    expect((error as Error).message).not.toContain(refusalMessage);
    expect(calls).toBe(1);
  });

  it("ends the session as that refusal, distinct from a harness error, without a resend", async () => {
    const provider = refusingProvider();
    const result = await runComputerUseLoop({
      instructions: "Add one task.",
      provider,
      executor: { observe: async () => ({ stateSignature: "s" }), execute: async () => {} },
      persona: { id: "fixture", traitsApplied: [], promptDigest: "fixture" },
      redaction: defaultRedactionHooks,
      now: Date.now,
      timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ status: "failed", completionReason: "actor_error" });
    expect(result.trace.stopCause).toBe("provider_refused_prompt");
    expect(result.reason).toBe(
      "OpenAI refused the prompt under its usage policy (400 invalid_prompt); the prompt was not sent again",
    );
    expect(actorEnding(result.trace)?.label).toBe(
      "provider refused the prompt under its usage policy",
    );
    expect(result.trace.items.some((item) => item.title === "provider refused the prompt")).toBe(
      true,
    );
    expect(provider.nextTurn).toHaveBeenCalledTimes(1);
  });

  it("does not match a lookalike error", () => {
    expect(isCuaPromptRefusedError(new Error("OpenAI refused the prompt"))).toBe(false);
    expect(isCuaPromptRefusedError(Object.create(CuaPromptRefusedError.prototype))).toBe(false);
  });
});

it("accepts every recorded stop cause in a study analysis artifact", () => {
  for (const stopCause of ACTOR_STOP_CAUSES) {
    const input = syntheticInput();
    input.participants[0]!.provenance.stopCause = stopCause;
    input.inputDigest = digestStudyAnalysisInput(input);
    const artifact = syntheticArtifact(input);
    expect(validateStudyAnalysisArtifact(artifact), stopCause).toEqual(artifact);
  }
});
