import type { Sandbox } from "@e2b/desktop";
import { describe, expect, it } from "vitest";

import { EGRESS_PLACEHOLDER, holdKeysInEgress } from "../../../src/substrates/e2b/egress-keys.js";

// The network request contract is checked against the installed Desktop SDK's real create
// overload, not a hand-authored provider response fixture. No sandbox or provider call occurs.
type InstalledSdkNetwork = NonNullable<
  NonNullable<Parameters<typeof Sandbox.create>[1]>["network"]
>;

describe("keys held in E2B's egress proxy", () => {
  it("puts each header key behind its host's transform and leaves a placeholder in the env", () => {
    const held = holdKeysInEgress({
      OPENAI_API_KEY: "synthetic-openai",
      GEMINI_API_KEY: "synthetic-gemini",
      E2B_API_KEY: "synthetic-e2b",
      HUMANISH_E2B_MAX_SANDBOX_MINUTES: "60",
    });
    const network: InstalledSdkNetwork = held.network;
    expect(network).toEqual({
      rules: {
        "api.openai.com": [
          { transform: { headers: { Authorization: "Bearer synthetic-openai" } } },
        ],
        "generativelanguage.googleapis.com": [
          { transform: { headers: { "x-goog-api-key": "synthetic-gemini" } } },
        ],
        "api.e2b.app": [{ transform: { headers: { "X-API-Key": "synthetic-e2b" } } }],
      },
    });
    expect(held.env).toEqual({
      OPENAI_API_KEY: EGRESS_PLACEHOLDER,
      GEMINI_API_KEY: EGRESS_PLACEHOLDER,
      E2B_API_KEY: EGRESS_PLACEHOLDER,
      HUMANISH_E2B_MAX_SANDBOX_MINUTES: "60",
    });
    expect(held.held).toEqual(["E2B_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY"]);
    expect(EGRESS_PLACEHOLDER).toBe("humanish-egress-auth-placeholder");
  });

  it("holds the Anthropic key on api.anthropic.com in the x-api-key header Claude's provider sends", () => {
    const held = holdKeysInEgress({ ANTHROPIC_API_KEY: "synthetic-anthropic" });
    const network: InstalledSdkNetwork = held.network;
    expect(network.rules).toEqual({
      "api.anthropic.com": [{ transform: { headers: { "x-api-key": "synthetic-anthropic" } } }],
    });
    expect(held.env).toEqual({ ANTHROPIC_API_KEY: EGRESS_PLACEHOLDER });
    expect(held.held).toEqual(["ANTHROPIC_API_KEY"]);
  });

  it("holds GOOGLE_API_KEY on the Gemini host as Gemini's analyst reads it", () => {
    const held = holdKeysInEgress({ GOOGLE_API_KEY: "synthetic-google" });
    expect(held.network.rules).toEqual({
      "generativelanguage.googleapis.com": [
        { transform: { headers: { "x-goog-api-key": "synthetic-google" } } },
      ],
    });
    expect(held.env).toEqual({ GOOGLE_API_KEY: EGRESS_PLACEHOLDER });
  });

  it("holds the E2B key on the API host of the account's E2B_DOMAIN", () => {
    const held = holdKeysInEgress(
      { E2B_API_KEY: "synthetic-e2b", E2B_DOMAIN: "e2b.example.test" },
      { domain: "e2b.example.test" },
    );
    expect(Object.keys(held.network.rules ?? {})).toEqual(["api.e2b.example.test"]);
    expect(held.env.E2B_DOMAIN).toBe("e2b.example.test");
  });

  it("preserves an adopter's routing and unrelated host rules without mutating them", () => {
    const existing = {
      allowOut: ["example.com"],
      denyOut: ["0.0.0.0/0"],
      rules: { "example.com": [{ transform: { headers: { "X-Study": "yes" } } }] },
    };
    const before = JSON.stringify(existing);
    const { network } = holdKeysInEgress({ OPENAI_API_KEY: "synthetic-test-value" }, { existing });
    expect(network.allowOut).toEqual(existing.allowOut);
    expect(network.denyOut).toEqual(existing.denyOut);
    expect(network.rules?.["example.com"]).toEqual(existing.rules["example.com"]);
    expect(network.rules?.["api.openai.com"]).toHaveLength(1);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it.each(["api.openai.com", "API.OPENAI.COM", "api.openai.com."])(
    "refuses an existing %s rule without exposing values",
    (host) => {
      const refuse = () =>
        holdKeysInEgress(
          { OPENAI_API_KEY: "synthetic-new-value" },
          {
            existing: {
              rules: {
                [host]: [{ transform: { headers: { Authorization: "synthetic-existing-value" } } }],
              },
            },
          },
        );
      expect(refuse).toThrow("api.openai.com");
      expect(refuse).not.toThrow(/synthetic/);
    },
  );

  it("refuses two keys for the same host, since only one transform can apply", () => {
    expect(() =>
      holdKeysInEgress({ GEMINI_API_KEY: "synthetic-a", GOOGLE_API_KEY: "synthetic-b" }),
    ).toThrow("generativelanguage.googleapis.com");
  });

  it("holds nothing and adds no rules when no header key is set", () => {
    expect(holdKeysInEgress({ MODAL_ENVIRONMENT: "main" })).toEqual({
      network: {},
      env: { MODAL_ENVIRONMENT: "main" },
      held: [],
    });
  });
});
