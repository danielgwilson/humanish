import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { analyzeWithinBudget } from "../../bench/lib/analyze.js";
import type { AnalysisArtifact } from "../../bench/lib/bundle.js";
import type { runCli } from "../../bench/lib/humanish-cli.js";
import { parseAnalysisSpecs, runAnalysisMatrix } from "../../bench/lib/matrix.js";
import { SpendLedger } from "../../bench/lib/plan.js";
import { fixtureDigests } from "../../bench/lib/project.js";
import {
  buildResult,
  summaryMarkdown,
  type Manifest,
  type RunRecord,
} from "../../bench/lib/report.js";

it("reports a forced cost refusal separately and excludes it from recall", async () => {
  const budget = {
    maxUsdPerBrain: 7,
    participantCapUsd: 0.6,
    analysisMaxUsd: 1.75,
    worstCaseDesktopMinutes: 50,
    analysis: true,
  };
  let dispatched = false;
  const refused = await analyzeWithinBudget(
    {
      runId: "run-refused",
      ledger: new SpendLedger(budget, 0.3),
      budget,
      cliPath: "unused",
      projectDir: "unused",
      logFile: "unused",
      analyzeNodeArgs: [],
    },
    async (_cli, args) => {
      if (!args.includes("--dry-run")) dispatched = true;
      expect(args).toEqual(expect.arrayContaining(["--max-cost", "1.75"]));
      return {
        code: 1,
        timedOut: false,
        json: {
          ok: false,
          admission: { estimatedCostUsd: 1.81 },
          error: { code: "analysis_budget_exceeded" },
        },
      };
    },
  );
  expect(dispatched).toBe(false);
  expect(refused.chargeUsd).toBe(0);
  const record = (runId: string, index: number, analysis: RunRecord["analysis"]): RunRecord => ({
    brain: "openai-computer-use",
    arm: "planted",
    index,
    studyId: "bench-planted",
    runId,
    ok: true,
    error: null,
    startedAt: "2026-10-07T00:00:00Z",
    finishedAt: "2026-10-07T00:01:00Z",
    analysis,
    cleanup: null,
  });
  const manifest: Manifest = {
    schema: "humanish.bench-manifest.v1",
    createdAt: "2026-10-07T00:00:00Z",
    humanish: { version: "0.0.0", source: "synthetic test" },
    mission: "neutral",
    brains: ["openai-computer-use"],
    runsPerArm: 2,
    budget,
    fixture: fixtureDigests(),
    stopped: {},
    runs: [
      record("run-complete", 1, {
        state: "complete",
        analysisId: "analysis-test",
        estimatedUsd: 0.7,
        admissionUsd: 1.5,
        error: null,
      }),
      record("run-refused", 2, refused.analysis),
    ],
  };
  const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-report-"));
  try {
    for (const run of manifest.runs) {
      const root = path.join(project, ".humanish", "runs", run.runId ?? "");
      const analysisDir = path.join(root, "analysis", "analysis-test");
      mkdirSync(analysisDir, { recursive: true });
      writeFileSync(path.join(root, "run.json"), JSON.stringify({ runId: run.runId, streams: [] }));
      writeFileSync(
        path.join(analysisDir, "analysis.json"),
        JSON.stringify({
          id: "analysis-test",
          runId: run.runId,
          status: "complete",
          result: { summary: "", findings: [] },
        }),
      );
    }
    const result = buildResult(project, manifest);
    const brain = result.brains[0];
    expect(brain?.summary.analysis.recall.total).toMatchObject({ hits: 0, of: 5 });
    expect(brain?.runs[1]).toMatchObject({
      analysis: null,
      analysisRefusal: {
        reason: "refused by cost cap",
        admissionUsd: 1.81,
        maxCostUsd: 1.75,
        excludedFromRecall: true,
      },
    });
    expect(summaryMarkdown(result, "result.json")).toContain(
      "planted 2 (run-refused): refused by cost cap (estimate $1.81, cap $1.75); excluded from analysis recall",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

it("scores a recorded run against the localStorage builds the manifest names", () => {
  const manifest: Manifest = {
    schema: "humanish.bench-manifest.v1",
    createdAt: "2026-10-25T00:00:00Z",
    humanish: { version: "0.0.0", source: "synthetic test" },
    mission: "neutral",
    brains: ["openai-computer-use"],
    runsPerArm: 1,
    budget: {
      maxUsdPerBrain: 7,
      participantCapUsd: 0.6,
      analysisMaxUsd: 1.75,
      worstCaseDesktopMinutes: 50,
      analysis: false,
    },
    fixture: fixtureDigests(undefined, "local"),
    storage: "local",
    stopped: {},
    runs: [
      {
        brain: "openai-computer-use",
        arm: "clean",
        index: 1,
        studyId: "bench-taskly-b-openai-computer-use",
        runId: "run-local",
        ok: true,
        error: null,
        startedAt: "2026-10-25T00:00:00Z",
        finishedAt: "2026-10-25T00:01:00Z",
        analysis: {
          state: "skipped_disabled",
          analysisId: null,
          estimatedUsd: null,
          admissionUsd: null,
          error: null,
        },
        cleanup: null,
      },
    ],
  };
  const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-local-"));
  try {
    const root = path.join(project, ".humanish", "runs", "run-local");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      path.join(root, "run.json"),
      JSON.stringify({
        runId: "run-local",
        streams: [
          {
            id: "stream-001",
            actor: { reason: "Refreshing the page erased the entire list.", items: [] },
          },
        ],
      }),
    );
    const result = buildResult(project, manifest);
    expect(result.fixture.id).toBe("taskly-local");
    expect(
      result.brains[0]?.runs[0]?.participants[0]?.invented.map((match) => match.classId),
    ).toEqual(["B10"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

const FIXTURES = path.resolve("tests/fixtures/bench/taskly");
// The six neutral-mission runs of 2026-10-04 and their gpt-6-astra analyses. labels.json scores
// the analyses by hand: on the four planted runs, 18 of 20 defects listed (D1 and D2 each missed
// once), and one unresolved finding.
const RECORDED: [string, "planted" | "clean"][] = [
  ["cua-2026-10-04T05-49-54-857Z-3cb1f7da", "planted"],
  ["cua-2026-10-04T05-55-40-025Z-51c265a8", "planted"],
  ["cua-2026-10-04T07-41-06-204Z-6fe3644b", "planted"],
  ["cua-2026-10-04T07-45-29-153Z-dfe76827", "clean"],
  ["cua-2026-10-04T07-48-50-754Z-aed935c7", "planted"],
  ["cua-2026-10-04T07-53-03-078Z-ae5787d0", "clean"],
];

/**
 * The CLI at the process seam. Its dry run admits gpt-6-astra and gpt-5.6-luna and refuses the
 * gemini provider, as humanish 0.141.0 does. Its analysis saves a new version of the run's
 * recorded gpt-6-astra analysis under the requested model; gpt-5.6-luna keeps only the first finding.
 */
function analyzingCli(project: string): typeof runCli {
  let made = 0;
  return async (_cli, args) => {
    const at = (name: string): string => args[args.indexOf(name) + 1] ?? "";
    if (args.includes("--provider") && at("--provider") === "gemini") {
      return {
        code: 2,
        timedOut: false,
        json: { ok: false, error: { code: "ANALYSIS_CONFIG_INVALID" } },
      };
    }
    if (args.includes("--dry-run")) {
      return {
        code: 0,
        timedOut: false,
        json: {
          ok: true,
          admission: { estimatedCostUsd: 0.5, admittedCostUsd: 0.55, worstCaseCostUsd: 0.6 },
        },
      };
    }
    const runId = at("--run");
    const model = at("--model");
    const recorded = JSON.parse(
      readFileSync(path.join(FIXTURES, "analyses", `${runId}.json`), "utf8"),
    ) as AnalysisArtifact & { completedAt?: string };
    const id = `analysis-${++made}`;
    const artifact = {
      ...recorded,
      id,
      completedAt: new Date(Date.UTC(2026, 9, 21, 0, made)).toISOString(),
      config: { ...recorded.config, model },
      result: recorded.result && {
        ...recorded.result,
        findings:
          model === "gpt-5.6-luna"
            ? recorded.result.findings.slice(0, 1)
            : recorded.result.findings,
      },
    };
    const dir = path.join(project, ".humanish", "runs", runId, "analysis", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "analysis.json"), JSON.stringify(artifact));
    const billed = model === "gpt-5.6-luna" ? 0.02 : 0.7;
    return {
      code: 0,
      timedOut: false,
      json: { ok: true, analysisId: id, usage: { estimatedCostUsd: billed, dispatched: true } },
    };
  };
}

it("scores each analysis model's own analysis of the same recorded runs", async () => {
  const project = mkdtempSync(path.join(os.tmpdir(), "humanish-bench-models-"));
  try {
    const runs: RunRecord[] = RECORDED.map(([runId, arm], index) => {
      const root = path.join(project, ".humanish", "runs", runId);
      mkdirSync(root, { recursive: true });
      copyFileSync(path.join(FIXTURES, "runs", `${runId}.json`), path.join(root, "run.json"));
      return {
        brain: "openai-computer-use",
        arm,
        index: index + 1,
        studyId: "bench-study",
        runId,
        ok: true,
        error: null,
        startedAt: "2026-10-04T00:00:00Z",
        finishedAt: "2026-10-04T00:05:00Z",
        analysis: {
          state: "skipped_disabled",
          analysisId: null,
          estimatedUsd: null,
          admissionUsd: null,
          error: null,
        },
        cleanup: null,
      };
    });
    const budget = {
      maxUsdPerBrain: 7,
      participantCapUsd: 0.6,
      analysisMaxUsd: 7,
      analysisAutoCap: true,
      worstCaseDesktopMinutes: 50,
      analysis: true,
    };
    const manifest: Manifest = {
      schema: "humanish.bench-manifest.v1",
      createdAt: "2026-10-21T00:00:00Z",
      humanish: { version: "0.0.0", source: "synthetic test" },
      mission: "neutral",
      brains: ["openai-computer-use"],
      runsPerArm: 3,
      budget: { ...budget, analysis: false },
      fixture: fixtureDigests(),
      stopped: {},
      runs,
    };
    await runAnalysisMatrix(
      manifest,
      {
        specs: parseAnalysisSpecs("gpt-6-astra,gpt-5.6-luna,gemini:gemini-3.8-flash"),
        repeats: 1,
        concurrency: 4,
        budget,
        cliPath: "unused-cli",
        cliVersion: "0.0.0",
        projectDir: project,
        logFile: path.join(project, "cli.log"),
        analyzeNodeArgs: [],
        onRecord: () => {},
        stopped: () => false,
      },
      analyzingCli(project),
    );
    const result = buildResult(project, manifest);
    const models = result.brains[0]?.analysisModels ?? [];
    expect(
      models.map((model) => [
        model.spec,
        model.model,
        model.summary.plantedUnits,
        model.summary.cleanUnits,
      ]),
    ).toEqual([
      ["gpt-6-astra", "gpt-6-astra", 4, 2],
      ["gpt-5.6-luna", "gpt-5.6-luna", 4, 2],
      ["gemini:gemini-3.8-flash", null, 0, 0],
    ]);
    const [astra, luna, gemini] = models;
    expect(astra?.summary.recall).toMatchObject({
      D1: { hits: 3, of: 4 },
      D2: { hits: 3, of: 4 },
      D3: { hits: 4, of: 4 },
      D4: { hits: 4, of: 4 },
      D5: { hits: 4, of: 4 },
      total: { hits: 18, of: 20 },
    });
    expect(astra?.summary.unresolved).toBe(1);
    // The first finding of each planted analysis lists D3 twice and no defect twice.
    expect(luna?.summary.recall.total).toMatchObject({ hits: 2, of: 20 });
    expect(astra?.spentUsd).toEqual({ total: 4.2, perAnalysis: 0.7, unpriced: 0 });
    expect(astra?.wallMs.total).toBeGreaterThanOrEqual(0);
    expect(luna?.spentUsd.total).toBeCloseTo(0.12, 6);
    expect(gemini?.states).toEqual({ refused: 6 });
    expect(gemini?.summary.recall.total).toMatchObject({ hits: 0, of: 0 });
    expect(result.brains[0]?.summary.analysis.plantedUnits).toBe(0);
    const summary = summaryMarkdown(result, "result.json");
    expect(summary).toMatch(
      /\| Recall, all defects \| 18\/20 \(95% interval 0\.70 to 0\.97\) \| 2\/20 /,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
