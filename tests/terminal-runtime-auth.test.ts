import type { Sandbox } from "@e2b/desktop";
import { describe, expect, it } from "vitest";
import { buildOpenAiEgressNetwork, OPENAI_EGRESS_PLACEHOLDER } from "../src/terminal-runtime-auth.js";

// The network request contract is checked against the installed Desktop SDK's real create
// overload, not a hand-authored provider response fixture. No sandbox or provider call occurs.
type InstalledSdkNetwork = NonNullable<NonNullable<Parameters<typeof Sandbox.create>[1]>["network"]>;

describe("OpenAI egress runtime auth request", () => {
  it("is assignable to the installed SDK and adds an exact-host transform without routing restrictions", () => {
    const network: InstalledSdkNetwork = buildOpenAiEgressNetwork("synthetic-test-value");
    expect(network).toEqual({ rules: { "api.openai.com": [{ transform: { headers: { Authorization: "Bearer synthetic-test-value" } } }] } });
    expect(OPENAI_EGRESS_PLACEHOLDER).toBe("humanish-egress-auth-placeholder");
  });

  it("preserves an adopter's routing and unrelated host rules without mutating them", () => {
    const existing = { allowOut: ["example.com"], denyOut: ["0.0.0.0/0"], rules: { "example.com": [{ transform: { headers: { "X-Study": "yes" } } }] } };
    const before = JSON.stringify(existing);
    const network = buildOpenAiEgressNetwork("synthetic-test-value", existing);
    expect(network.allowOut).toEqual(existing.allowOut);
    expect(network.denyOut).toEqual(existing.denyOut);
    expect(network.rules?.["example.com"]).toEqual(existing.rules["example.com"]);
    expect(JSON.stringify(existing)).toBe(before);
  });

  it.each(["api.openai.com", "API.OPENAI.COM", "api.openai.com."])("refuses an existing %s rule without exposing values", (host) => {
    expect(() => buildOpenAiEgressNetwork("synthetic-new-value", {
      rules: { [host]: [{ transform: { headers: { Authorization: "synthetic-existing-value" } } }] }
    })).toThrow("openai-egress conflicts with an existing api.openai.com network rule; refusing to overwrite it.");
  });
});
