import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/program.js";
import { analyzeStudy, correctStudyAnalysis, showStudyAnalysis, withStudyAnalysisLock } from "../src/study-analysis-service.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import { listStudyAnalyses, listStudyAnalysisExecutions, writeStudyAnalysis } from "../src/study-analysis-store.js";
import { draftFeedback, renderIssueUrl } from "../src/feedback.js";
import { exportRun } from "../src/export.js";
import { renderObserver, serveObserver } from "../src/observer.js";
import { resolveRunPath, runDryRun, verifyRun, type RunBundle } from "../src/run.js";
import type { StudyAnalysisConfig, StudyAnalysisInput } from "../src/study-analysis.js";
import { syntheticArtifact, syntheticResult } from "./study-analysis-fixtures.js";

const config: StudyAnalysisConfig = { model: "gpt-5.6-sol", question: null, maxCostUsd: 5, timeoutMs: 1000, maxOutputTokens: 8192 };
// Real captured wire envelope; only the synthetic analysis answer is replaced.
// Provenance: fixtures/openai-closing-report/README.md.
const wirePath = new URL("./fixtures/openai-closing-report/typed-closing-report.json", import.meta.url);

describe("ordinary study analysis flow", () => {
  let cwd: string;
  let runRoot: string;
  let input: StudyAnalysisInput;
  let original: Buffer;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-analysis-flow-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: "analysis-flow" });
    runRoot = path.join(cwd, ".humanish/runs/analysis-flow");
    const bundle = JSON.parse(await readFile(path.join(runRoot, "run.json"), "utf8")) as RunBundle;
    // This is an explicitly synthetic completed legacy stream, not a live-provider claim.
    bundle.mode = "live";
    bundle.streams[0]!.status = "complete";
    await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle, null, 2) + "\n");
    await rm(path.join(runRoot, "status.json"), { force: true });
    original = await readFile(path.join(runRoot, "run.json"));
    const verified = await verifyRun(cwd, "analysis-flow");
    expect(verified.checks.filter((check) => !check.ok)).toEqual([]);
    input = await captureStudyEvidence((await resolveRunPath(cwd, "analysis-flow"))!, original);
  });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  async function transport() {
    const wire = JSON.parse(await readFile(wirePath, "utf8"));
    wire.output[0].content[0].text = JSON.stringify(syntheticResult(input));
    return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(wire)));
  }

  it("preflights a completed legacy stream without credentials, provider requests or artifacts", async () => {
    const fetch = await transport();
    const result = await analyzeStudy(cwd, "analysis-flow", { config, dryRun: true }, { apiKey: "", fetch });
    expect(result).toMatchObject({ ok: true, dryRun: true, admission: { allowed: true } });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(runRoot)).not.toContain("analysis");
    expect(await readdir(runRoot)).not.toContain(".analysis-lock");
    expect(await readFile(path.join(runRoot, "run.json"))).toEqual(original);
  });

  it("uses real admission, engine, storage and render paths; reopening does not dispatch again", async () => {
    const fetch = await transport();
    const result = await analyzeStudy(cwd, "analysis-flow", { config }, { apiKey: "synthetic-key", fetch });
    expect(result).toMatchObject({ ok: true, reused: false, status: "partial", usage: { dispatched: true } });
    expect(result.warnings).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const loaded = await showStudyAnalysis(cwd, "analysis-flow");
    expect(loaded).toMatchObject({ state: "ready", analysis: { id: result.analysisId, result: syntheticResult(input) } });
    const again = await analyzeStudy(cwd, "analysis-flow", { config }, { apiKey: "", fetch });
    expect(again).toMatchObject({ ok: true, reused: true, analysisId: result.analysisId });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(runRoot, "run.json"))).toEqual(original);
  });

  it("requires opt-in cost and refuses budget, dry-run source, active source and cancellation before dispatch", async () => {
    const fetch = await transport();
    expect((await analyzeStudy(cwd, "analysis-flow", { config: { ...config, maxCostUsd: NaN } }, { fetch })).error?.code).toBe("ANALYSIS_CONFIG_INVALID");
    expect((await analyzeStudy(cwd, "analysis-flow", { config: { ...config, maxCostUsd: 0.000001 } }, { fetch })).error?.code).toBe("analysis_budget_exceeded");
    expect((await analyzeStudy(cwd, "analysis-flow", { config }, { fetch, signal: AbortSignal.abort() })).error?.code).toBe("ANALYSIS_CANCELLED");
    const bundle = JSON.parse(original.toString()) as RunBundle;
    bundle.mode = "dry-run";
    await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle));
    expect((await analyzeStudy(cwd, "analysis-flow", { config }, { fetch })).error?.code).toBe("ANALYSIS_REQUIRES_LIVE_RUN");
    bundle.mode = "live"; bundle.streams[0]!.status = "running";
    await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle));
    expect((await analyzeStudy(cwd, "analysis-flow", { config }, { fetch })).error?.code).toBe("ANALYSIS_RUN_ACTIVE");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("admits one dispatch owner and never steals a stale lock", async () => {
    const prepared = (await resolveRunPath(cwd, "analysis-flow"))!;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const hold = new Promise<void>((done) => { release = done; });
    const first = withStudyAnalysisLock(prepared, async () => { entered(); await hold; });
    await started;
    const fetch = await transport();
    expect((await analyzeStudy(cwd, "analysis-flow", { config }, { fetch })).error?.code).toBe("ANALYSIS_BUSY");
    expect(fetch).not.toHaveBeenCalled();
    release(); await first;
    expect(await readdir(runRoot)).not.toContain(".analysis-lock");
    await mkdir(path.join(runRoot, ".analysis-lock"));
    expect((await analyzeStudy(cwd, "analysis-flow", { config }, { fetch })).error?.code).toBe("ANALYSIS_BUSY");
    expect(await readdir(runRoot)).toContain(".analysis-lock");
  });

  it("a failed attempt does not hide later valid findings or permanently block sharing", async () => {
    const fetch = await transport();
    const failed = await analyzeStudy(cwd, "analysis-flow", { config }, { apiKey: "synthetic-key",
      fetch: vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 503 })) });
    expect(failed).toMatchObject({ ok: false, status: "failed", usage: { dispatched: true } });
    const success = await analyzeStudy(cwd, "analysis-flow", { config }, { apiKey: "synthetic-key", fetch });
    expect(success.ok).toBe(true);
    expect((await showStudyAnalysis(cwd, "analysis-flow")).analysis?.id).toBe(success.analysisId);
    const verified = await verifyRun(cwd, "analysis-flow");
    expect(verified.shareSafety).toMatchObject({ status: "share_ready" });
    const exported = await exportRun(cwd, "analysis-flow");
    expect(exported.ok).toBe(true);
  });

  it("persists exact review history and drafts evidence-linked feedback without changing participant candidates", async () => {
    const result = await analyzeStudy(cwd, "analysis-flow", { config }, { apiKey: "synthetic-key", fetch: await transport() });
    expect(result.ok).toBe(true);
    const options = { analysis: result.analysisId!, finding: "finding-1" };
    const draft = await draftFeedback(cwd, "analysis-flow", options);
    expect(draft.ok).toBe(true);
    expect(draft.draft?.source_analysis).toMatchObject({ id: result.analysisId, finding_id: "finding-1" });
    const longClaim = "A narrower interpretation is supported by the retained evidence. ".repeat(12);
    await correctStudyAnalysis(cwd, "analysis-flow", { analysisId: result.analysisId!, findingId: "finding-1",
      status: "amended", reason: "The original claim was broader than the evidence.", replacementClaim: longClaim });
    const amended = await draftFeedback(cwd, "analysis-flow", options);
    expect(amended.draft?.actual).toContain(longClaim);
    expect(Array.from(amended.draft!.summary).length).toBeLessThanOrEqual(160);
    expect((await renderIssueUrl(cwd, "analysis-flow", "example/app", options)).ok).toBe(true);
    await correctStudyAnalysis(cwd, "analysis-flow", { analysisId: result.analysisId!, findingId: "finding-1",
      status: "dismissed", reason: "The fixture does not prove a product issue." });
    expect((await draftFeedback(cwd, "analysis-flow", options)).ok).toBe(false);
    expect((await showStudyAnalysis(cwd, "analysis-flow")).corrections).toHaveLength(2);
    expect(await readFile(path.join(runRoot, "run.json"))).toEqual(original);
  });

  it("retains paid accounting even when changed source prevents publication", async () => {
    const ordinary = await transport();
    const fetch = vi.fn<typeof globalThis.fetch>(async (...args) => {
      const bundle = JSON.parse(original.toString()) as RunBundle;
      bundle.scenario.goal = "Changed synthetic assignment.";
      await writeFile(path.join(runRoot, "run.json"), JSON.stringify(bundle));
      return ordinary(...args);
    });
    const result = await analyzeStudy(cwd, "analysis-flow", { config }, { apiKey: "synthetic-key", fetch });
    expect(result).toMatchObject({ ok: false, error: { code: "ANALYSIS_PUBLICATION_FAILED" },
      usage: { dispatched: true, inputTokens: 13543, outputTokens: 221 } });
    expect(result.executionReceiptPath).toBeTruthy();
    expect(result.artifactPath).toBeUndefined();
    const prepared = (await resolveRunPath(cwd, "analysis-flow"))!;
    expect(await listStudyAnalyses(prepared)).toEqual([]);
    expect((await listStudyAnalysisExecutions(prepared)).receipts).toMatchObject([{ id: result.analysisId, model: config.model,
      usage: { inputTokens: 13543, dispatched: true } }]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("blocks unsafe generated text while keeping original recordings available", async () => {
    const artifact = syntheticArtifact(input);
    const unsafe = "sk-" + "synthetic".repeat(5);
    artifact.result!.summary = unsafe;
    await writeStudyAnalysis((await resolveRunPath(cwd, "analysis-flow"))!, artifact);
    expect(await verifyRun(cwd, "analysis-flow")).toMatchObject({ ok: false, recordingOk: true, shareSafety: { status: "blocked" } });
    const rendered = await renderObserver(cwd, "analysis-flow");
    expect(rendered.ok).toBe(true);
    const companion = JSON.parse(await readFile(path.join(runRoot, "observer/study-analysis.json"), "utf8"));
    expect(companion).toMatchObject({ state: "invalid", analysis: null, warnings: ["ANALYSIS_SENSITIVE_TEXT_QUARANTINED"] });
    expect(await readFile(path.join(runRoot, "observer/index.html"), "utf8")).not.toContain(unsafe);
    expect((await exportRun(cwd, "analysis-flow")).ok).toBe(false);
    expect((await draftFeedback(cwd, "analysis-flow", { analysis: artifact.id, finding: "finding-1" })).ok).toBe(false);
    expect(await readFile(path.join(runRoot, "run.json"))).toEqual(original);
  });

  it("checks the exact report exported even when it arrives after source verification", async () => {
    await renderObserver(cwd, "analysis-flow");
    const artifact = syntheticArtifact(input);
    artifact.result!.summary = "sk-" + "synthetic".repeat(5);
    const result = await exportRun(cwd, "analysis-flow", {}, { verify: async () => {
      const verified = await verifyRun(cwd, "analysis-flow");
      expect(verified.shareSafety.status).toBe("share_ready");
      await writeStudyAnalysis((await resolveRunPath(cwd, "analysis-flow"))!, artifact);
      return verified;
    } });
    expect(result).toMatchObject({ ok: false, error: { code: "HUMANISH_EXPORT_SHARE_SAFETY_BLOCKED" } });
    expect(await readdir(path.join(cwd, ".humanish"))).not.toContain("exports");
  });

  it("serves a fresh companion feed and rejects a forged saved projection", async () => {
    const artifact = syntheticArtifact(input);
    await writeStudyAnalysis((await resolveRunPath(cwd, "analysis-flow"))!, artifact);
    const rendered = await renderObserver(cwd, "analysis-flow");
    expect(rendered.ok).toBe(true);
    await writeFile(path.join(runRoot, "observer/study-analysis.json"), '{"forged":true}');
    const server = await serveObserver(rendered, { open: false, port: 0 });
    try {
      const response = await globalThis.fetch(new URL("study-analysis.json", server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ state: "ready", analysis: { id: artifact.id } });
      expect(await listStudyAnalyses((await resolveRunPath(cwd, "analysis-flow"))!)).toHaveLength(1);
    } finally { await server.close(); }
  });

  it("exposes CLI list/show/dry-run without requiring a cost flag on read-only subcommands", async () => {
    for (const args of [["analyze", "list"], ["analyze", "show"], ["analyze", "--max-cost", "5", "--dry-run"]]) {
      const output: string[] = []; let exit = 0;
      const program = createProgram({ writeOut: (text) => output.push(text), writeErr: () => {}, setExitCode: (code) => { exit = code; } });
      await program.parseAsync([...args, "--cwd", cwd, "--run", "analysis-flow", "--json"], { from: "user" });
      expect(exit, output.join("\n")).toBe(0);
      expect(() => JSON.parse(output.join(""))).not.toThrow();
    }
  });
});
