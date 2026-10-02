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

import { readAutomaticAnalysis } from "../../src/analysis/automatic.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import { analyzeRun, showAnalysis } from "../../src/analysis/service.js";
import type { AnalysisConfig } from "../../src/analysis/types.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { readRunDetail } from "../../src/run/detail.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { syntheticResult } from "./fixtures.js";

const runId = "physical-cwd-entry";
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

// The analyze entry points bind the physical project before resolving the run, as the routes do
// (#1012). An alias retargeted mid-analyze must not abort the analysis or reach the other project.
describe("analysis entry points given a symlinked project", () => {
  let base: string;
  let original: string;
  let decoy: string;
  let alias: string;

  beforeEach(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-entry-"));
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
    await cp(original, decoy, { recursive: true });
    await symlink(original, alias);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(base, { recursive: true, force: true });
  });

  async function retargetAlias(): Promise<void> {
    await unlink(alias);
    await symlink(decoy, alias);
  }

  async function decoyRunEntries(): Promise<string[]> {
    return (await readdir(path.join(decoy, ".humanish", "runs", runId))).sort();
  }

  it("finishes an analysis in the original project when the alias moves mid-request", async () => {
    const decoyBefore = await decoyRunEntries();
    const prepared = (await resolveRunPath(original, runId))!;
    const source = await readFile(path.join(prepared.physicalRunRoot, "run.json"));
    const input = await captureEvidence(prepared, source);
    const wire = JSON.parse(await readFile(wirePath, "utf8"));
    wire.output[0].content[0].text = JSON.stringify(syntheticResult(input));
    const fetch = vi.fn<AnalysisFetch>(async () => {
      await retargetAlias();
      return new Response(JSON.stringify(wire));
    });

    const result = await analyzeRun(alias, runId, { config }, { apiKey: "synthetic-key", fetch });
    expect(result.error).toBeUndefined();
    expect(result.analysisId).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(1);

    const shown = await showAnalysis(original, runId);
    expect(shown.analysis?.id).toBe(result.analysisId);
    expect(await decoyRunEntries()).toEqual(decoyBefore);
  });

  it("reads the original project's run through an alias", async () => {
    const viaAlias = await readRunDetail(alias, runId);
    const viaPhysical = await readRunDetail(original, runId);
    expect(viaAlias).toEqual(viaPhysical);
    expect(await readAutomaticAnalysis(alias, runId)).toEqual(
      await readAutomaticAnalysis(original, runId),
    );
  });
});
