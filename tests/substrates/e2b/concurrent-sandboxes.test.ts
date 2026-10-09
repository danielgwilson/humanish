// E2B runs 20 sandboxes at once on its Hobby plan and 100 on Pro, and its API does not say which
// plan a key is on. HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES says it (20 when unset).

import { describe, expect, it } from "vitest";

import { doctor } from "../../../src/cli/doctor.js";
import { concurrentSandboxes } from "../../../src/substrates/e2b/lifetime.js";

const SETTING = "HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES";

describe("the concurrent sandboxes setting", () => {
  it("is 20 when unset or blank", () => {
    expect(concurrentSandboxes({})).toEqual({ ok: true, count: 20, source: "default" });
    expect(concurrentSandboxes({ [SETTING]: "  " })).toEqual({
      ok: true,
      count: 20,
      source: "default",
    });
  });

  it("takes a whole number of sandboxes", () => {
    expect(concurrentSandboxes({ [SETTING]: "100" })).toEqual({
      ok: true,
      count: 100,
      source: "setting",
    });
    expect(concurrentSandboxes({ [SETTING]: " 1100 " })).toEqual({
      ok: true,
      count: 1100,
      source: "setting",
    });
  });

  it.each(["0", "-5", "1.5", "100x", "lots", "1000001"])("refuses %j", (value) => {
    const limit = concurrentSandboxes({ [SETTING]: value });
    if (limit.ok) throw new Error("expected a refusal");
    expect(limit.message).toContain(SETTING);
    expect(limit.message).toContain("20 on Hobby, 100 on Pro");
  });
});

describe("doctor's concurrent sandboxes row", () => {
  // The suite's own env keeps the home directory and strict keys, and the key probe never runs gh.
  const row = async (setting: Record<string, string>) =>
    (
      await doctor(process.cwd(), {
        env: { ...process.env, ...setting },
        keyDeps: { execText: async () => null },
      })
    ).checks.find((check) => check.name === "e2b concurrent sandboxes");

  it("shows the default and the setting that raises it", async () => {
    const atDefault = await row({});
    expect(atDefault?.ok).toBe(true);
    expect(atDefault?.message).toContain("20 at once, E2B's Hobby limit");
    expect(atDefault?.message).toContain(SETTING);
  });

  it("shows a raised limit and where it came from", async () => {
    const raised = await row({ [SETTING]: "100" });
    expect(raised?.ok).toBe(true);
    expect(raised?.message).toContain(`100 at once, from ${SETTING}`);
  });

  it("fails on a value it cannot read", async () => {
    const bad = await row({ [SETTING]: "lots" });
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toContain("whole number");
  });
});
