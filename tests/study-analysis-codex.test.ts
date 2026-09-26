import { registerTransientCommsSecrets, withTransientCommsSecrets } from "../src/run-narration-secrets.js";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { automaticAnalysisBudget, formatAutomaticAnalysisBudget, resolveAutomaticAnalysis } from "../src/automatic-analysis-config.js";
import { readAutomaticStudyAnalysis, runAutomaticStudyAnalysis } from "../src/automatic-study-analysis.js";
import { parseLabConfig } from "../src/lab-config.js";
import { createProgram } from "../src/program.js";
import { resolveRunPath, runDryRun } from "../src/run.js";
import { estimateStudyAnalysisAdmission, runStudyAnalysis, STUDY_ANALYSIS_PROMPT_VERSION } from "../src/study-analysis-engine.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import type { StudyAnalysisProvider } from "../src/study-analysis-provider.js";
import { analyzeStudy, showStudyAnalysis } from "../src/study-analysis-service.js";
import { listStudyAnalysisExecutions, writeStudyAnalysis } from "../src/study-analysis-store.js";
import { digestStudyAnalysisInput, hashStudyAnalysisValue, validateStudyAnalysisArtifact, validateStudyAnalysisExecutionReceipt } from "../src/study-analysis-validation.js";
import type { CodexStudyAnalysisConfig, StudyAnalysisConfig, StudyAnalysisInput } from "../src/study-analysis.js";
import { computeStats } from "../src/stats.js";
import { syntheticArtifact, syntheticInput, syntheticResult } from "./study-analysis-fixtures.js";

// These are domain-provider contract tests, not fabricated Codex RPC fixtures or live claims.
// The restricted transport owns wire-shape and process-isolation qualification separately.
function config(): CodexStudyAnalysisConfig {
  const selected = resolveAutomaticAnalysis({ provider: "codex", timeoutMs: 1000 });
  if (!selected.ok || selected.config?.provider !== "codex") throw new Error("Synthetic configuration failed");
  return selected.config;
}
function packet(): StudyAnalysisInput {
  const input = syntheticInput();
  input.evidence = input.evidence.filter(e => e.capture === null);
  input.coverage.captureCount = 0; input.coverage.evidenceCount = input.evidence.length;
  input.inputDigest = digestStudyAnalysisInput(input);
  return input;
}
function provider(input: StudyAnalysisInput) {
  return vi.fn<StudyAnalysisProvider>(async () => ({ status: "completed", output: syntheticResult(input),
    usage: { input: 400, output: 80, cachedInput: 20 }, usageComplete: true, dispatched: true, errorCode: null }));
}
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(cwd => rm(cwd, { recursive: true, force: true }))); });
async function study() {
  const cwd = await mkdtemp(path.join(tmpdir(), "humanish-codex-analysis-")); temporary.push(cwd);
  await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
  await runDryRun({ cwd, dryRun: true, runId: "codex-analysis" });
  const prepared = (await resolveRunPath(cwd, "codex-analysis"))!;
  const runFile = path.join(prepared.physicalRunRoot, "run.json");
  const bundle = JSON.parse(await readFile(runFile, "utf8"));
  bundle.mode = "live"; bundle.streams[0].status = "complete";
  await writeFile(runFile, JSON.stringify(bundle));
  await rm(path.join(prepared.physicalRunRoot, "status.json"));
  const original = await readFile(runFile);
  const input = await captureStudyEvidence(prepared, original);
  return { cwd, prepared, runFile, original, input };
}

describe("explicit Codex account analysis", () => {
  it("preserves the default API configuration bytes and resolves a qualified, null-cap account branch", () => {
    expect(resolveAutomaticAnalysis(undefined)).toEqual({ ok: true, config: { model: "gpt-6-astra", question: null,
      maxCostUsd: 3, timeoutMs: 600000, maxOutputTokens: 16384 }, preferLargerOutput: true });
    expect(config()).toMatchObject({ provider: "codex", maxCostUsd: null, maxOutputTokens: null,
      identity: { transport: "codex-app-server", authentication: "chatgpt-account", billing: "account-unknown",
        requestedModel: "gpt-6-astra", resolvedModel: "gpt-6-astra", reasoningEffort: "low", toolPolicy: "restricted-codex-v1", cliVersion: "0.154.0" } });
    const budget = automaticAnalysisBudget({ provider: "codex" }, "cua")!;
    expect(formatAutomaticAnalysisBudget(budget)).toContain("dollar cost and output-token ceiling are unknown");
    expect(formatAutomaticAnalysisBudget(budget)).not.toMatch(/\$null|\$3/);
  });

  it.each([{ maxCostUsd: 3 }, { maxCostUsd: 0 }, { maxOutputTokens: 8192 }, { model: "other-model" }, { provider: "other" }, { model: null }, { timeoutMs: null }, { identity: {} }])(
    "rejects unsupported declarations before resource admission: %j", fields => {
      const analysis = { provider: "codex", ...fields };
      expect(resolveAutomaticAnalysis(analysis).ok).toBe(false);
      expect(parseLabConfig({ schema: "humanish.lab.v2", id: "synthetic", subject: { source: "app-url", appUrl: "https://example.test" },
        actors: [{ type: "openai-computer-use", persona: "first-time-visitor" }], execution: { target: "e2b-desktop" },
        scenario: { mode: "live" }, review: { analysis } }).ok).toBe(false);
    });

  it("uses the unchanged evidence validator and never prices account tokens", async () => {
    const input = packet(), run = provider(input), fetch = vi.fn();
    expect(estimateStudyAnalysisAdmission(input, config())).toEqual({ allowed: true, error: null,
      inputTokenAllowance: null, outputTokenAllowance: null, estimatedCostUsd: null, ratesAsOf: null });
    const artifact = await runStudyAnalysis(input, config(), { apiKey: "unused-synthetic-key", codexProvider: run, fetch });
    expect(artifact).toMatchObject({ provider: "codex", status: "complete", error: null,
      usage: { inputTokens: 400, outputTokens: 80, cachedInputTokens: 20, usageComplete: true, dispatched: true,
        estimatedCostUsd: null, estimatedAdmissionUsd: null, ratesAsOf: null } });
    expect(run.mock.calls[0]?.[0]).toMatchObject({ maxOutputTokens: null, model: "gpt-6-astra", timeoutMs: 1000 });
    expect(run.mock.calls[0]?.[0].instructions).toContain("UNTRUSTED DATA");
    expect(validateStudyAnalysisArtifact(artifact)).toEqual(artifact);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not start the account provider after cancellation or a failed durable dispatch guard", async () => {
    const run = provider(packet()), controller = new AbortController(); controller.abort();
    expect(await runStudyAnalysis(packet(), config(), { codexProvider: run, signal: controller.signal }))
      .toMatchObject({ status: "cancelled", usage: { dispatched: false } });
    await expect(runStudyAnalysis(packet(), config(), { codexProvider: run,
      beforeDispatch: async () => { throw new Error("Synthetic durable claim failure"); } })).rejects.toThrow("Synthetic durable claim failure");
    expect(run).not.toHaveBeenCalled();
  });

  it("scrubs account-generated secrets without changing source evidence or repairing structural IDs", async () => {
    const input = packet(), before = structuredClone(input), answer = syntheticResult(input), canary = "analysis-private-canary";
    answer.summary += ` ${canary}`;
    const run = provider(input);
    run.mockResolvedValue({ status: "completed", output: answer, usage: null, usageComplete: false, dispatched: true, errorCode: null });
    await withTransientCommsSecrets(async () => {
      registerTransientCommsSecrets([canary]);
      const artifact = await runStudyAnalysis(input, config(), { codexProvider: run });
      expect(artifact.result?.summary).toContain("[REDACTED_SECRET]");
      expect(JSON.stringify(artifact)).not.toContain(canary);
      expect(artifact.evidence).toEqual(before.evidence); expect(input).toEqual(before);
      answer.findings[0]!.id = canary;
      expect(await runStudyAnalysis(input, config(), { codexProvider: run })).toMatchObject({ result: null, error: "analysis_validation_failed_scrub_rejected" });
    });
  });

  it("retains only a safe stage code when response validation throws unexpectedly", async () => {
    const canary = "synthetic-unexpected-validation-secret";
    const output = Object.defineProperty({}, "summary", {
      enumerable: true,
      get() { throw new Error(canary); }
    });
    const run = vi.fn<StudyAnalysisProvider>(async () => ({ status: "completed", output,
      usage: { input: 400, output: 80, cachedInput: 20 }, usageComplete: true, dispatched: true, errorCode: null }));
    const artifact = await runStudyAnalysis(packet(), config(), { codexProvider: run });
    expect(artifact).toMatchObject({ status: "failed", result: null, error: "analysis_validation_failed_unexpected",
      usage: { inputTokens: 400, outputTokens: 80, cachedInputTokens: 20, usageComplete: true, dispatched: true } });
    expect(JSON.stringify(artifact)).not.toContain(canary);
    expect(validateStudyAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("retains incomplete usage on cancellation without treating it as final or free", async () => {
    const artifact = await runStudyAnalysis(packet(), config(), { codexProvider: async () => ({ status: "cancelled", output: null,
      usage: { input: 400, output: 20 }, usageComplete: false, dispatched: true, errorCode: "cancelled" }) });
    expect(artifact).toMatchObject({ status: "cancelled", result: null, error: "analysis_cancelled",
      usage: { inputTokens: 400, outputTokens: 20, usageComplete: false, estimatedCostUsd: null } });
    expect(validateStudyAnalysisArtifact(artifact)).toEqual(artifact);
  });

  it("refuses source-free visual findings and mismatched identity without weakening references", async () => {
    const input = packet(), run = provider(input), bad = syntheticResult(input);
    bad.findings[0]!.observations[0]!.basis = "visual";
    run.mockResolvedValue({ status: "completed", output: bad, usage: null, usageComplete: false, dispatched: true, errorCode: null });
    const artifact = await runStudyAnalysis(input, config(), { codexProvider: run });
    expect(artifact).toMatchObject({ result: null, error: "analysis_validation_failed_visual_without_capture" });
    for (const field of ["transport", "authentication", "billing", "resolvedModel", "reasoningEffort", "toolPolicy", "cliVersion"] as const) {
      const changed = structuredClone(config()); (changed.identity as unknown as Record<string, unknown>)[field] = "unqualified";
      expect(hashStudyAnalysisValue(changed)).not.toBe(hashStudyAnalysisValue(config()));
      expect(estimateStudyAnalysisAdmission(input, changed).allowed).toBe(false);
    }
    const malformed = { ...config(), maxCostUsd: 1 } as unknown as StudyAnalysisConfig;
    await expect(runStudyAnalysis(input, malformed, { codexProvider: run })).rejects.toThrow("ANALYSIS_CONFIG_INVALID");
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not reuse API reports, reuses an exact account report, and accounts unpriced work once", async () => {
    const f = await study(), run = provider(f.input), prior = syntheticArtifact(f.input, "legacy-api");
    prior.config = { model: "gpt-6-astra", question: null, maxCostUsd: 3, timeoutMs: 1000, maxOutputTokens: 8192 };
    prior.configDigest = hashStudyAnalysisValue(prior.config); prior.promptVersion = STUDY_ANALYSIS_PROMPT_VERSION;
    await writeStudyAnalysis(f.prepared, prior);
    const originalLegacy = JSON.stringify(prior);
    const first = await analyzeStudy(f.cwd, "codex-analysis", { config: config() }, { apiKey: "", codexProvider: run });
    expect(first).toMatchObject({ ok: true, reused: false, usage: { estimatedCostUsd: null } });
    const second = await analyzeStudy(f.cwd, "codex-analysis", { config: config() }, { apiKey: "", codexProvider: run });
    expect(second).toMatchObject({ ok: true, reused: true, analysisId: first.analysisId });
    expect(run).toHaveBeenCalledOnce();
    expect((await showStudyAnalysis(f.cwd, "codex-analysis", "legacy-api")).analysis).toEqual(JSON.parse(originalLegacy));
    const receipts = (await listStudyAnalysisExecutions(f.prepared)).receipts.filter(r => r.provider === "codex");
    expect(receipts).toHaveLength(1);
    expect(validateStudyAnalysisExecutionReceipt(receipts[0])).toMatchObject({ provider: "codex", maxCostUsd: null });
    expect(() => validateStudyAnalysisExecutionReceipt({ ...receipts[0], maxCostUsd: 1 })).toThrow("ANALYSIS_RECEIPT_INVALID");
    expect(() => validateStudyAnalysisExecutionReceipt({ ...receipts[0], usage: { ...receipts[0]!.usage, estimatedCostUsd: 0 } })).toThrow("ANALYSIS_RECEIPT_INVALID");
    const stats = await computeStats(f.cwd);
    expect(stats.ok && stats.totals.costs.analysisUnpricedAttempts).toBe(2); // Includes the intentionally unpriced legacy fixture.
    expect(await readFile(f.runFile)).toEqual(f.original);
    const changed = await analyzeStudy(f.cwd, "codex-analysis", { config: { ...config(), question: "Review recovery." } }, { codexProvider: run });
    expect(changed.reused).toBe(false); expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs explicitly selected automatic account analysis without an API key and never restarts a claimed job", async () => {
    const f = await study(), run = provider(f.input), fetch = vi.fn();
    const outcome = await runAutomaticStudyAnalysis(f.cwd, "codex-analysis", config(), { apiKey: "", codexProvider: run, fetch });
    expect(outcome.result?.ok).toBe(true);
    expect(await readAutomaticStudyAnalysis(f.cwd, "codex-analysis")).toMatchObject({ state: outcome.state });
    expect((await runAutomaticStudyAnalysis(f.cwd, "codex-analysis", config(), { apiKey: "", codexProvider: run })).reason)
      .toBe("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
    expect(run).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });

  it("records an actionable login failure without API fallback or damage to recordings", async () => {
    const f = await study(), fetch = vi.fn();
    const run = vi.fn<StudyAnalysisProvider>(async () => ({ status: "failed", output: null, usage: null,
      usageComplete: false, dispatched: false, errorCode: "codex_login_required" }));
    const outcome = await runAutomaticStudyAnalysis(f.cwd, "codex-analysis", config(), { apiKey: "synthetic-api-key", codexProvider: run, fetch });
    expect(outcome).toMatchObject({ state: "failed", reason: "AUTOMATIC_ANALYSIS_CODEX_UNAVAILABLE" });
    expect(outcome.result?.error?.message).toContain("ChatGPT account");
    expect(fetch).not.toHaveBeenCalled(); expect(await readFile(f.runFile)).toEqual(f.original);
  });

  it("keeps accounting but refuses publication if the source changes during account analysis", async () => {
    const f = await study();
    const run: StudyAnalysisProvider = async () => {
      await writeFile(f.runFile, JSON.stringify({ ...JSON.parse(f.original.toString()), changed: true }));
      return provider(f.input)({ model: "gpt-6-astra", instructions: "", evidence: "", images: [], schema: {}, maxOutputTokens: null, timeoutMs: 1000 });
    };
    const result = await analyzeStudy(f.cwd, "codex-analysis", { config: config() }, { codexProvider: run });
    expect(result).toMatchObject({ ok: false, error: { code: "ANALYSIS_PUBLICATION_FAILED" }, usage: { dispatched: true, estimatedCostUsd: null } });
    expect(result.executionReceiptPath).toBeDefined(); expect(result.artifactPath).toBeUndefined();
  });

  it("supports manual account dry-run without a dollar flag and rejects declared numeric caps", async () => {
    const f = await study();
    for (const extra of [[], ["--max-cost", "1"], ["--max-output-tokens", "512"]]) {
      const out: string[] = []; let exit = -1;
      const program = createProgram({ writeOut: text => out.push(text), writeErr: () => {}, setExitCode: code => { exit = code; } });
      await program.parseAsync(["analyze", "--provider", "codex", "--run", "codex-analysis", "--cwd", f.cwd, "--dry-run", "--json", ...extra], { from: "user" });
      const result = JSON.parse(out.join(""));
      expect(result.ok).toBe(extra.length === 0); expect(exit).toBe(extra.length === 0 ? 0 : 2);
      if (extra.length === 0) {
        expect(result.admission).toMatchObject({ estimatedCostUsd: null, outputTokenAllowance: null });
        expect(result.warnings).toEqual(["Evidence and configuration admission only. Codex CLI, login, model access and account allowance were not checked; no provider request was sent."]);
      }
      else expect(result.error.code).toBe("ANALYSIS_CONFIG_INVALID");
    }
  });

  it("does not invoke the account launcher or readiness probe during evidence admission", async () => {
    const f = await study();
    const launcher = await import("../src/restricted-codex-analysis.js");
    const create = vi.spyOn(launcher, "createRestrictedCodexAnalysisProvider").mockImplementation(() => { throw new Error("Unexpected analyst launch"); });
    const readiness = vi.spyOn(launcher, "checkRestrictedCodexAnalysisReadiness").mockRejectedValue(new Error("Unexpected readiness probe"));
    try {
      const result = await analyzeStudy(f.cwd, "codex-analysis", { config: config(), dryRun: true });
      expect(result.ok).toBe(true);
      expect(create).not.toHaveBeenCalled();
      expect(readiness).not.toHaveBeenCalled();
    } finally { create.mockRestore(); readiness.mockRestore(); }
  });
});
