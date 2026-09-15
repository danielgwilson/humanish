import { createServer, type Server } from "node:http";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAutomaticStudyAnalysis, readAutomaticStudyAnalysis, requestAutomaticStudyAnalysisCancellation } from "../src/automatic-study-analysis.js";
import { analyzeStudy, withStudyAnalysisLock } from "../src/study-analysis-service.js";
import * as analysisService from "../src/study-analysis-service.js";
import { claimAutomaticStudyAnalysis, readAutomaticStudyAnalysisPrepared, AUTOMATIC_STUDY_ANALYSIS_DIRECTORY } from "../src/study-analysis-job.js";
import { loadStudyAnalysis, listStudyAnalysisExecutions } from "../src/study-analysis-store.js";
import { captureStudyEvidence } from "../src/study-analysis-evidence.js";
import { projectShareCheckedAnalysis, studyAnalysisSharingProblems } from "../src/study-analysis-sharing.js";
import { hashStudyAnalysisValue } from "../src/study-analysis-validation.js";
import { STUDY_ANALYSIS_PROMPT_VERSION, runStudyAnalysis } from "../src/study-analysis-engine.js";
import { resolveRunPath, runDryRun, verifyRun, type RunBundle } from "../src/run.js";
import { pinDirectory, renderObserver, serveRunPath } from "../src/observer.js";
import * as observer from "../src/observer.js";
import { exportRun } from "../src/export.js";
import type { PreparedRunArtifactPaths } from "../src/run-paths.js";
import type { StudyAnalysisConfig, StudyAnalysisInput } from "../src/study-analysis.js";
import { syntheticResult } from "./study-analysis-fixtures.js";

const config: StudyAnalysisConfig = { model: "gpt-5.6-sol", question: null, maxCostUsd: 5, timeoutMs: 2000, maxOutputTokens: 8192 };
const runId = "automatic-synthetic";
// Captured provider envelope; only the explicitly synthetic answer changes.
const wirePath = new URL("./fixtures/openai-closing-report/typed-closing-report.json", import.meta.url);

describe("opted-in automatic analysis ownership", () => {
  let cwd: string, root: string, prepared: PreparedRunArtifactPaths, input: StudyAnalysisInput, original: Buffer;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "humanish-automatic-analysis-"));
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId });
    prepared = (await resolveRunPath(cwd, runId))!; root = prepared.physicalRunRoot;
    const bundle = JSON.parse(await readFile(path.join(root, "run.json"), "utf8")) as RunBundle;
    bundle.mode = "live";
    bundle.streams[0]!.status = "complete";
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle) + "\n");
    await rm(path.join(root, "status.json"));
    original = await readFile(path.join(root, "run.json"));
    input = await captureStudyEvidence(prepared, original);
    expect((await verifyRun(cwd, runId)).checks.filter(check => !check.ok)).toEqual([]);
  });
  afterEach(async () => { vi.restoreAllMocks(); await rm(cwd, { recursive: true, force: true }); });
  const jobPath = () => path.join(root, AUTOMATIC_STUDY_ANALYSIS_DIRECTORY, "job.json");
  async function transport() {
    const wire = JSON.parse(await readFile(wirePath, "utf8"));
    wire.output[0].content[0].text = JSON.stringify(syntheticResult(input));
    return { wire, fetch: vi.fn<typeof fetch>(async () => new Response(JSON.stringify(wire))) };
  }
  it.each([undefined, 0, 1])("requires participant runtime activity for terminal default analysis (%s)", async runtimeParticipantItems => {
    const bundle = JSON.parse(original.toString()) as RunBundle;
    bundle.streams[0]!.actor = {
      schema: "humanish.actor-trace.v1", provider: "synthetic", protocol: "terminal-exec", lane: "terminal",
      persona: { id: "synthetic-participant", traitsApplied: [], promptDigest: "a".repeat(64) },
      redaction: { status: "passed", screenshots: "n/a", notes: "Synthetic terminal trace." },
      startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:01:00.000Z", durationMs: 60000,
      status: "failed", completionReason: "actor_error", reason: "The terminal session ended.",
      ids: {}, counts: runtimeParticipantItems === undefined ? {} : { runtimeParticipantItems },
      items: [{ id: "message-001", kind: "message", lifecycle: "completed", title: "terminal output", text: "A synthetic terminal diagnostic." }],
      capabilities: { headless: true, structuredTrace: true, lanes: ["terminal"],
        producesScreenshots: false, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "open" }
    };
    original = Buffer.from(JSON.stringify(bundle));
    await writeFile(path.join(root, "run.json"), original);
    input = await captureStudyEvidence(prepared, original);
    const h = await transport();
    const outcome = await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch, defaultRequest: true });
    if (runtimeParticipantItems === 1) {
      expect(outcome.state).toBe("partial");
      expect(h.fetch).toHaveBeenCalledTimes(1);
    } else {
      expect(outcome).toMatchObject({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE" });
      expect(h.fetch).not.toHaveBeenCalled();
    }
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
  });
  it.each(["default", "explicit"] as const)("keeps setup-only evidence request-free for %s eligibility", async trigger => {
    // The retained synthetic source has run events and no participant trace.
    // Explicit diagnosis remains available, but a default run must not spend on setup alone.
    const h = await transport();
    const outcome = await runAutomaticStudyAnalysis(cwd, runId, config,
      { apiKey: "synthetic-key", fetch: h.fetch, defaultRequest: trigger === "default" });
    if (trigger === "default") {
      expect(outcome).toMatchObject({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE" });
      expect(h.fetch).not.toHaveBeenCalled();
      expect(await listStudyAnalysisExecutions(prepared)).toEqual({ receipts: [], warnings: [] });
    } else {
      expect(outcome.state).toBe("partial");
      expect(h.fetch).toHaveBeenCalledTimes(1);
    }
    expect(await readAutomaticStudyAnalysis(cwd, runId)).toMatchObject({ state: outcome.state, reason: outcome.reason });
    expect(await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch, defaultRequest: true }))
      .toMatchObject({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_ALREADY_REQUESTED" });
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
  });
  async function claimed() {
    return (await claimAutomaticStudyAnalysis(prepared, { configDigest: hashStudyAnalysisValue(config), promptVersion: STUDY_ANALYSIS_PROMPT_VERSION }))!;
  }

  async function embeddedAnalysis() {
    const html = await readFile(path.join(root, "observer", "index.html"), "utf8");
    const embedded = html.match(/<script id="study-analysis" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    expect(embedded).toBeDefined();
    return JSON.parse(embedded!);
  }

  it.each(["complete", "partial", "failed", "skipped"])("writes terminal %s into the actual static Observer without another request", async state => {
    if (state === "complete") {
      const bundle = JSON.parse(original.toString()) as RunBundle;
      for (const stream of bundle.streams) {
        stream.assignment = { mission: "Review the synthetic item." };
        stream.actor = {
          schema: "humanish.actor-trace.v1", provider: "synthetic", protocol: "cua-loop", lane: "computer-use",
          persona: { id: "synthetic-participant", traitsApplied: [], promptDigest: "a".repeat(64) },
          redaction: { status: "passed", screenshots: "n/a", notes: "Synthetic trace." },
          startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:01:00.000Z", durationMs: 60000,
          status: "passed", completionReason: "turn_completed", reason: "The synthetic turn finished.",
          ids: {}, counts: {}, items: [], capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"],
            producesScreenshots: false, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "open" }
        };
      }
      original = Buffer.from(JSON.stringify(bundle));
      await writeFile(path.join(root, "run.json"), original);
      expect((await verifyRun(cwd, runId)).checks.filter(check => !check.ok)).toEqual([]);
      input = await captureStudyEvidence(prepared, original);
      expect(input.coverage.complete).toBe(true);
    }
    const h = await transport();
    if (state === "failed") h.fetch.mockRejectedValue(new Error("Synthetic transport failure"));
    const outcome = await runAutomaticStudyAnalysis(cwd, runId, config,
      { apiKey: state === "skipped" ? "" : "synthetic-key", fetch: h.fetch });
    expect(outcome.state).toBe(state);
    expect(outcome.result?.ok).toBe(state === "partial" || state === "complete");
    const projected = await embeddedAnalysis();
    expect(projected.automatic).toMatchObject({ state, reason: outcome.reason,
      analysisId: outcome.result?.analysisId ?? null });
    if (state === "partial" || state === "complete") expect(projected.analysis.id).toBe(outcome.result!.analysisId);
    expect(JSON.parse(await readFile(path.join(root, "observer", "study-analysis.json"), "utf8"))).toEqual(projected);
    expect(h.fetch).toHaveBeenCalledTimes(state === "skipped" ? 0 : 1);
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
  });

  it("keeps terminal accounting and warns if a replacement prevents the final static refresh", async () => {
    const h = await transport();
    const render = observer.renderObserver;
    const retained = path.join(cwd, "retained-original");
    const snapshots = new Map<string, Buffer>();
    let finalRefresh = false;
    vi.spyOn(observer, "renderObserver").mockImplementation(async (...args) => {
      expect(args[2]?.expectedRun).toBe(prepared);
      if (JSON.parse(await readFile(jobPath(), "utf8")).state === "partial") {
        finalRefresh = true;
        await rename(root, retained); await cp(retained, root, { recursive: true });
        for (const file of ["observer/index.html", "observer/observer-data.json", "observer/study-analysis.json", "analysis-automatic/job.json"]) {
          snapshots.set(file, await readFile(path.join(root, file)));
        }
      }
      return render(...args);
    });
    const outcome = await runAutomaticStudyAnalysis(cwd, runId, config,
      { apiKey: "synthetic-key", fetch: h.fetch, expectedRun: prepared });
    expect(finalRefresh).toBe(true);
    expect(outcome).toMatchObject({ state: "partial", result: { ok: true, usage: { dispatched: true },
      executionReceiptPath: expect.any(String), warnings: [expect.stringContaining("status was saved, but Observer could not be refreshed")] } });
    expect(JSON.parse(await readFile(path.join(retained, "analysis-automatic/job.json"), "utf8")).state).toBe("partial");
    for (const [file, before] of snapshots) expect(await readFile(path.join(root, file))).toEqual(before);
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("identifies an admission overrun in the stored job and static Observer without losing valid findings", async () => {
    const h = await transport();
    // Perturb the captured envelope's usage count, preserving its wire shape.
    h.wire.usage.output_tokens = config.maxOutputTokens + 1;
    const outcome = await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch });
    expect(outcome).toMatchObject({ state: "partial", reason: "AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED",
      result: { ok: false, status: "partial", error: { code: "analysis_admission_estimate_exceeded" },
        usage: { outputTokens: config.maxOutputTokens + 1, dispatched: true } } });
    expect((await embeddedAnalysis()).automatic).toMatchObject({ state: "partial", reason: "AUTOMATIC_ANALYSIS_ADMISSION_EXCEEDED" });
    expect((await loadStudyAnalysis(prepared)).analysis?.result).not.toBeNull();
    expect((await listStudyAnalysisExecutions(prepared)).receipts).toHaveLength(1);
    expect(h.fetch).toHaveBeenCalledOnce();
  });

  it("claims once across concurrent invocations and persists running before transport", async () => {
    const h = await transport();
    const seen: unknown[] = [];
    h.fetch.mockImplementation(async () => {
      seen.push(await readAutomaticStudyAnalysis(cwd, runId));
      return new Response(JSON.stringify(h.wire));
    });
    const outcomes = await Promise.all([1, 2, 3].map(() => runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })));
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(outcomes.filter(value => value.reason === "AUTOMATIC_ANALYSIS_ALREADY_REQUESTED")).toHaveLength(2);
    const completed = outcomes.find(value => value.result?.analysisId)!;
    expect(completed.state).toBe("partial");
    expect(seen).toEqual([expect.objectContaining({ state: "running", analysisId: completed.result!.analysisId })]);
    const record = JSON.parse(await readFile(jobPath(), "utf8"));
    expect(record).toMatchObject({ attemptId: completed.result!.analysisId, analysisId: completed.result!.analysisId,
      sourceRunSha256: input.sourceRunSha256, inputDigest: input.inputDigest, state: "partial" });
    expect((await listStudyAnalysisExecutions(prepared)).receipts).toHaveLength(1);
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
    expect((await captureStudyEvidence(prepared, original)).inputDigest).toBe(input.inputDigest);
  });

  it("reuses an existing result without another call and never retries after reopening", async () => {
    const h = await transport();
    const prior = await analyzeStudy(cwd, runId, { config }, { apiKey: "synthetic-key", fetch: h.fetch });
    const automatic = await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "", fetch: h.fetch });
    expect(automatic).toMatchObject({ reason: "AUTOMATIC_ANALYSIS_REUSED", result: { reused: true, analysisId: prior.analysisId } });
    for (let i = 0; i < 3; i++) {
      await loadStudyAnalysis(prepared);
      await readAutomaticStudyAnalysis(cwd, runId);
      await renderObserver(cwd, runId, { open: false });
      expect((await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })).reason).toBe("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
    }
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect((await readAutomaticStudyAnalysis(cwd, runId))?.state).toBe(automatic.state);
    const record = JSON.parse(await readFile(jobPath(), "utf8"));
    expect(record).toMatchObject({ sourceRunSha256: input.sourceRunSha256, inputDigest: input.inputDigest,
      analysisId: prior.analysisId, analysisSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(record.attemptId).not.toBe(prior.analysisId);
  });

  it.each(["missing-result", "replaced-result", "missing-receipt", "replaced-receipt", "source", "config", "input", "prompt", "status", "foreign-id"])
    ("does not trust terminal job metadata after %s changes", async kind => {
      const h = await transport();
      const outcome = await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch });
      expect(outcome.state).toBe("partial");
      const record = JSON.parse(await readFile(jobPath(), "utf8"));
      const artifactPath = path.join(root, "analysis", outcome.result!.analysisId!, "analysis.json");
      const receiptPath = path.join(root, "analysis-attempts", outcome.result!.analysisId!, "receipt.json");
      if (kind === "missing-result") await rm(artifactPath);
      if (kind === "replaced-result") {
        const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
        artifact.result.summary = "A changed synthetic review.";
        await writeFile(artifactPath, JSON.stringify(artifact));
      }
      if (kind === "missing-receipt") await rm(receiptPath);
      if (kind === "replaced-receipt") {
        const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
        receipt.completedAt = new Date(Date.parse(receipt.completedAt) + 1).toISOString();
        await writeFile(receiptPath, JSON.stringify(receipt));
      }
      if (kind === "source") await writeFile(path.join(root, "run.json"), Buffer.concat([original, Buffer.from("\n")]));
      if (kind === "config") record.configDigest = "a".repeat(64);
      if (kind === "input") record.inputDigest = "a".repeat(64);
      if (kind === "prompt") record.promptVersion = "synthetic-other-prompt";
      if (kind === "status") record.state = "complete";
      if (kind === "foreign-id") record.analysisId = "analysis-other";
      await writeFile(jobPath(), JSON.stringify(record));
      expect((await readAutomaticStudyAnalysis(cwd, runId))?.state).toBe("unknown");
      expect((await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })).reason)
        .toBe("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
      expect(h.fetch).toHaveBeenCalledTimes(1);
    });

  it("keeps a prior result selected when the automatic job's newer result disappears", async () => {
    const h = await transport();
    const prior = await analyzeStudy(cwd, runId, { config }, { apiKey: "synthetic-key", fetch: h.fetch });
    const next = await runAutomaticStudyAnalysis(cwd, runId, { ...config, question: "Review recovery." }, { apiKey: "synthetic-key", fetch: h.fetch });
    await rm(path.join(root, "analysis", next.result!.analysisId!, "analysis.json"));
    const loaded = await loadStudyAnalysis(prepared);
    expect(loaded).toMatchObject({ state: "ready", analysis: { id: prior.analysisId }, warnings: [], automatic: { state: "unknown" } });
    expect(studyAnalysisSharingProblems(loaded)).toEqual({ sensitive: false, unverified: false });
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
  });

  it.each(["missing-key", "admission", "busy", "cancelled"])("retains %s without dispatch or retry", async kind => {
    const h = await transport();
    const call = () => runAutomaticStudyAnalysis(cwd, runId, kind === "admission" ? { ...config, maxCostUsd: 0.000001 } : config,
      { apiKey: kind === "missing-key" ? "" : "synthetic-key", fetch: h.fetch,
        ...(kind === "cancelled" ? { signal: AbortSignal.abort() } : {}) });
    const result = kind === "busy" ? await withStudyAnalysisLock(prepared, call) : await call();
    expect(result.state).toBe(kind === "cancelled" ? "cancelled" : "skipped");
    expect((await loadStudyAnalysis(prepared)).automatic?.state).toBe(result.state);
    expect((await verifyRun(cwd, runId)).shareSafety.status).toBe("share_ready");
    expect((await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })).reason).toBe("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("does not claim active/dry-run evidence or a moving latest pointer", async () => {
    const h = await transport();
    expect((await runAutomaticStudyAnalysis(cwd, "latest", config, { apiKey: "", fetch: h.fetch })).state).toBe("skipped");
    for (const mode of ["active", "dry-run"]) {
      const bundle = JSON.parse(original.toString()) as RunBundle;
      if (mode === "active") bundle.streams[0]!.status = "running"; else bundle.mode = "dry-run";
      await writeFile(path.join(root, "run.json"), JSON.stringify(bundle));
      expect((await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "", fetch: h.fetch })).state).toBe("skipped");
    }
    expect(await readdir(root)).not.toContain(AUTOMATIC_STUDY_ANALYSIS_DIRECTORY);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("preserves explicit actor cancellation without suppressing ordinary incomplete studies", async () => {
    const h = await transport();
    const bundle = JSON.parse(original.toString()) as RunBundle;
    bundle.streams[0]!.status = "incomplete";
    bundle.streams[0]!.actor = {
      schema: "humanish.actor-trace.v1", provider: "synthetic", protocol: "cua-loop", lane: "computer-use",
      persona: { id: "synthetic-participant", traitsApplied: [], promptDigest: "a".repeat(64) },
      redaction: { status: "passed", screenshots: "n/a", notes: "Synthetic trace." },
      startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:01:00.000Z", durationMs: 60000,
      status: "incomplete", completionReason: "budget_reached", stopCause: "harness_aborted", reason: "The operator stopped the study.",
      ids: {}, counts: {}, items: [], capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"],
        producesScreenshots: false, byoModel: false, preGrantableApprovals: false, inProcessTools: false, license: "open" }
    };
    const aborted = Buffer.from(JSON.stringify(bundle));
    await writeFile(path.join(root, "run.json"), aborted);
    expect((await verifyRun(cwd, runId)).checks.filter(check => !check.ok)).toEqual([]);
    expect(await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "", fetch: h.fetch }))
      .toEqual({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_ACTOR_CANCELLED" });
    expect(await readdir(root)).not.toContain(AUTOMATIC_STUDY_ANALYSIS_DIRECTORY);
    expect(await readFile(path.join(root, "run.json"))).toEqual(aborted);
    bundle.streams[0]!.actor.stopCause = "time_limit";
    bundle.streams[0]!.actor.reason = "The time limit ended the study.";
    await writeFile(path.join(root, "run.json"), JSON.stringify(bundle));
    expect(await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "", fetch: h.fetch }))
      .toMatchObject({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_KEY_MISSING" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["queued", "running", "empty"])("leaves interrupted %s claims consumed without readers dispatching", async state => {
    const h = await transport();
    const job = await claimed();
    if (state === "running") await job.update({ state: "running", analysisId: job.attemptId, startedAt: new Date().toISOString() });
    if (state === "empty") await rm(jobPath());
    const record = state === "empty" ? undefined : JSON.parse(await readFile(jobPath(), "utf8"));
    expect((await readAutomaticStudyAnalysisPrepared(prepared, record ? Date.parse(record.updatedAt) + 15001 : Date.now()))?.state).toBe("unknown");
    expect((await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })).reason).toBe("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("fails the awaited durability guard before provider transport", async () => {
    const h = await transport();
    await expect(runStudyAnalysis(input, config, { apiKey: "synthetic-key", fetch: h.fetch,
      beforeDispatch: async () => { throw new Error("Synthetic durable write failure"); } })).rejects.toThrow("Synthetic durable write failure");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each(["marker", "signal"])("cancels an owned request via %s without a PID or retry", async kind => {
    const h = await transport();
    h.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const controller = new AbortController();
    const operation = runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch, signal: controller.signal });
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    if (kind === "marker") expect(await requestAutomaticStudyAnalysisCancellation(cwd, runId)).toEqual({ requested: true, reason: null });
    else controller.abort();
    expect(await operation).toMatchObject({ state: "cancelled", result: { usage: { dispatched: true, inputTokens: null, estimatedCostUsd: null } } });
    expect((await listStudyAnalysisExecutions(prepared)).receipts).toHaveLength(1);
    expect((await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })).reason).toBe("AUTOMATIC_ANALYSIS_ALREADY_REQUESTED");
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
  });

  it("keeps receipt accounting when source changes after dispatch", async () => {
    const h = await transport();
    h.fetch.mockImplementation(async () => {
      await writeFile(path.join(root, "run.json"), Buffer.concat([original, Buffer.from("\n")]));
      return new Response(JSON.stringify(h.wire));
    });
    expect(await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })).toMatchObject({ state: "failed",
      reason: "AUTOMATIC_ANALYSIS_PUBLICATION_FAILED", result: { executionReceiptPath: expect.any(String), usage: { dispatched: true } } });
    expect((await listStudyAnalysisExecutions(prepared)).receipts).toHaveLength(1);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["oversized", "malformed", "symlink", "hardlink", "future"])("quarantines %s job metadata without changing evidence approval", async kind => {
    await claimed();
    const before = await readFile(jobPath());
    if (kind === "oversized") await writeFile(jobPath(), " ".repeat(8193));
    if (kind === "malformed") await writeFile(jobPath(), "{}");
    if (kind === "future") { const record = JSON.parse(before.toString()); record.updatedAt = "2999-01-01T00:00:00.000Z"; await writeFile(jobPath(), JSON.stringify(record)); }
    if (kind === "symlink" || kind === "hardlink") {
      const outside = path.join(cwd, "synthetic-job.json"); await writeFile(outside, before); await rm(jobPath());
      if (kind === "symlink") await symlink(outside, jobPath()); else await link(outside, jobPath());
    }
    const loaded = await loadStudyAnalysis(prepared);
    expect(loaded).toMatchObject({ state: "none", warnings: [], automatic: { state: "unknown" } });
    expect(studyAnalysisSharingProblems(loaded)).toEqual({ sensitive: false, unverified: false });
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
  });

  it("refuses a replaced claim directory and a foreign cancellation record", async () => {
    const job = await claimed();
    const cancelPath = path.join(root, AUTOMATIC_STUDY_ANALYSIS_DIRECTORY, "cancel.json");
    await writeFile(cancelPath, JSON.stringify({ schema: "humanish.automatic-study-analysis-cancellation.v1", runId,
      claimId: "00000000-0000-4000-8000-000000000000", requestedAt: new Date().toISOString() }));
    await expect(job.cancellationRequested()).rejects.toThrow();
    await rename(path.dirname(jobPath()), path.join(root, "old-automatic"));
    await mkdir(path.dirname(jobPath()));
    await expect(job.touch()).rejects.toThrow();
    expect(await readdir(path.dirname(jobPath()))).toEqual([]);
  });

  it("never follows a job-root symlink or spends into full history", async () => {
    const h = await transport();
    const outside = path.join(cwd, "outside"); await mkdir(outside);
    await symlink(outside, path.dirname(jobPath()));
    expect((await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch })).state).toBe("skipped");
    expect(await readdir(outside)).toEqual([]);
    await rm(path.dirname(jobPath()));
    const history = path.join(root, "analysis-attempts"); await mkdir(history);
    await Promise.all(Array.from({ length: 256 }, (_, index) => mkdir(path.join(history, `attempt-${index}`))));
    expect(await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch }))
      .toMatchObject({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_STORAGE_UNAVAILABLE" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("keeps prior findings when a new automatic configuration cannot run", async () => {
    const h = await transport();
    const prior = await analyzeStudy(cwd, runId, { config }, { apiKey: "synthetic-key", fetch: h.fetch });
    const before = await readFile(path.join(root, "analysis", prior.analysisId!, "analysis.json"));
    expect(await runAutomaticStudyAnalysis(cwd, runId, { ...config, question: "Review recovery." }, { apiKey: "", fetch: h.fetch }))
      .toMatchObject({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_KEY_MISSING" });
    expect(await loadStudyAnalysis(prepared)).toMatchObject({ state: "ready", analysis: { id: prior.analysisId }, automatic: { state: "skipped" } });
    expect(await readFile(path.join(root, "analysis", prior.analysisId!, "analysis.json"))).toEqual(before);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["automatic", "service"])("rejects a replaced producer directory before %s can reuse its copied report", async mode => {
    const h = await transport();
    const prior = await analyzeStudy(cwd, runId, { config }, { apiKey: "synthetic-key", fetch: h.fetch });
    expect(prior.analysisId).toBeDefined();
    const retained = path.join(cwd, "retained-original");
    await rename(root, retained); await cp(retained, root, { recursive: true });
    const before = await readdir(root);
    const result = mode === "automatic"
      ? await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "", fetch: h.fetch, expectedRun: prepared })
      : await analyzeStudy(cwd, runId, { config }, { apiKey: "", fetch: h.fetch, expectedRun: prepared });
    if (mode === "automatic") expect(result).toEqual({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" });
    else expect(result).toMatchObject({ ok: false, reused: false, error: { code: "ANALYSIS_SOURCE_CHANGED" } });
    expect(await readdir(root)).toEqual(before);
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the coordinator's original pin through the service boundary", async () => {
    const h = await transport();
    const service = analysisService.analyzeStudy;
    let copiedJob: Buffer | undefined;
    vi.spyOn(analysisService, "analyzeStudy").mockImplementation(async (...args) => {
      expect(args[3]?.expectedRun).toBe(prepared);
      const retained = path.join(cwd, "retained-original");
      await rename(root, retained); await cp(retained, root, { recursive: true });
      copiedJob = await readFile(jobPath());
      return service(...args);
    });
    expect(await runAutomaticStudyAnalysis(cwd, runId, config, { apiKey: "synthetic-key", fetch: h.fetch, expectedRun: prepared }))
      .toMatchObject({ state: "unknown", result: { ok: false, error: { code: "ANALYSIS_SOURCE_CHANGED" } } });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(await readFile(jobPath())).toEqual(copiedJob);
    expect(await readdir(root)).not.toContain("analysis");
    expect(await readdir(root)).not.toContain("analysis-attempts");
  });

  it.each(["cwd", "runId"])("an original pin cannot select a different %s", async kind => {
    const h = await transport();
    const selectedCwd = kind === "cwd" ? path.join(cwd, "other-project") : cwd;
    const selectedId = kind === "runId" ? "other-run" : runId;
    expect(await runAutomaticStudyAnalysis(selectedCwd, selectedId, config, { apiKey: "synthetic-key", fetch: h.fetch, expectedRun: prepared }))
      .toEqual({ state: "skipped", reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE" });
    expect(await analyzeStudy(selectedCwd, selectedId, { config }, { apiKey: "synthetic-key", fetch: h.fetch, expectedRun: prepared }))
      .toMatchObject({ ok: false, error: { code: "ANALYSIS_SOURCE_UNAVAILABLE" } });
    expect(await readdir(root)).not.toContain(AUTOMATIC_STUDY_ANALYSIS_DIRECTORY);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("supports an unchanged project alias while preserving the physical pin for reuse", async () => {
    const h = await transport();
    const alias = path.join(cwd, "project-alias");
    await symlink(cwd, alias, "dir");
    const outcome = await runAutomaticStudyAnalysis(alias, runId, config, { apiKey: "synthetic-key", fetch: h.fetch });
    expect(outcome).toMatchObject({ state: "partial", result: { reused: false } });
    expect(await analyzeStudy(alias, runId, { config }, { apiKey: "", fetch: h.fetch, expectedRun: prepared }))
      .toMatchObject({ ok: true, reused: true, analysisId: outcome.result!.analysisId });
    const other = path.join(cwd, "other-project"); await mkdir(other); await rm(alias); await symlink(other, alias, "dir");
    expect(await analyzeStudy(alias, runId, { config }, { apiKey: "", fetch: h.fetch, expectedRun: prepared }))
      .toMatchObject({ ok: false, reused: false, error: { code: "ANALYSIS_SOURCE_UNAVAILABLE" } });
    expect(await readdir(other)).toEqual([]);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(root, "run.json"))).toEqual(original);
  });

  it("quarantines invalid direct job projection without changing source approval", () => {
    const loaded = { state: "none" as const, analysis: null, corrections: [], warnings: [], automatic: {
      state: "queued" as const, analysisId: null, updatedAt: new Date().toISOString(), reason: "unexpected raw detail" } };
    expect(projectShareCheckedAnalysis(loaded)).toMatchObject({ state: "none", warnings: [], automatic: { state: "unknown", reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" } });
    expect(studyAnalysisSharingProblems(loaded)).toEqual({ sensitive: false, unverified: false });
  });

  it("serves only a safe job projection and exports no live execution authority", async () => {
    const job = await claimed();
    await job.update({ state: "running", analysisId: job.attemptId, startedAt: new Date().toISOString() });
    expect(await requestAutomaticStudyAnalysisCancellation(cwd, runId)).toMatchObject({ requested: true });
    const pinned = await pinDirectory(root);
    let server: Server | undefined;
    try {
      server = createServer((request, response) => { void serveRunPath(pinned, request.url!.slice(1), response); });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("No synthetic listener");
      const base = `http://127.0.0.1:${address.port}/`;
      for (const route of ["analysis-automatic/job.json", "analysis-automatic//cancel.json", "observer/../analysis-automatic/job.json"]) {
        expect((await fetch(new URL(route, base))).status).toBe(404);
      }
      const projected = await (await fetch(new URL("observer/study-analysis.json", base))).json() as { automatic: object };
      expect(projected).toMatchObject({ state: "none", automatic: { state: "running" } });
      expect(Object.keys(projected.automatic).sort()).toEqual(["analysisId", "reason", "state", "updatedAt"]);
      await renderObserver(cwd, runId, { open: false });
      const exported = await exportRun(cwd, runId, { out: path.join(cwd, "snapshot.html") });
      expect(exported.ok).toBe(true);
      const html = await readFile(path.join(cwd, "snapshot.html"), "utf8");
      expect(html).toContain('"state":"unknown"');
      const derivative = path.join(cwd, "redacted");
      expect((await exportRun(cwd, runId, { format: "bundle", redactScreenshots: true, out: derivative })).ok).toBe(true);
      expect(await readdir(path.join(derivative, ".humanish/runs", runId))).not.toContain(AUTOMATIC_STUDY_ANALYSIS_DIRECTORY);
    } finally { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); } }
  });
});
