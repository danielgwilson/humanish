// A finished live run in a temp project, and its automatic analysis. The run is a dry-run bundle
// marked live, analyzed through the real service with a captured OpenAI wire envelope whose answer
// is the synthetic analysis result.
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";

import { runAutomaticAnalysis } from "../../src/analysis/automatic.js";
import { captureEvidence } from "../../src/analysis/evidence.js";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import type { RunBundle } from "../../src/run/bundle.js";
import { runDryRun } from "../../src/run/dry-run.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { syntheticResult } from "../analysis/fixtures.js";
import { makeTestTempDir } from "./temp-dir.js";

/** The id of the run both builders write. */
export const FINDINGS_RUN = "findings-run";

// Real captured wire envelope; only the synthetic analysis answer is replaced.
// Provenance: fixtures/openai-closing-report/README.md.
const wirePath = new URL(
  "../fixtures/openai-closing-report/typed-closing-report.json",
  import.meta.url,
);

/** A finished live run with one completed stream, not yet analyzed. */
export async function liveRun() {
  const cwd = await makeTestTempDir("humanish-review-findings-");
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: FINDINGS_RUN });
  const runRoot = path.join(cwd, ".humanish", "runs", FINDINGS_RUN);
  const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
  bundle.mode = "live";
  bundle.streams[0]!.status = "complete";
  await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
  await rm(path.join(runRoot, "status.json"), { force: true });
  return { cwd, runRoot };
}

/** A finished live run with one completed stream and the automatic analysis of it. */
export async function analyzedRun() {
  const { cwd, runRoot } = await liveRun();
  const input = await captureEvidence(
    (await resolveRunPath(cwd, FINDINGS_RUN))!,
    await readFile(path.join(runRoot, "run.json")),
  );
  const wire = JSON.parse(await readFile(wirePath, "utf8"));
  wire.output[0].content[0].text = JSON.stringify(syntheticResult(input));
  const fetch = vi.fn<AnalysisFetch>(async () => new Response(JSON.stringify(wire)));
  const outcome = await runAutomaticAnalysis(
    cwd,
    FINDINGS_RUN,
    { model: "gpt-5.6-sol", question: null, maxCostUsd: 5, timeoutMs: 1000, maxOutputTokens: 8192 },
    { apiKey: "synthetic-key", fetch },
  );
  // The dry-run bundle's coverage is incomplete, so the analysis is partial; its findings are kept.
  expect(outcome.state).toBe("partial");
  return { cwd, outcome };
}
