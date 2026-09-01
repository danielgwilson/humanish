import { describe, expect, it } from "vitest";
import { LAB_CONFIG_SCHEMA, parseLabConfig } from "../src/lab-config.js";

// #538: the terminal lane injects the operator's runtime LLM key command-scoped, and codex spawns
// the participant's shell as a child, so the participant INHERITS that key. Two participants in a
// live study flagged the contradiction unprompted and one deleted the variable mid-study. The key
// is spendable against any endpoint, outside scenario.caps and outside allowProviderCredentials.
//
// An egress allowlist is the only bound here that does not depend on the participant's
// cooperation: it cannot reach a host that is not on the list.

function parse(execution: Record<string, unknown>) {
  return parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "egress-test",
    title: "Egress test",
    subject: {
      source: "terminal-product",
      product: { name: "humanish", publicSurfaces: ["https://github.com/danielgwilson/humanish"] }
    },
    actors: [{ type: "codex-exec", mission: "Do the thing." }],
    execution: { target: "e2b-terminal", runtimeAuth: "openai-env", ...execution },
    scenario: { mode: "dry-run", caps: { maxUsd: 0, maxJobs: 0, maxMinutes: 5 } }
  });
}

describe("terminal egress allowlist (#538)", () => {
  it("is absent by default, which keeps egress unrestricted", () => {
    const result = parse({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Absent, NOT an empty array: a wrong host list fails studies in ways that look like product
    // bugs, so restricting egress is opt-in per lab.
    expect(result.config.execution?.egressAllow).toBeUndefined();
  });

  it("accepts a declared host list", () => {
    const result = parse({ egressAllow: ["api.openai.com", "registry.npmjs.org"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.execution?.egressAllow).toEqual(["api.openai.com", "registry.npmjs.org"]);
  });

  it("trims hosts and drops blank entries", () => {
    const result = parse({ egressAllow: ["  api.openai.com  ", "", "   "] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.execution?.egressAllow).toEqual(["api.openai.com"]);
  });

  it("refuses an empty list rather than denying everything silently", () => {
    // An empty allowlist plus deny-all reaches nothing, including the agent's own provider
    // endpoint, and would surface as an unexplained hang instead of a refusal.
    const result = parse({ egressAllow: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("denies everything");
    expect(result.error.message).toContain("provider endpoint");
  });

  it("refuses a list that is not strings", () => {
    const result = parse({ egressAllow: ["api.openai.com", 42] });
    expect(result.ok).toBe(false);
  });

  it("refuses a non-array", () => {
    expect(parse({ egressAllow: "api.openai.com" }).ok).toBe(false);
  });
});
