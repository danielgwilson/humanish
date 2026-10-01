import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readAutomaticStudyAnalysisPrepared,
  claimAutomaticStudyAnalysis,
} from "../../src/analysis/job.js";
import { analyzeStudy } from "../../src/analysis/service.js";
import {
  listStudyAnalyses,
  loadStudyAnalysisRecord,
  readStudyAnalysisVersion,
  writeStudyAnalysis,
} from "../../src/analysis/store.js";
import {
  listStudyAnalysisExecutions,
  writeStudyAnalysisExecutionReceipt,
} from "../../src/analysis/store-executions.js";
import { captureStudyEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import type { AnalysisConfig } from "../../src/analysis/study-analysis.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import type { PreparedRunArtifactPaths } from "../../src/run/paths.js";
import { syntheticArtifact, syntheticResult } from "./fixtures.js";

const runId = "physical-project-study";
const config: AnalysisConfig = {
  model: "gpt-5.6-sol",
  question: null,
  maxCostUsd: 5,
  timeoutMs: 2000,
  maxOutputTokens: 8192,
};
const wirePath = new URL(
  "../fixtures/openai-closing-report/typed-closing-report.json",
  import.meta.url,
);

// A run prepared through a symlinked project keeps its logical absoluteRunRoot under the alias, and
// analysis storage derives its project from the prepared paths. Retargeting the alias at another
// project holding the same run ID must never read or write that project: the alias-bound handle
// fails its identity check, and a handle bound to the physical project keeps working.
describe("analysis storage in a symlinked project", () => {
  let base: string;
  let original: string;
  let decoy: string;
  let alias: string;
  let viaAlias: PreparedRunArtifactPaths;
  let viaPhysical: PreparedRunArtifactPaths;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-physical-"));
    original = path.join(base, "original");
    decoy = path.join(base, "decoy");
    alias = path.join(base, "alias");
    await mkdir(original);
    await cp(path.resolve("fixtures/minimal-app"), original, { recursive: true });
    await runDryRun({ cwd: original, dryRun: true, runId });
    const root = path.join(original, ".humanish", "runs", runId);
    const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
    bundle.mode = "live";
    bundle.streams[0]!.status = "complete";
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle) + "\n");
    await rm(path.join(root, "status.json"));
    // The decoy holds the same run, byte for byte, and no analysis records.
    await cp(original, decoy, { recursive: true });
    await symlink(original, alias);
    viaAlias = (await resolveRunPath(alias, runId))!;
    viaPhysical = (await resolveRunPath(original, runId))!;
    expect(viaAlias.absoluteRunRoot).toBe(path.join(alias, ".humanish", "runs", runId));
    expect(viaAlias.physicalRunRoot).toBe(viaPhysical.physicalRunRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  async function retargetAlias(): Promise<void> {
    await unlink(alias);
    await symlink(decoy, alias);
  }

  async function snapshot(prepared: PreparedRunArtifactPaths, analysisId: string) {
    const versions = await listStudyAnalyses(prepared);
    return {
      versions: versions.map((entry) => [entry.id, entry.state]),
      version: (await readStudyAnalysisVersion(prepared, analysisId))?.state ?? null,
      loaded: (await loadStudyAnalysisRecord(prepared)).state,
      receipts: (await listStudyAnalysisExecutions(prepared)).receipts.length,
      job: (await readAutomaticStudyAnalysisPrepared(prepared))?.state ?? null,
    };
  }

  async function decoyRunEntries(): Promise<string[]> {
    return (await readdir(path.join(decoy, ".humanish", "runs", runId))).sort();
  }

  it("keeps store and job records in the bound project after the alias moves", async () => {
    const decoyBefore = await decoyRunEntries();
    const source = await readFile(path.join(viaAlias.physicalRunRoot, "run.json"));
    const artifact = syntheticArtifact(await captureStudyEvidence(viaAlias, source));
    await writeStudyAnalysisExecutionReceipt(viaAlias, artifact);
    await writeStudyAnalysis(viaAlias, artifact);
    expect(
      await claimAutomaticStudyAnalysis(viaAlias, {
        configDigest: "a".repeat(64),
        promptVersion: "synthetic-v1",
      }),
    ).not.toBeNull();

    const expected = {
      versions: [[artifact.id, "ready"]],
      version: "ready",
      loaded: "ready",
      receipts: 1,
      job: "queued",
    };
    expect(await snapshot(viaAlias, artifact.id)).toEqual(expected);
    expect(await snapshot(viaPhysical, artifact.id)).toEqual(expected);

    await retargetAlias();
    expect(await snapshot(viaAlias, artifact.id)).toMatchObject({
      version: null,
      loaded: "invalid",
      receipts: 0,
      job: "unknown",
    });
    expect(await snapshot(viaPhysical, artifact.id)).toEqual(expected);
    expect(await decoyRunEntries()).toEqual(decoyBefore);
  });

  it("refuses the alias-bound run and publishes the physical one after the alias moves", async () => {
    const decoyBefore = await decoyRunEntries();
    const source = await readFile(path.join(viaAlias.physicalRunRoot, "run.json"));
    const input = await captureStudyEvidence(viaAlias, source);
    const wire = JSON.parse(await readFile(wirePath, "utf8"));
    wire.output[0].content[0].text = JSON.stringify(syntheticResult(input));
    const fetch = vi.fn<AnalysisFetch>(async () => new Response(JSON.stringify(wire)));
    const deps = { apiKey: "synthetic-key", fetch };

    await retargetAlias();
    const refused = await analyzeStudy(
      original,
      runId,
      { config },
      { ...deps, expectedRun: viaAlias },
    );
    expect(refused.error?.code).toBe("ANALYSIS_SOURCE_CHANGED");
    expect(fetch).not.toHaveBeenCalled();

    const result = await analyzeStudy(
      original,
      runId,
      { config },
      { ...deps, expectedRun: viaPhysical },
    );
    expect(result.analysisId).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);
    const loaded = await loadStudyAnalysisRecord(viaPhysical);
    expect(loaded.analysis?.id).toBe(result.analysisId);
    expect((await listStudyAnalysisExecutions(viaPhysical)).receipts).toHaveLength(1);
    expect(await decoyRunEntries()).toEqual(decoyBefore);
  });
});
