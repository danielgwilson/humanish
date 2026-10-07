import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { analyzeWithinBudget } from "../../bench/lib/analyze.js";
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
      spentUsd: 0.3,
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
