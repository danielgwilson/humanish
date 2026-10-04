import { describe, expect, it } from "vitest";

import { planTerminalStudy } from "../../../src/routes/terminal/plan.js";
import {
  terminalPreExecBudgetMs,
  terminalSandboxTimeoutMs,
} from "../../../src/routes/terminal/lifetime.js";
import { terminalConfig } from "../../helpers/terminal-live-fake.js";

const minutes = (value: number) => value * 60_000;

describe("the terminal sandbox's lifetime", () => {
  it("covers the steps before the codex command, its wall clock and the teardown buffer", () => {
    // Node bootstrap 5m + runtime version check 1m, plus product setup 5m when declared.
    expect(terminalPreExecBudgetMs(false)).toBe(minutes(6));
    expect(terminalPreExecBudgetMs(true)).toBe(minutes(11));
    // ...then maxMinutes, then the 5m teardown buffer.
    expect(terminalSandboxTimeoutMs({ maxMinutes: 10, productInstall: false })).toBe(minutes(21));
    expect(terminalSandboxTimeoutMs({ maxMinutes: 10, productInstall: true })).toBe(minutes(26));
  });

  // E2B refuses a sandbox over one hour, so the plan refuses the first maxMinutes past it.
  it.each([
    [false, 49],
    [true, 44],
  ])("with product setup %s, plans maxMinutes %i and refuses one more", (install, largest) => {
    const planWith = (maxMinutes: number) => {
      const config = terminalConfig({
        scenario: { mode: "live", caps: { maxUsd: 0, maxJobs: 0, maxMinutes } },
      });
      if (install) config.subject.product!.install = "synthetic-product-install --yes";
      return planTerminalStudy(config, { dryRun: false });
    };
    expect(planWith(largest).ok).toBe(true);
    const refused = planWith(largest + 1);
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("HUMANISH_TERMINAL_CAPS_INVALID");
    expect(refused.refusal.message).toContain(
      `caps.maxMinutes ${largest + 1} derives a 61m sandbox deadline`,
    );
    expect(refused.refusal.message).toContain("may not live longer than 60m");
    expect(refused.refusal.message).toContain(`to at most ${largest}.`);
  });
});
