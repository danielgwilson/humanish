import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CuaLoopResult } from "../../src/actors/computer-use/loop.js";
import { writeAnalysisExecutionReceipt } from "../../src/analysis/store-executions.js";
import { digestAnalysisInput } from "../../src/analysis/validation.js";
import { buildSingleParticipantBundle } from "../../src/routes/computer-use/single-bundle.js";
import { buildRunSource, type RunCostSummary } from "../../src/run/bundle.js";
import { verdictForStatus } from "../../src/run/judge.js";
import { bindExistingRunArtifactPaths } from "../../src/run/paths.js";
import {
  RUN_STATUS_FILE,
  RUN_STATUS_SCHEMA,
  runStatusOutcome,
  type RunStatusRecord,
} from "../../src/run/status.js";
import { syntheticArtifact, syntheticInput } from "../analysis/fixtures.js";
import { rawScreenshotActorTrace } from "./local-only-run.js";

// Two synthetic live runs priced like the 0.108.0 try-live smoke: participant tokens with no
// dollar price, $0.016123 of desktop time, then analysis on the OpenAI API key. One run has one
// analysis; the other has two attempts, the second of which failed after it was billed. Every
// surface that shows one run's cost is pinned on these two runs.

export const ONE_ANALYSIS_RUN = "cost-one-analysis";
export const TWO_ATTEMPTS_RUN = "cost-two-attempts";
export const FIXTURE_STUDY = "cost-fixture";

const SUBTOTAL: RunCostSummary = {
  schema: "humanish.run-cost-summary.v1",
  currency: "usd",
  estimatedTotalUsd: 0.016123,
  ratesAsOf: "2026-09-05",
  fullyEstimated: false,
  placeholder: false,
  breakdown: [
    {
      kind: "model-tokens",
      laneId: "lane-01",
      modelId: "synthetic-model",
      estimatedCostUsd: null,
      reason: "no_rate_for_model",
      ratesAsOf: null,
    },
    {
      kind: "desktop-minutes",
      laneId: "lane-01",
      estimatedCostUsd: 0.016123,
      ratesAsOf: "2026-09-05",
      source: "e2b.dev/pricing",
    },
  ],
  tokenUsage: {},
  desktopMinutes: 1.815683,
  note: "Estimated 0.016123 USD total (a lower bound: some lines are unmeasured or unpriced).",
};

async function writeRun(cwd: string, runId: string, createdAt: string): Promise<void> {
  const trace = rawScreenshotActorTrace();
  const session: CuaLoopResult = {
    status: trace.status,
    completionReason: trace.completionReason,
    reason: trace.reason,
    trace,
  };
  const bundle = buildSingleParticipantBundle({
    verdict: verdictForStatus(session.status),
    actorId: "openai-computer-use",
    appUrl: "http://127.0.0.1:3000/",
    run: { runId, mode: "live", createdAt },
    dryRun: false,
    studyId: FIXTURE_STUDY,
    mission: "Add two tables, then say what you did.",
    persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "digest" },
    resolution: [1440, 960],
    screenshots: [],
    session,
    traceArtifactPath: "actor.json",
    desktopMinutes: 1,
    source: await buildRunSource({ cwd, humanishSource: "present", packageName: "humanish" }),
  });
  bundle.cost = structuredClone(SUBTOTAL);
  const runDir = path.join(cwd, ".humanish", "runs", runId);
  await mkdir(runDir, { recursive: true });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path.join(runDir, "run.json"), json(bundle), "utf8");
  await writeFile(path.join(runDir, "review.json"), json(bundle.review), "utf8");
  await writeFile(path.join(runDir, "review.md"), `# ${bundle.scenario.title}\n`, "utf8");
  await writeFile(
    path.join(runDir, "events.ndjson"),
    `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
  await writeFile(path.join(runDir, "actor.json"), json(trace), "utf8");
  // The status record the run index reads first, with the outcome a published run writes.
  const completedAt = new Date(Date.parse(createdAt) + 120_000).toISOString();
  const status: RunStatusRecord = {
    schema: RUN_STATUS_SCHEMA,
    runId,
    state: "finished",
    mode: "live",
    study: { id: FIXTURE_STUDY },
    pid: 1,
    startedAt: createdAt,
    updatedAt: completedAt,
    completedAt,
    outcome: runStatusOutcome(bundle),
  };
  await writeFile(path.join(runDir, RUN_STATUS_FILE), json(status), "utf8");
}

async function writeAnalysis(
  cwd: string,
  runId: string,
  id: string,
  estimatedCostUsd: number,
  failed = false,
): Promise<void> {
  const input = syntheticInput();
  input.runId = runId;
  input.inputDigest = digestAnalysisInput(input);
  const artifact = syntheticArtifact(input, id);
  artifact.provider = "openai";
  artifact.usage = {
    ...artifact.usage,
    estimatedCostUsd,
    ratesAsOf: "2026-09-03",
    usageComplete: true,
    dispatched: true,
  };
  await writeAnalysisExecutionReceipt(
    await bindExistingRunArtifactPaths(cwd, runId),
    failed
      ? { ...artifact, status: "failed", result: null, error: "analysis_validation_failed" }
      : artifact,
  );
}

/** Rewrite a run's status record as one written before 0.109, without `estimatedCostComplete`. */
export async function writePre109Status(cwd: string, runId: string): Promise<void> {
  const file = path.join(cwd, ".humanish", "runs", runId, RUN_STATUS_FILE);
  const record = JSON.parse(await readFile(file, "utf8")) as RunStatusRecord;
  delete record.outcome?.estimatedCostComplete;
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** A project directory holding both runs; the caller removes it. */
export async function writeRunCostFixtures(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "humanish-run-cost-"));
  const cwd = path.join(root, "minimal-app");
  await cp(path.resolve(import.meta.dirname, "../../fixtures/minimal-app"), cwd, {
    recursive: true,
  });
  await writeRun(cwd, ONE_ANALYSIS_RUN, "2026-10-03T06:00:32.105Z");
  await writeAnalysis(cwd, ONE_ANALYSIS_RUN, "analysis-one", 0.529005);
  await writeRun(cwd, TWO_ATTEMPTS_RUN, "2026-10-03T06:04:55.467Z");
  await writeAnalysis(cwd, TWO_ATTEMPTS_RUN, "analysis-first", 0.529005);
  await writeAnalysis(cwd, TWO_ATTEMPTS_RUN, "analysis-retry", 0.514091, true);
  return cwd;
}
