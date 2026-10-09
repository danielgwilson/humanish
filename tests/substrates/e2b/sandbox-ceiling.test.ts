// E2B ends a sandbox after 1 hour on its Hobby plan and 24 hours on Pro, and its API does not say
// which plan a key is on. HUMANISH_E2B_MAX_SANDBOX_MINUTES says it (60 when unset), and every
// planner that derives a sandbox deadline reads that one ceiling.

import { describe, expect, it } from "vitest";

import { doctor } from "../../../src/cli/doctor.js";
import { parseStudy } from "../../../src/study/config.js";
import { planStudy } from "../../../src/study/plan.js";
import type { PlanResult, StudyPlan } from "../../../src/study/plan-types.js";
import type { StudyConfig } from "../../../src/study/types.js";
import { sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";
import { lab, type BaseName, type Patch } from "../../admission/fixtures.js";

const SETTING = "HUMANISH_E2B_MAX_SANDBOX_MINUTES";
const minutes = (value: number) => value * 60_000;

function study(base: BaseName, patch: Patch): StudyConfig {
  const parsed = parseStudy(lab(base, patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function plan(config: StudyConfig, env: Record<string, string>): PlanResult {
  return planStudy(config, { cwd: process.cwd(), dryRun: false, env });
}

function planned(result: PlanResult): StudyPlan {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  return result.planned.plan;
}

// A 50-minute session on a clone subject: 50m + 30m provisioning + 10m teardown buffer = 90m.
const cloneStudy = () => study("cuClone", { execution: { timeoutMs: minutes(50) } });
// caps.maxMinutes 79: 6m setup + 79m + 5m teardown buffer = 90m.
const terminalStudy = () =>
  study("terminal", { mode: "live", caps: { maxUsd: 0, maxMinutes: 79 } });

describe("a study whose sandbox deadline is 90 minutes", () => {
  it("is refused at the default ceiling, with the setting that raises it", () => {
    const refused = plan(cloneStudy(), {});
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("HUMANISH_COMPUTER_USE_SUBJECT_INVALID");
    expect(refused.refusal.message).toContain("derives a 90m sandbox deadline");
    expect(refused.refusal.message).toContain("may not live longer than 60m");
    expect(refused.refusal.message).toContain(`set ${SETTING} to 90 or more`);
  });

  it("is planned when the setting raises the ceiling to 90 minutes", () => {
    const plan90 = planned(plan(cloneStudy(), { [SETTING]: "90" }));
    expect(plan90.route === "computer-use" && plan90.sandboxMs).toBe(minutes(90));
  });

  it("is refused and then planned the same way on the terminal route", () => {
    const refused = plan(terminalStudy(), {});
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("HUMANISH_TERMINAL_CAPS_INVALID");
    expect(refused.refusal.message).toContain("may not live longer than 60m");
    expect(refused.refusal.message).toContain(`set ${SETTING} to 90 or more`);
    expect(plan(terminalStudy(), { [SETTING]: "1440" }).ok).toBe(true);
  });

  it("names no setting when no E2B plan allows the deadline", () => {
    const refused = plan(study("cuClone", { execution: { timeoutMs: minutes(1420) } }), {
      [SETTING]: "1440",
    });
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.message).toContain("derives a 1460m sandbox deadline");
    expect(refused.refusal.message).not.toContain("or more");
  });
});

describe("the default session budget a provisioned route derives", () => {
  // Three 5-minute seed steps: 60m - 30m provisioning - 15m seeding - 10m buffer leaves 5m.
  const seeded = {
    subject: {
      state: {
        seed: [
          { name: "migrate", command: "pnpm db:migrate" },
          { name: "seed", command: "pnpm db:seed" },
          { name: "index", command: "pnpm db:index" },
        ],
      },
    },
  };

  it("grows on the computer-use route when the ceiling is raised", () => {
    const config = study("cuClone", { ...seeded, execution: { timeoutMs: undefined } });
    const atDefault = planned(plan(config, {}));
    const raised = planned(plan(config, { [SETTING]: "1440" }));
    expect(atDefault.route === "computer-use" && atDefault.sessionBudgetMs).toBe(minutes(5));
    // The app-url default, 30 minutes, caps the derived budget.
    expect(raised.route === "computer-use" && raised.sessionBudgetMs).toBe(minutes(30));
  });

  it("grows on the shared-world route when the ceiling is raised", () => {
    const config = study("sharedProvisioned", { ...seeded, execution: { timeoutMs: undefined } });
    const atDefault = planned(plan(config, {}));
    const raised = planned(plan(config, { [SETTING]: "1440" }));
    expect(atDefault.route === "shared-world" && atDefault.sessionTimeoutMs).toBe(minutes(5));
    // The shared-world derivation caps a participant's session at 15 minutes.
    expect(raised.route === "shared-world" && raised.sessionTimeoutMs).toBe(minutes(15));
  });

  it("is refused on the shared-world route when the seed steps leave no session under the ceiling", () => {
    // A fourth seed step: 5m floor + 30m provisioning + 20m seeding + 10m buffer = 65m.
    const seed = [...seeded.subject.state.seed, { name: "cache", command: "pnpm cache:warm" }];
    const config = study("sharedProvisioned", {
      subject: { state: { seed } },
      execution: { timeoutMs: undefined },
    });
    const refused = plan(config, {});
    if (refused.ok) throw new Error("expected a refusal");
    expect(refused.refusal.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(refused.refusal.message).toContain("derives a 65m deadline for the subject sandbox");
    expect(refused.refusal.message).toContain("shorten subject.state.seed[].timeoutMs");
    expect(refused.refusal.message).toContain(`set ${SETTING} to 65 or more`);
    expect(plan(config, { [SETTING]: "65" }).ok).toBe(true);
  });
});

describe("the ceiling setting", () => {
  it("is 60 minutes when unset or blank", () => {
    expect(sandboxCeiling({})).toEqual({ ok: true, ms: minutes(60), source: "default" });
    expect(sandboxCeiling({ [SETTING]: " " })).toEqual({
      ok: true,
      ms: minutes(60),
      source: "default",
    });
  });

  it("takes a whole number of minutes from 1 to 1440", () => {
    expect(sandboxCeiling({ [SETTING]: "1440" })).toEqual({
      ok: true,
      ms: minutes(1440),
      source: "setting",
    });
    expect(sandboxCeiling({ [SETTING]: " 30 " })).toEqual({
      ok: true,
      ms: minutes(30),
      source: "setting",
    });
  });

  it.each(["0", "1441", "90m", "1.5", "-5", "one hour"])("refuses %j", (value) => {
    const ceiling = sandboxCeiling({ [SETTING]: value });
    if (ceiling.ok) throw new Error("expected a refusal");
    expect(ceiling.message).toContain(SETTING);
    expect(ceiling.message).toContain("1 to 1440");
  });

  it("refuses every E2B route's plan when it is not a number of minutes", () => {
    const env = { [SETTING]: "24h" };
    const results = [
      plan(cloneStudy(), env),
      plan(terminalStudy(), env),
      plan(study("sharedProvisioned", {}), env),
      plan(study("scriptedClone", {}), env),
      // A scripted app-url study runs a browser on this machine and creates no E2B sandbox.
      plan(study("scriptedAppUrl", {}), env),
    ];
    expect(results.map((result) => (result.ok ? "planned" : result.refusal.code))).toEqual([
      "HUMANISH_COMPUTER_USE_SUBJECT_INVALID",
      "HUMANISH_TERMINAL_CAPS_INVALID",
      "HUMANISH_SHARED_WORLD_INVALID",
      "HUMANISH_SCRIPTED_SUBJECT_INVALID",
      "planned",
    ]);
  });
});

describe("doctor's sandbox ceiling row", () => {
  // The suite's own env keeps the home directory and strict keys, and the key probe never runs gh.
  const row = async (setting: Record<string, string>) =>
    (
      await doctor(process.cwd(), {
        env: { ...process.env, ...setting },
        keyDeps: { execText: async () => null },
      })
    ).checks.find((check) => check.name === "e2b sandbox ceiling");

  it("shows the default and the setting that raises it", async () => {
    const atDefault = await row({});
    expect(atDefault?.ok).toBe(true);
    expect(atDefault?.message).toContain("60 minutes");
    expect(atDefault?.message).toContain(SETTING);
  });

  it("shows a raised ceiling and where it came from", async () => {
    const raised = await row({ [SETTING]: "1440" });
    expect(raised?.ok).toBe(true);
    expect(raised?.message).toContain(`1440 minutes, from ${SETTING}`);
  });

  it("fails on a value it cannot read", async () => {
    const bad = await row({ [SETTING]: "24h" });
    expect(bad?.ok).toBe(false);
    expect(bad?.message).toContain("1 to 1440");
  });
});
