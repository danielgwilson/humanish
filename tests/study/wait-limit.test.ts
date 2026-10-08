import { describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { forwardDeclaredWarnings, inertFieldPaths } from "../../src/study/warnings.js";
import { libraryConfig } from "../helpers/library-config.js";
import {
  computerUseParticipants,
  sharedWorldParticipants,
} from "../../src/study/plan-participants.js";
import { lab, type BaseName } from "../admission/fixtures.js";

const parsed = (base: BaseName, maxWaitMs: unknown) => parseStudy(lab(base, {}, { maxWaitMs }));

describe("actor.maxWaitMs", () => {
  it.each([1_000, 45_000, 120_000, 600_000])(
    "plans %s ms as each computer-use participant's longest wait",
    (maxWaitMs) => {
      const result = parsed("cuAppUrl", maxWaitMs);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.config.actor?.maxWaitMs).toBe(maxWaitMs);
      expect(
        computerUseParticipants(result.config, 2).map((each) => each.limits.maxWaitMs),
      ).toEqual([maxWaitMs, maxWaitMs]);
    },
  );

  it("plans the longest wait for each shared-world participant", () => {
    const result = parsed("sharedProvisioned", 90_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const roster = sharedWorldParticipants(result.config);
    expect(roster.participants.map((each) => each.limits.maxWaitMs)).toEqual([90_000, 90_000]);
  });

  it("leaves the limit unplanned when the study does not set it", () => {
    const result = parseStudy(lab("cuAppUrl"));
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(computerUseParticipants(result.config)[0]?.limits).not.toHaveProperty("maxWaitMs");
  });

  it.each([0, 999, 600_001, 1.5, -1, Number.NaN, Infinity, null, "60000"])(
    "refuses %s",
    (maxWaitMs) => {
      const result = parsed("cuAppUrl", maxWaitMs);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain("actor.maxWaitMs");
    },
  );

  it.each<BaseName>(["terminal", "scriptedAppUrl", "preview"])(
    "refuses it on %s, whose participants take no wait actions, as a field the route does not read",
    (base) => {
      const result = parsed(base, 60_000);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/does not read actor\.maxWaitMs/);
    },
  );

  it("is reported as having no effect to a library caller on a route without waits", () => {
    const config = libraryConfig(lab("terminal", {}, { maxWaitMs: 60_000 }));
    expect(inertFieldPaths(config)).toEqual(["actor.maxWaitMs"]);
    expect(forwardDeclaredWarnings(config).join("\n")).toMatch(/actor\.maxWaitMs/);
    expect(inertFieldPaths(libraryConfig(lab("cuAppUrl", {}, { maxWaitMs: 60_000 })))).toEqual([]);
  });

  it("is not a participant entry field", () => {
    const result = parseStudy(
      lab("cuAppUrl", { participants: [{ id: "one", maxWaitMs: 60_000 }] }),
    );
    expect(result.ok).toBe(false);
  });
});
