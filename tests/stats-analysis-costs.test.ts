import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeStats, formatStatsHuman } from "../src/stats.js";
import { bindExistingRunArtifactPaths } from "../src/run-paths.js";
import { beginStudyAnalysisExecution, writeStudyAnalysisExecutionReceipt } from "../src/study-analysis-store.js";
import { claimAutomaticStudyAnalysis } from "../src/study-analysis-job.js";
import { digestStudyAnalysisInput, hashStudyAnalysisValue } from "../src/study-analysis-validation.js";
import { syntheticArtifact, syntheticInput } from "./study-analysis-fixtures.js";
import { writeFixtureRun } from "./helpers/run-fixtures.js";
import type { StudyAnalysisArtifact } from "../src/study-analysis.js";

describe("retained study cost accounting", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-costs-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(cwd, { recursive: true, force: true }); });

  async function study(id = "study-a", labId = "sample-lab", startedAt = "2026-09-01T10:00:00Z") {
    const dir = await writeFixtureRun(cwd, { runId: id, labId, mode: "live", state: "finished", startedAt, estimatedCostUsd: 0.25 });
    const file = path.join(dir, "run.json");
    const bundle = JSON.parse(await readFile(file, "utf8"));
    bundle.cost = { estimatedTotalUsd: 0.25, fullyEstimated: true };
    await writeFile(file, JSON.stringify(bundle));
    return bindExistingRunArtifactPaths(cwd, id);
  }
  function artifact(runId: string, id: string, amount: number | null = 0.5): StudyAnalysisArtifact {
    const input = syntheticInput(); input.runId = runId; input.inputDigest = digestStudyAnalysisInput(input);
    const result = syntheticArtifact(input, id);
    result.usage.estimatedCostUsd = amount;
    result.usage.ratesAsOf = amount === null ? null : "2026-09-01";
    return result;
  }
  async function stats() {
    const result = await computeStats(cwd);
    if (!result.ok) throw new Error(result.error.message);
    return result;
  }

  it("adds every distinct attempt once across receipt/report duplicates, failed attempts and reruns", async () => {
    const prepared = await study();
    const first = artifact("study-a", "analysis-a", 0.5);
    await writeStudyAnalysisExecutionReceipt(prepared, first);
    await mkdir(path.join(prepared.physicalRunRoot, "analysis", first.id), { recursive: true });
    await writeFile(path.join(prepared.physicalRunRoot, "analysis", first.id, "analysis.json"), JSON.stringify(first));
    await writeStudyAnalysisExecutionReceipt(prepared, { ...artifact("study-a", "analysis-b", 0.75),
      status: "failed", result: null, error: "analysis_validation_failed" });
    const result = await stats();
    expect(result.schema).toBe("humanish.stats.v1");
    expect(result.totals.estimatedSpendUsd).toBe(0.25);
    expect(result.totals.costs).toMatchObject({ estimatedTotalUsd: 1.5, runEstimatedUsd: 0.25,
      analysisEstimatedUsd: 1.25, analysisAttempts: 2, analysisDispatchedAttempts: 2, analysisUnpricedAttempts: 0 });
    expect(result.labs[0]?.costs).toEqual(result.totals.costs);
    expect(result.days[0]?.costs).toEqual(result.totals.costs);
    expect(formatStatsHuman(result)).toContain("known estimated spend: $1.50");
  });

  it("uses legacy report accounting even when the source and findings are stale, and labels the missing receipt", async () => {
    const prepared = await study();
    const old = artifact("study-a", "old-analysis", 0.4);
    await mkdir(path.join(prepared.physicalRunRoot, "analysis", old.id), { recursive: true });
    await writeFile(path.join(prepared.physicalRunRoot, "analysis", old.id, "analysis.json"), JSON.stringify({ ...old, result: { obsolete: true } }));
    const result = await stats();
    expect(result.totals.costs).toMatchObject({ estimatedTotalUsd: 0.65, analysisAttempts: 1, analysisHistoryUncertainRuns: 1 });
    expect(result.costsByRun[0]?.warnings).toContain("ANALYSIS_LEGACY_REPORT_ACCOUNTING");
  });

  it("distinguishes unpriced dispatch, unresolved dispatch and confirmed no-dispatch cancellation", async () => {
    const prepared = await study();
    const missing = artifact("study-a", "unknown-usage", null);
    missing.usage = { ...missing.usage, usageComplete: false, inputTokens: null, outputTokens: null };
    await writeStudyAnalysisExecutionReceipt(prepared, { ...missing, status: "failed", result: null, error: "analysis_provider_failed" });
    const stopped = artifact("study-a", "before-transport", null);
    stopped.usage = { ...missing.usage, dispatched: false };
    await writeStudyAnalysisExecutionReceipt(prepared, { ...stopped, status: "cancelled", result: null, error: "analysis_cancelled" });
    const pending = artifact("study-a", "unfinished");
    const { id, runId, sourceRunSha256, inputDigest, configDigest, promptVersion } = pending;
    const finalize = await beginStudyAnalysisExecution(prepared, { id, runId, sourceRunSha256, inputDigest, configDigest, promptVersion });
    expect((await stats()).totals.costs).toMatchObject({ analysisAttempts: 3, analysisDispatchedAttempts: 1,
      analysisNotDispatchedAttempts: 1, analysisUnpricedAttempts: 2, analysisUnresolvedAttempts: 1, analysisEstimatedUsd: 0 });
    await finalize(pending);
    expect((await stats()).totals.costs).toMatchObject({ analysisAttempts: 3, analysisDispatchedAttempts: 2,
      analysisUnpricedAttempts: 1, analysisUnresolvedAttempts: 0, analysisEstimatedUsd: 0.5 });
    await expect(finalize(pending)).rejects.toThrow();
  });

  it("does not count automatic reuse as a new attempt, but retains a started job without final usage", async () => {
    const prepared = await study();
    const first = artifact("study-a", "prior-analysis", 0.3);
    await writeStudyAnalysisExecutionReceipt(prepared, first);
    const job = await claimAutomaticStudyAnalysis(prepared, { configDigest: first.configDigest, promptVersion: first.promptVersion });
    await job!.update({ state: "complete", reason: "AUTOMATIC_ANALYSIS_REUSED", analysisId: first.id });
    expect((await stats()).totals.costs).toMatchObject({ analysisAttempts: 1, analysisEstimatedUsd: 0.3 });
    const other = await study("study-b");
    const interrupted = await claimAutomaticStudyAnalysis(other, { configDigest: first.configDigest, promptVersion: first.promptVersion });
    await interrupted!.update({ state: "running", startedAt: new Date().toISOString() });
    expect((await stats()).totals.costs).toMatchObject({ analysisAttempts: 2, analysisUnresolvedAttempts: 1, analysisUnpricedAttempts: 1 });
  });

  it.each(["queued", "skipped", "unknown"] as const)("does not invent free analysis from an automatic %s job without accounting", async (state) => {
    const prepared = await study();
    const first = artifact("study-a", "configuration-only");
    const job = await claimAutomaticStudyAnalysis(prepared, { configDigest: first.configDigest, promptVersion: first.promptVersion });
    if (state === "skipped") await job!.update({ state, reason: "AUTOMATIC_ANALYSIS_KEY_MISSING" });
    if (state === "unknown") await job!.update({ state, reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" });
    const result = await stats();
    expect(result.totals.costs).toMatchObject({ analysisAttempts: 0, analysisEstimatedUsd: null, analysisHistoryUncertainRuns: 1 });
    expect(result.costsByRun[0]?.warnings).toContain("ANALYSIS_HISTORY_NOT_RECORDED");
  });

  it("keeps absent, malformed, empty and conflicting history uncertain rather than inventing zero", async () => {
    const prepared = await study();
    expect((await stats()).totals.costs).toMatchObject({ analysisEstimatedUsd: null, analysisHistoryUncertainRuns: 1 });
    await mkdir(path.join(prepared.physicalRunRoot, "analysis-attempts", "unpublished"), { recursive: true });
    await writeFile(path.join(prepared.physicalRunRoot, "analysis-attempts", "unpublished", "receipt.json"), "broken");
    const result = await stats();
    expect(result.totals.costs).toMatchObject({ analysisEstimatedUsd: null, analysisAttempts: 1,
      analysisUnresolvedAttempts: 1, analysisUnpricedAttempts: 1, analysisHistoryUncertainRuns: 1 });
    expect(result.costsByRun[0]?.warnings).toContain("ANALYSIS_ACCOUNTING_INVALID");
    const conflicting = artifact("study-a", "conflict");
    await writeStudyAnalysisExecutionReceipt(prepared, conflicting);
    await mkdir(path.join(prepared.physicalRunRoot, "analysis", conflicting.id), { recursive: true });
    await writeFile(path.join(prepared.physicalRunRoot, "analysis", conflicting.id, "analysis.json"),
      JSON.stringify({ ...conflicting, usage: { ...conflicting.usage, estimatedCostUsd: 9 } }));
    expect((await stats()).totals.costs).toMatchObject({ analysisEstimatedUsd: null, analysisUnresolvedAttempts: 2 });
  });

  it("filters by run date and lab while retaining later analysis reruns in that run's day", async () => {
    const early = await study("old-study", "old-lab", "2026-08-01T10:00:00Z");
    const recent = await study("new-study", "new-lab", "2026-09-01T10:00:00Z");
    await writeStudyAnalysisExecutionReceipt(early, artifact("old-study", "late-analysis", 10));
    await writeStudyAnalysisExecutionReceipt(recent, artifact("new-study", "new-analysis", 0.5));
    const byDate = await computeStats(cwd, { since: "2026-09-01" });
    const byLab = await computeStats(cwd, { lab: "new-lab" });
    expect(byDate.ok && byDate.totals.costs.estimatedTotalUsd).toBe(0.75);
    expect(byLab.ok && byLab.totals.costs.estimatedTotalUsd).toBe(0.75);
    expect((await stats()).days[0]).toMatchObject({ day: "2026-08-01", costs: { estimatedTotalUsd: 10.25 } });
  });

  it("does not let a mismatched listing ID count another run's accounting twice", async () => {
    const first = await study("study-a");
    const second = await study("study-b");
    await writeStudyAnalysisExecutionReceipt(first, artifact("study-a", "analysis-a", 0.5));
    const statusFile = path.join(second.physicalRunRoot, "status.json");
    const status = JSON.parse(await readFile(statusFile, "utf8"));
    status.runId = "study-a";
    await writeFile(statusFile, JSON.stringify(status));
    const result = await stats();
    expect(result.totals.costs).toMatchObject({ estimatedTotalUsd: 1, analysisAttempts: 1 });
    expect(result.costsByRun.map((row) => row.runId).sort()).toEqual(["study-a", "study-b"]);
  });

  it("rejects oversized and cross-run receipt metadata while retaining the uncertainty", async () => {
    const prepared = await study();
    const original = artifact("study-a", "bad-receipt");
    await writeStudyAnalysisExecutionReceipt(prepared, original);
    const file = path.join(prepared.physicalRunRoot, "analysis-attempts", original.id, "receipt.json");
    const receipt = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...receipt, runId: "different-study" }));
    expect((await stats()).totals.costs).toMatchObject({ analysisEstimatedUsd: null, analysisUnpricedAttempts: 1 });
    await writeFile(file, " ".repeat(16 * 1024 + 1));
    expect((await stats()).totals.costs).toMatchObject({ analysisEstimatedUsd: null, analysisUnresolvedAttempts: 1 });
  });

  it("retains paid receipts when legacy source metadata is unreadable, without guessing filtered attribution", async () => {
    const prepared = await study();
    await writeStudyAnalysisExecutionReceipt(prepared, artifact("study-a", "kept-accounting", 0.5));
    await rm(path.join(prepared.physicalRunRoot, "status.json"));
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), "not valid JSON");
    const result = await stats();
    expect(result.unreadable).toEqual(["study-a"]);
    expect(result.totals.costs).toMatchObject({ estimatedTotalUsd: 0.5, runEstimatedUsd: null,
      analysisEstimatedUsd: 0.5, analysisAttempts: 1, incompleteRunEstimates: 1 });
    expect(result.days[0]?.day).toBe("(undated)");
    expect(result.labs[0]?.lab).toBe("(no lab)");
    for (const options of [{ lab: "sample-lab" }, { since: "2026-09-01" }]) {
      const filtered = await computeStats(cwd, options);
      expect(filtered.ok && filtered.totals.runs).toBe(0);
      expect(filtered.ok && filtered.unreadable).toEqual(["study-a"]);
    }
  });

  it("does not treat a copied source bundle's mismatched identity as known run spend", async () => {
    const prepared = await study();
    const file = path.join(prepared.physicalRunRoot, "run.json");
    const bundle = JSON.parse(await readFile(file, "utf8"));
    bundle.runId = "different-study";
    await writeFile(file, JSON.stringify(bundle));
    const result = await stats();
    expect(result.totals.costs).toMatchObject({ estimatedTotalUsd: null, incompleteRunEstimates: 1 });
    expect(result.costsByRun[0]?.warnings).toContain("RUN_COST_ID_MISMATCH");
  });

  it("counts partial run estimates and rejects linked receipt storage without requests or writes", async () => {
    const prepared = await study();
    const file = path.join(prepared.physicalRunRoot, "run.json");
    const bundle = JSON.parse(await readFile(file, "utf8"));
    bundle.cost.fullyEstimated = false;
    await writeFile(file, JSON.stringify(bundle));
    await writeStudyAnalysisExecutionReceipt(prepared, artifact("study-a", "analysis-a", 0.5));
    expect((await stats()).totals.costs).toMatchObject({ estimatedTotalUsd: 0.75, incompleteRunEstimates: 1 });
    const receiptPath = path.join(prepared.physicalRunRoot, "analysis-attempts", "analysis-a", "receipt.json");
    const outside = path.join(cwd, "outside.json");
    await writeFile(outside, await readFile(receiptPath)); await rm(receiptPath); await symlink(outside, receiptPath);
    const before = await readdir(prepared.physicalRunRoot, { recursive: true });
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not request"));
    const result = await stats();
    expect(result.totals.costs).toMatchObject({ analysisEstimatedUsd: null, analysisHistoryUncertainRuns: 1 });
    expect(await readdir(prepared.physicalRunRoot, { recursive: true })).toEqual(before);
    expect(fetch).not.toHaveBeenCalled();
    expect(hashStudyAnalysisValue(await readFile(outside))).toBe(hashStudyAnalysisValue(await readFile(receiptPath)));
  });
});
