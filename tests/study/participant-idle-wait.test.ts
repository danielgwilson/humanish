// A participant may wait longer or shorter than the others when its turn only waits:
// `participants[].idleWaitMs` over `actor.idleWaitMs`, in the range the actor field takes and no
// longer than an explicit `actor.maxWaitMs`. A support agent waiting through a long session waits
// a minute at a time while customers keep the 5-second default.

import { describe, expect, it } from "vitest";

import { parseStudy } from "../../src/study/config.js";
import { planStudy } from "../../src/study/plan.js";
import type { PlanResult } from "../../src/study/plan-types.js";
import type { StudyConfig } from "../../src/study/types.js";
import { lab, type Patch } from "../admission/fixtures.js";

function study(patch: Patch): StudyConfig {
  const parsed = parseStudy(lab("cuAppUrl", patch));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function parseRefusal(patch: Patch): string {
  const parsed = parseStudy(lab("cuAppUrl", patch));
  if (parsed.ok) throw new Error("expected a refusal");
  return parsed.error.message;
}

function plannedIdleWaits(result: PlanResult): [string, number | undefined][] {
  if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
  const { plan } = result.planned;
  if (plan.route !== "computer-use") throw new Error(plan.route);
  return plan.runner.participants.map((participant) => [
    participant.id,
    participant.limits.idleWaitMs,
  ]);
}

const plan = (config: StudyConfig) =>
  planStudy(config, { cwd: process.cwd(), dryRun: false, env: {} });

describe("a participant's own idle wait", () => {
  it("overrides actor.idleWaitMs for that participant and for each member of a group", () => {
    const desk = study({
      actor: { type: "openai-computer-use", idleWaitMs: 5_000 },
      participants: [
        { id: "support-agent", idleWaitMs: 60_000 },
        { id: "customer", count: 2, startAfterMs: 30_000 },
        { id: "support-lead", count: 2, idleWaitMs: 20_000 },
      ],
    });
    expect(plannedIdleWaits(plan(desk))).toEqual([
      ["support-agent", 60_000],
      ["customer-01", 5_000],
      ["customer-02", 5_000],
      ["support-lead-01", 20_000],
      ["support-lead-02", 20_000],
    ]);
  });

  it.each([
    ["shorter than a second", 999],
    ["longer than ten minutes", 600_001],
    ["fractional", 1_500.5],
  ])("refuses one %s, naming the field and its range", (_name, idleWaitMs) => {
    const message = parseRefusal({ participants: [{ id: "a" }, { id: "b", idleWaitMs }] });
    expect(message).toContain("participants[1].idleWaitMs");
    expect(message).toContain("1000 to 600000");
  });

  it("refuses one longer than an explicit actor.maxWaitMs, naming both", () => {
    const message = parseRefusal({
      actor: { type: "openai-computer-use", maxWaitMs: 30_000 },
      participants: [{ id: "a" }, { id: "b", idleWaitMs: 60_000 }],
    });
    expect(message).toContain("participants[1].idleWaitMs (60000)");
    expect(message).toContain("actor.maxWaitMs (30000)");
  });

  it("refuses one longer than actor.maxWaitMs for a library caller that skipped the parser", () => {
    const config = study({
      actor: { type: "openai-computer-use", maxWaitMs: 30_000 },
      participants: [{ id: "a" }, { id: "b" }],
    });
    const result = plan({
      ...config,
      participants: [{ id: "a" }, { id: "b", idleWaitMs: 60_000 }],
    });
    if (result.ok) throw new Error("expected a refusal");
    expect(result.refusal.message).toContain("participants[1].idleWaitMs");
  });
});
