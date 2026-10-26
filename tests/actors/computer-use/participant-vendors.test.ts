import { describe, expect, it } from "vitest";

import {
  PARTICIPANT_VENDORS,
  participantKeys,
} from "../../../src/actors/computer-use/providers.js";

// The vendor registry: each API participant vendor's key name and the provider it builds.

describe("the participant vendors", () => {
  it("read each vendor's key from its own variable", () => {
    expect(
      participantKeys({ OPENAI_API_KEY: " sk-openai ", ANTHROPIC_API_KEY: "sk-ant-synthetic" }),
    ).toEqual({ openai: "sk-openai", anthropic: "sk-ant-synthetic" });
  });

  it("build the Anthropic Messages provider for anthropic", () => {
    const provider = PARTICIPANT_VENDORS.anthropic.create({ apiKey: "sk-ant-synthetic" });
    expect(provider).toMatchObject({ id: "anthropic-messages-cu", version: "claude-haiku-5-5" });
  });

  it("refuse OpenAI Fast mode for an Anthropic participant", () => {
    expect(() =>
      PARTICIPANT_VENDORS.anthropic.create({ apiKey: "sk-ant-synthetic", serviceTier: "fast" }),
    ).toThrow(/Fast mode/);
  });
});
