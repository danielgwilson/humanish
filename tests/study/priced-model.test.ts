import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_MODEL,
  DEFAULT_OPENAI_CU_MODEL,
} from "../../src/actors/computer-use/openai-provider.js";
import { pricedModel } from "../../src/study/plan-base.js";

describe("the model a participant's spend is priced at when its provider reports none", () => {
  it("is the model an OpenAI computer-use participant runs", () => {
    expect(
      pricedModel({ kind: "provider-key", vendor: "openai", model: DEFAULT_OPENAI_CU_MODEL }),
    ).toBe(DEFAULT_OPENAI_CU_MODEL);
  });

  it("is the declared model when the study names one", () => {
    expect(pricedModel({ kind: "local-agent", agent: "codex", declaredModel: "gpt-6-astra" })).toBe(
      "gpt-6-astra",
    );
  });

  // A local agent or a library caller runs a model humanish does not choose, so moving the
  // computer-use default to a cheaper model must not lower the rate its cap is checked at.
  it("keeps gpt-5.6-sol rates for a local agent or a library caller", () => {
    expect(pricedModel({ kind: "local-agent", agent: "codex" })).toBe("gpt-5.6-sol");
    expect(pricedModel({ kind: "caller" })).toBe("gpt-5.6-sol");
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol");
  });
});
