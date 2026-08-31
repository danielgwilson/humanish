import { describe, expect, it } from "vitest";
import {
  NESTED_INJECTED_NAME,
  NESTED_KEY_NAME,
  resolveNestedSandboxGrant,
  sweepNestedSandboxes,
  verifyNestedGrantIsolation,
  type SandboxLister
} from "../src/nested-sandbox-grant.js";

/** A fake E2B module that records which key each call was scoped to. */
function fakeLister(byKey: Record<string, string[]>) {
  const listedWith: string[] = [];
  const killed: string[] = [];
  const lister: SandboxLister = {
    list(options) {
      listedWith.push(options.apiKey);
      const ids = byKey[options.apiKey] ?? [];
      return { nextItems: async () => ids.map((sandboxId) => ({ sandboxId })) };
    },
    async connect(id, options) {
      if (!(byKey[options.apiKey] ?? []).includes(id)) throw new Error("not in this project");
      return { kill: async () => killed.push(id) };
    }
  };
  return { lister, listedWith, killed };
}

describe("nested sandbox grant", () => {
  it("refuses when the lab asks for a grant but no key is set", () => {
    const result = resolveNestedSandboxGrant({ env: {}, operatorKey: "e2b_operator" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("HUMANISH_NESTED_GRANT_MISSING");
    // The refusal has to tell the operator what to do, not just that it failed.
    expect(result.message).toContain(NESTED_KEY_NAME);
    expect(result.message).toContain("spending limit");
  });

  it("refuses the operator's own key: same project, same budget, no bound", () => {
    const result = resolveNestedSandboxGrant({
      env: { [NESTED_KEY_NAME]: "e2b_operator" },
      operatorKey: "e2b_operator"
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("HUMANISH_NESTED_GRANT_NOT_SCOPED");
  });

  it("never reads E2B_API_KEY — the usual variable cannot silently enable a grant", () => {
    const result = resolveNestedSandboxGrant({
      env: { E2B_API_KEY: "e2b_operator" },
      operatorKey: "e2b_operator"
    });
    expect(result.ok).toBe(false);
  });

  it("grants under the name the participant's tooling expects", () => {
    const result = resolveNestedSandboxGrant({
      env: { [NESTED_KEY_NAME]: "e2b_nested" },
      operatorKey: "e2b_operator"
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envs).toEqual({ [NESTED_INJECTED_NAME]: "e2b_nested" });
  });

  it("proves isolation by asking whether the granted key can see the operator's own sandbox", async () => {
    const { lister, listedWith } = fakeLister({ e2b_nested: ["sbx_participant"] });
    const verdict = await verifyNestedGrantIsolation({
      apiKey: "e2b_nested",
      operatorSandboxId: "sbx_operator",
      lister
    });
    expect(verdict.isolated).toBe(true);
    // Scoped to the GRANTED key — never the operator's.
    expect(listedWith).toEqual(["e2b_nested"]);
  });

  it("refuses two distinct keys that share one project (what value comparison misses)", async () => {
    const { lister } = fakeLister({ e2b_second_key: ["sbx_operator", "sbx_other"] });
    const verdict = await verifyNestedGrantIsolation({
      apiKey: "e2b_second_key",
      operatorSandboxId: "sbx_operator",
      lister
    });
    expect(verdict.isolated).toBe(false);
    if (verdict.isolated) return;
    expect(verdict.reason).toContain("SAME E2B project");
  });

  it("treats an unverifiable grant as a refused grant", async () => {
    const lister: Pick<SandboxLister, "list"> = {
      list: () => ({ nextItems: async () => { throw new Error("network down"); } })
    };
    const verdict = await verifyNestedGrantIsolation({
      apiKey: "e2b_nested",
      operatorSandboxId: "sbx_operator",
      lister
    });
    expect(verdict.isolated).toBe(false);
  });

  it("sweeps only the granted project, and reports what it reclaimed", async () => {
    const { lister, listedWith, killed } = fakeLister({
      e2b_nested: ["sbx_a", "sbx_b"],
      e2b_operator: ["sbx_operator"]
    });
    const swept = await sweepNestedSandboxes({ apiKey: "e2b_nested", lister });
    expect(swept).toEqual({ found: 2, killed: 2 });
    expect(killed).toEqual(["sbx_a", "sbx_b"]);
    expect(listedWith).toEqual(["e2b_nested"]);
    expect(killed).not.toContain("sbx_operator");
  });

  it("refuses to sweep with no key rather than falling back to the operator's project", async () => {
    const { lister, listedWith, killed } = fakeLister({ e2b_operator: ["sbx_operator"] });
    const swept = await sweepNestedSandboxes({ apiKey: "  ", lister });
    expect(swept.error).toContain("refused to sweep");
    // The dangerous path: an SDK call with no apiKey reads process.env and kills the operator's own.
    expect(listedWith).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("counts a sandbox it could not kill as found-but-not-killed", async () => {
    const lister: SandboxLister = {
      list: () => ({ nextItems: async () => [{ sandboxId: "sbx_a" }, { sandboxId: "sbx_b" }] }),
      connect: async (id) => {
        if (id === "sbx_b") throw new Error("already gone");
        return { kill: async () => undefined };
      }
    };
    const swept = await sweepNestedSandboxes({ apiKey: "e2b_nested", lister });
    expect(swept).toEqual({ found: 2, killed: 1 });
  });
});
