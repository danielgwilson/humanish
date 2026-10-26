import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  BRAINS,
  analysisCostFor,
  canStartAnalysis,
  canStartParticipant,
  capThatFits,
  participantBoundUsd,
  planRuns,
  projectAnalyses,
  projectBrain,
  SpendLedger,
  parseParticipant,
  withParticipant,
  type BudgetSettings,
} from "../../bench/lib/plan.js";
import { studyYaml } from "../../bench/lib/project.js";
import { summaryMarkdown, type BenchResult } from "../../bench/lib/report.js";
import { wilson95 } from "../../bench/lib/summary.js";
import { MISSIONS } from "../../bench/taskly/missions.js";
import { CONTRAST, docProse } from "../../scripts/lib/doc-prose.mjs";
import { EM_DASH } from "../../scripts/lib/prose-rules.mjs";

const budget = (overrides: Partial<BudgetSettings> = {}): BudgetSettings => ({
  maxUsdPerBrain: 4,
  participantCapUsd: 0.6,
  analysisMaxUsd: 1.75,
  worstCaseDesktopMinutes: 50,
  analysis: true,
  ...overrides,
});

describe("the benchmark missions", () => {
  it("keeps the walked mission identical to the committed detection studies", () => {
    for (const arm of ["planted", "clean"]) {
      const study = parse(readFileSync(`humanish/studies/detect-taskly-${arm}.yaml`, "utf8")) as {
        actor: { mission: string };
      };
      expect(study.actor.mission).toBe(MISSIONS.walked.text);
    }
  });

  it("names no feature a planted defect sits on in the neutral mission", () => {
    expect(MISSIONS.neutral.text).not.toMatch(
      /filter|renam|long|tidy|complete|clear|edit|save|empty|undefined/i,
    );
  });
});

describe("the generated benchmark studies", () => {
  it("keep the arm out of every field and send the mission unchanged", () => {
    for (const arm of ["planted", "clean"] as const) {
      const text = studyYaml(BRAINS["openai-computer-use"], arm, MISSIONS.neutral, 0.6);
      expect(text).not.toMatch(/planted|clean/i);
      const study = parse(text) as {
        actor: { mission: string; type: string };
        caps: { maxUsd: number };
        review: { analysis: boolean };
      };
      expect(study.actor.mission).toBe(MISSIONS.neutral.text);
      expect(study.caps.maxUsd).toBe(0.6);
      expect(study.review.analysis).toBe(false);
    }
  });

  it("sends a declared participant model, effort and service tier to the study", () => {
    const brain = withParticipant(
      BRAINS["openai-computer-use"],
      parseParticipant("gpt-6.1-sol@low", "fast"),
    );
    const study = parse(studyYaml(brain, "planted", MISSIONS.neutral, 0.6)) as {
      actor: Record<string, unknown>;
    };
    expect(study.actor).toMatchObject({
      type: "openai-computer-use",
      model: "gpt-6.1-sol",
      reasoningEffort: "low",
      serviceTier: "fast",
    });
  });

  it("runs any listed participant model on its vendor through the computer-use brain", () => {
    const brain = withParticipant(
      BRAINS["computer-use"],
      parseParticipant("claude-haiku-5-5@medium"),
    );
    const study = parse(studyYaml(brain, "planted", MISSIONS.neutral, 0.6)) as {
      actor: Record<string, unknown>;
    };
    expect(study.actor).toMatchObject({
      type: "computer-use",
      model: "claude-haiku-5-5",
      reasoningEffort: "medium",
    });
  });

  it("refuses a model or effort the study would refuse", () => {
    expect(() =>
      withParticipant(BRAINS["openai-computer-use"], parseParticipant("claude-haiku-5-5")),
    ).toThrow(/Set actor\.type: computer-use/);
    expect(() =>
      withParticipant(BRAINS["computer-use"], parseParticipant("claude-haiku-5-5@none")),
    ).toThrow(/not a level claude-haiku-5-5 accepts/);
    expect(() =>
      withParticipant(BRAINS["computer-use"], parseParticipant("claude-sonnet-9")),
    ).toThrow(/not a participant model humanish lists/);
  });

  it("names the persona file the project copies", () => {
    const study = parse(
      studyYaml(BRAINS["openai-computer-use"], "clean", MISSIONS.neutral, 0.6, "keyboard-tester"),
    ) as { actor: { persona: string } };
    expect(study.actor.persona).toBe("keyboard-tester");
  });

  it("refuses a participant setting the brain cannot send", () => {
    expect(() =>
      withParticipant(BRAINS["local-agent-codex"], parseParticipant("gpt-6.1-sol")),
    ).toThrow(/computer-use brains/);
    expect(() => parseParticipant("gpt-6.1-sol@quick")).toThrow(/effort/);
    expect(() => parseParticipant("gpt-6.1-sol", "turbo")).toThrow(/fast/);
  });

  it("gives an unpriced local agent no dollar cap", () => {
    const study = parse(
      studyYaml(BRAINS["local-agent-codex"], "planted", MISSIONS.walked, 0.6),
    ) as {
      actor: { type: string; localAgent: string };
      caps?: unknown;
    };
    expect(study.actor).toMatchObject({ type: "local-agent", localAgent: "codex" });
    expect(study.caps).toBeUndefined();
  });
});

describe("the benchmark budget", () => {
  it("interleaves planted and clean runs for each brain", () => {
    expect(planRuns(["openai-computer-use"], 2).map((run) => `${run.arm}${run.index}`)).toEqual([
      "planted1",
      "clean1",
      "planted2",
      "clean2",
    ]);
  });

  it("starts a step only when its worst case fits under the cap", () => {
    const brain = BRAINS["openai-computer-use"];
    const bound = participantBoundUsd(brain, budget());
    expect(canStartParticipant(4 - bound, brain, budget())).toBe(true);
    expect(canStartParticipant(4 - bound + 0.01, brain, budget())).toBe(false);
    expect(canStartAnalysis(2.25, budget(), 1.75)).toBe(true);
    expect(canStartAnalysis(2.26, budget(), 1.75)).toBe(false);
    expect(canStartAnalysis(0, budget({ analysis: false }), 1.75)).toBe(false);
    expect(canStartAnalysis(2.5, budget(), 1.5)).toBe(true);
  });

  it("counts an analysis at its worst case when that is above its $1.75 cap", () => {
    expect(canStartAnalysis(1.9, budget(), 2.1)).toBe(true);
    expect(canStartAnalysis(2, budget(), 2.1)).toBe(false);
  });

  it("leaves an unpriced participant's model spend out of its bound", () => {
    const priced = participantBoundUsd(BRAINS["openai-computer-use"], budget());
    const unpriced = participantBoundUsd(BRAINS["local-agent-claude"], budget());
    expect(priced - unpriced).toBeCloseTo(0.6);
  });

  it("fits the default plan of three runs per arm with the default analyst under the default $7 cap", () => {
    const brain = BRAINS["openai-computer-use"];
    expect(projectBrain(brain, 6, budget({ maxUsdPerBrain: 7 }))).toMatchObject({
      participantsFit: 6,
      analysesFit: 6,
      typicalUsd: 1.98,
    });
    // Each run is $0.27 of typical participant and desktop spend and a $0.06 analysis. The sixth
    // run starts after $1.65 only if its $1.044 bound fits, so $2.50 stops at five and $3 fits six.
    const tight = projectBrain(brain, 6, budget({ maxUsdPerBrain: 2.5 }));
    expect([tight.participantsFit, tight.analysesFit]).toEqual([5, 5]);
    expect(capThatFits(brain, 6, budget({ maxUsdPerBrain: 2.5 }))).toBe(3);
  });
});

describe("the analysis model projection", () => {
  it("prices gpt-6-astra at the recorded typical spend and worst case", () => {
    expect(analysisCostFor("gpt-6-astra")).toEqual({ typicalUsd: 0.7, worstCaseUsd: 1.26 });
  });

  it("prices the default analyst, gpt-6.1-sol at medium, at its recorded typical spend", () => {
    // $0.059 mean over 24 Taskly analyses on 2026-10-22. The worst case is gpt-6-astra's scaled
    // by rate: 35,531 in at $2.50 and 16,384 out at $10 is $0.2526, so $1.26 * 0.2526 / 1.2633.
    expect(analysisCostFor("gpt-6.1-sol", "medium")).toEqual({
      typicalUsd: 0.06,
      worstCaseUsd: 0.252,
    });
    // With no recorded spend at high, the typical spend scales from gpt-6-astra at high:
    // 40,060 in at $2 and 7,613 out at $10 is $0.1563, so $0.70 * 0.1563 / 0.7813.
    expect(analysisCostFor("gpt-6.1-sol")).toEqual({ typicalUsd: 0.14, worstCaseUsd: 0.252 });
  });

  it("prices another model at its own rates on the same token counts", () => {
    // gpt-5.6-luna bills $0.20 in, $0.25 for a cache write and $1.20 out per million tokens:
    // 40,060 in and 7,613 out is $0.0171, and 35,531 in at $0.25 with 16,384 out is $0.0285.
    // gpt-6-astra bills those $0.7813 and $1.2633, recorded as $0.70 and $1.26.
    const luna = analysisCostFor("gpt-5.6-luna");
    expect(luna?.typicalUsd).toBeCloseTo(0.0154, 4);
    expect(luna?.worstCaseUsd).toBeCloseTo(0.0285, 4);
  });

  it("has no projection for a model this checkout cannot price", () => {
    expect(analysisCostFor("gemini-3.8-flash-unpriced")).toBeNull();
  });

  it("starts each analysis only when its worst case fits the model's cap", () => {
    const astra = { typicalUsd: 0.7, worstCaseUsd: 1.26 };
    // The sixth analysis starts after $3.50 at typical spend; at worst case, after $6.30 it cannot.
    expect(projectAnalyses(Array(6).fill(astra), 7)).toEqual({
      analyses: 6,
      fit: 6,
      typicalUsd: 4.2,
      worstCaseFit: 5,
      worstCaseUsd: 6.3,
      capThatFits: 5,
    });
    expect(projectAnalyses(Array(6).fill(astra), 4)).toMatchObject({ fit: 4, typicalUsd: 2.8 });
  });
});

describe("the spend ledger shared by concurrent analyses", () => {
  const capOf2 = budget({ maxUsdPerBrain: 2 });
  // The captured gpt-6-astra worst case is $1.351575; two of them need $2.70315.
  const worst = 1.351575;

  it("never lets two in-flight analyses together pass a cap that fits only one", async () => {
    const ledger = new SpendLedger(capOf2);
    expect(await ledger.reserve(worst)).toBe(true);
    let second: boolean | undefined;
    const pending = ledger.reserve(worst).then((started) => {
      second = started;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(second).toBeUndefined();
    ledger.settle(worst, 0.87955);
    await pending;
    // $0.87955 billed plus the next worst case is $2.231125, over $2.
    expect(second).toBe(false);
    expect(ledger.spentUsd).toBeCloseTo(0.87955, 4);
  });

  it("starts a waiting analysis once the one in flight settles below its worst case", async () => {
    const ledger = new SpendLedger(capOf2);
    await ledger.reserve(worst);
    const second = ledger.reserve(worst);
    ledger.settle(worst, 0.5);
    expect(await second).toBe(true);
  });

  it("decides reservations in the order they were asked for", async () => {
    const ledger = new SpendLedger(budget({ maxUsdPerBrain: 1 }));
    await ledger.reserve(0.6);
    const order: string[] = [];
    const first = ledger.reserve(0.6).then((started) => order.push(`first ${started}`));
    const second = ledger.reserve(0.3).then((started) => order.push(`second ${started}`));
    ledger.settle(0.6, 0.6);
    await Promise.all([first, second]);
    expect(order).toEqual(["first false", "second true"]);
  });

  it("starts nothing when analysis is off", async () => {
    expect(await new SpendLedger(budget({ analysis: false })).reserve(0.01)).toBe(false);
  });
});

describe("the benchmark results", () => {
  it("reproduces the published Wilson interval for 58 of 60", () => {
    const [low, high] = wilson95(58, 60) ?? [0, 0];
    expect(low).toBeCloseTo(0.89, 2);
    expect(high).toBeCloseTo(0.99, 2);
  });

  it("writes a summary the evidence prose checks read as clean when model text carries tells", () => {
    const result = {
      createdAt: "2026-10-04T00:00:00.000Z",
      humanish: { version: "0.0.0", source: "a test" },
      rubric: { id: "taskly-rubric", version: 1, sha256: "x" },
      mission: { id: "neutral", sha256: "x", text: "x" },
      runsPerArm: 1,
      brains: [
        {
          brain: "openai-computer-use",
          participantModels: ["m"],
          analysis: {
            provider: "openai",
            model: "a",
            promptVersion: "p",
            maxCostUsd: 1,
            maxOutputTokens: 1,
          },
          stopped: null,
          spentUsd: { participant: 0, desktop: 0, analysis: 0, total: 0, unpricedRuns: 0 },
          runs: [
            {
              arm: "planted",
              index: 1,
              runId: "run-1",
              ok: true,
              error: null,
              costs: { participantUsd: 0, desktopUsd: 0, analysisUsd: 0, totalUsd: 0 },
              analysisState: "complete",
              cleanup: { checkState: "running", reclaimState: "clean" },
              participants: [
                {
                  streamId: "stream-001",
                  unresolved: ["it was cut off visually rather than wrapping — NOT great"],
                  invented: [],
                  harness: [],
                  falseAssurance: [],
                },
              ],
              analysis: {
                findings: [
                  { id: "F1", title: "Odd — behavior, not just clipping", verdict: "unresolved" },
                ],
              },
            },
          ],
          summary: {
            report: emptyStage(),
            analysis: emptyStage(),
          },
        },
      ],
    } as unknown as BenchResult;
    const summary = summaryMarkdown(result, "x.json");
    expect(summary).toMatch(/\| check running, reclaim clean \|/);
    const prose = docProse(summary);
    expect(prose.match(CONTRAST)).toBeNull();
    expect(prose.match(EM_DASH)).toBeNull();
    expect(prose).not.toMatch(/\bNOT\b/);
  });
});

function emptyStage(): unknown {
  const count = { hits: 0, of: 0 };
  return {
    plantedUnits: 0,
    cleanUnits: 0,
    recall: {
      D1: count,
      D2: count,
      D3: count,
      D4: count,
      D5: count,
      total: { ...count, wilson95: null },
    },
    d2Mechanism: { data_loss: 0, display: 0, ambiguous: 0, unspecified: 0 },
    falseAssurance: { claims: 0, unitsWith: 0 },
    invented: { planted: 0, clean: 0, unitsWith: 0 },
    harness: 0,
    unresolved: 0,
    supported: 0,
  };
}
