import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  BRAINS,
  canStartAnalysis,
  canStartParticipant,
  capThatFits,
  participantBoundUsd,
  planRuns,
  projectBrain,
  type BudgetSettings,
} from "../../bench/lib/plan.js";
import { studyYaml } from "../../bench/lib/project.js";
import { summaryMarkdown, wilson95, type BenchResult } from "../../bench/lib/report.js";
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
    expect(canStartAnalysis(2.25, budget())).toBe(true);
    expect(canStartAnalysis(2.26, budget())).toBe(false);
    expect(canStartAnalysis(0, budget({ analysis: false }))).toBe(false);
    expect(canStartAnalysis(2.5, budget(), 1.5)).toBe(true);
    expect(canStartAnalysis(2.5, budget(), 3)).toBe(false);
  });

  it("leaves an unpriced participant's model spend out of its bound", () => {
    const priced = participantBoundUsd(BRAINS["openai-computer-use"], budget());
    const unpriced = participantBoundUsd(BRAINS["local-agent-claude"], budget());
    expect(priced - unpriced).toBeCloseTo(0.6);
  });

  it("fits the default plan of three runs per arm with analysis under the default $7 cap", () => {
    const brain = BRAINS["openai-computer-use"];
    const defaults = budget({ maxUsdPerBrain: 7 });
    expect(projectBrain(brain, 6, defaults)).toMatchObject({ participantsFit: 6, analysesFit: 6 });
    const six = projectBrain(brain, 6, budget({ maxUsdPerBrain: 6 }));
    expect([six.participantsFit, six.analysesFit]).toEqual([6, 5]);
    expect(capThatFits(brain, 6, budget({ maxUsdPerBrain: 6 }))).toBe(7);
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
