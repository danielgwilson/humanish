import { renameSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { automaticAnalysisBudget, resolveAutomaticAnalysis } from "../src/automatic-analysis-config.js";
import { completeAutomaticAnalysis, markFinalizedStudyResult, automaticAnalysisSucceeded } from "../src/automatic-analysis-completion.js";
import { automaticAnalysisEnvelope, cliAutomaticAnalysisHooks, createProgram } from "../src/program.js";
import { readLabSummary } from "../src/lab-summary.js";
import { runLabPreflight } from "../src/lab-preflight.js";
import { parse as parseYaml } from "yaml";
import { runLab } from "../src/lab-engine.js";
import { runCuaActorLab } from "../src/cua-actor-lab.js";
import { runSharedWorldLab } from "../src/shared-world-lab.js";
import { runConcurrentSharedWorld } from "../src/concurrent-shared-world-lab.js";
import { runTerminalProductLab } from "../src/e2b-terminal-lab.js";
import { runScriptedBrowserLab } from "../src/scripted-browser-lab.js";
import { claimAutomaticStudyAnalysis } from "../src/study-analysis-job.js";
import { prepareRunArtifactPaths } from "../src/run-paths.js";
import { resolveRunPath, runDryRun, verifyRun } from "../src/run.js";
import { readRunDetail } from "../src/run-detail.js";
import { stopRun } from "../src/tui-actions.js";
import * as automaticJobs from "../src/automatic-study-analysis.js";
import type { AutomaticStudyAnalysisOutcome } from "../src/study-analysis-job.js";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/task-route-preflight/labs.json", import.meta.url), "utf8")) as Array<{ name: string; config: LabConfig; backend: string }>;
const supported = new Set(["cua", "scripted", "terminal", "shared-world", "concurrent-shared-world"]);
const resolved = resolveAutomaticAnalysis({ maxCostUsd: 5 });
if (!resolved.ok || !resolved.config || resolved.config.provider === "codex") throw new Error("invalid synthetic test config");
const config = resolved.config;

describe("automatic analysis admission and producer boundary", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "humanish-auto-")); });
  afterEach(async () => { vi.restoreAllMocks(); await rm(cwd, { recursive: true, force: true }); });

  it("defaults use a separate three-dollar admission budget and false opts out", () => {
    expect(config).toEqual({ model: "gpt-6-astra", maxCostUsd: 5, question: null, timeoutMs: 600000, maxOutputTokens: 16384 });
    expect(resolveAutomaticAnalysis(undefined)).toEqual({ ok: true, config: { ...config, maxCostUsd: 3 }, preferLargerOutput: true });
    expect(resolveAutomaticAnalysis({ maxCostUsd: 3, maxOutputTokens: 16384 })).not.toHaveProperty("preferLargerOutput");
    expect(resolveAutomaticAnalysis(false)).toEqual({ ok: true, config: undefined });
  });
  it.each([null, true, {}, { maxCostUsd: 0 }, { maxCostUsd: Infinity }, { maxCostUsd: 1001 },
    { maxCostUsd: 2, model: "unsupported" }, { maxCostUsd: 2, timeoutMs: 0 }, { maxCostUsd: 2, timeoutMs: 1.5 },
    { maxCostUsd: 2, maxOutputTokens: 32769 }, { maxCostUsd: 2, question: null }, { maxCostUsd: 2, question: "x".repeat(4001) },
    { maxCostUsd: 2, enabled: true }, { maxCostUsd: 2, maxCost: 1 }])("rejects malformed settings %j", raw => {
    expect(resolveAutomaticAnalysis(raw).ok).toBe(false);
  });
  it.each(fixtures)("preserves explicit opt-out on every route: $name", ({ config: base }) => {
    const parsed = parseLabConfig({ ...base, review: { analysis: false } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.review?.analysis).toBe(false);
  });
  it.each(fixtures)("only describes defaults for supported live backends: $name", ({ backend }) => {
    expect(automaticAnalysisBudget(undefined, backend)).toEqual(supported.has(backend)
      ? { model: "gpt-6-astra", maxCostUsd: 3, trigger: "default" } : undefined);
    expect(automaticAnalysisBudget(false, backend)).toBeUndefined();
  });
  it("false bypasses every lifecycle hook even for a finalized live result", async () => {
    const original = markFinalizedStudyResult({ cwd, runId: "opted-out", dryRun: false, ok: true }, await prepareRunArtifactPaths(cwd, "opted-out"));
    const run = vi.fn(); const onStart = vi.fn();
    const disabled = resolveAutomaticAnalysis(false);
    expect(disabled.ok).toBe(true);
    expect(await completeAutomaticAnalysis(original, disabled.ok ? disabled.config : undefined, { run, onStart })).toBe(original);
    expect(run).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled();
  });
  it.each((["default", "explicit"] as const).flatMap(trigger => ["", " \t\n"].map(apiKey => ({ trigger, apiKey }))))("a missing key records a skip, preserving success only for $trigger requests (key $apiKey)", async ({ trigger, apiKey }) => {
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: "keyless" });
    const prepared = (await resolveRunPath(cwd, "keyless"))!;
    const file = path.join(prepared.physicalRunRoot, "run.json");
    const source = JSON.parse(await readFile(file, "utf8"));
    source.mode = "live"; source.streams[0].status = "complete";
    await writeFile(file, JSON.stringify(source));
    await rm(path.join(prepared.physicalRunRoot, "status.json"));
    const original = await readFile(file);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("No provider dispatch permitted"); });
    const result = await completeAutomaticAnalysis(markFinalizedStudyResult({ cwd, runId: "keyless", dryRun: false, ok: true }, prepared),
      { ...config, maxCostUsd: 0.000001 }, { deps: { apiKey, fetch } }, trigger);
    expect(result.automaticAnalysis).toMatchObject({ state: "skipped", reason: trigger === "default" ? "AUTOMATIC_ANALYSIS_KEY_MISSING" : "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED" });
    expect(automaticAnalysisEnvelope(result)).toMatchObject({ runOk: true, ok: trigger === "default" });
    expect((await readRunDetail(cwd, "keyless"))?.automaticAnalysis).toMatchObject({ state: "skipped", reason: trigger === "default" ? "AUTOMATIC_ANALYSIS_KEY_MISSING" : "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED" });
    expect(fetch).not.toHaveBeenCalled(); expect(await readFile(file)).toEqual(original);
  });
  it("first-contact and the release gate preserve their explicit zero-spend product scope", async () => {
    const raw = parseYaml(await readFile(path.resolve("humanish/labs/first-contact.yaml"), "utf8"));
    expect(raw.review.analysis).toBe(false);
    expect(parseLabConfig(raw).ok).toBe(true);
    expect(await readFile(path.resolve("scripts/release-dogfood.mjs"), "utf8")).toContain("must explicitly disable automatic analysis");
  });
  it("the advertised zero-model-spend scripted demo explicitly disables analysis", async () => {
    const raw = parseYaml(await readFile(path.resolve("humanish/labs/scripted-demo.yaml"), "utf8"));
    expect(raw.review.analysis).toBe(false);
    expect(parseLabConfig(raw).ok).toBe(true);
  });
  it.each([undefined, false, { maxCostUsd: 7 }])("metadata preflight and TUI summary disclose resolved budget %j without dispatch", async setting => {
    const base = fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!.config;
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    const manifest = { ...base, ...(setting === undefined ? {} : { review: { analysis: setting } }) };
    await writeFile(path.join(cwd, "humanish", "labs", "budget.yaml"), JSON.stringify(manifest));
    const preflight = await runLabPreflight({ cwd, lab: "budget", env: {} });
    expect(preflight.spend).toEqual({ e2bDesktop: false, model: false });
    expect(preflight.analysis).toEqual(automaticAnalysisBudget(setting, "cua"));
    expect((await readLabSummary(cwd, "budget"))?.analysis).toEqual(preflight.analysis);
    let stdout = "";
    const program = createProgram({ writeOut: text => { stdout += text; }, writeErr: () => {}, setExitCode: () => {} });
    await program.parseAsync(["node", "humanish", "lab", "preflight", "budget", "--cwd", cwd]);
    if (setting === false) expect(stdout).not.toContain("After live runs:");
    else { expect(stdout).toContain(`separate $${typeof setting === "object" ? setting.maxCostUsd : 3} admission estimate limit`); expect(stdout).toContain("not a provider billing cap"); }
  });
  it.each(fixtures)("parses opt-in only on eligible producer routes: $name", ({ config: base, backend }) => {
    const parsed = parseLabConfig({ ...base, review: { analysis: { maxCostUsd: 5 } } });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(supported.has(backend));
    if (parsed.ok) expect(parsed.config.review?.analysis).toEqual({ maxCostUsd: 5 });
  });
  it.each(fixtures.filter(row => !supported.has(row.backend)))("fails direct unsupported $name before filesystem effects", async ({ config: base }) => {
    const outcome = await runLab({ ...base, review: { analysis: { maxCostUsd: 5 } } }, { cwd: path.join(cwd, "absent"), dryRun: false });
    expect(outcome.result.error?.code).toBe("HUMANISH_LAB_ANALYSIS_UNSUPPORTED");
    expect(await readdir(cwd)).toEqual([]);
  });
  it.each([runCuaActorLab, runScriptedBrowserLab, runTerminalProductLab, runSharedWorldLab, runConcurrentSharedWorld])("validates direct producer config before hooks", async runner => {
    const base = fixtures.find(row => row.backend === "cua")!.config;
    const forbidden = vi.fn(async () => { throw new Error("forbidden hook"); });
    const result = await runner({ cwd: path.join(cwd, "absent"), config: { ...base, review: { analysis: { maxCostUsd: 0 } } }, dryRun: false,
      hooks: { env: {}, loadDesktopModule: forbidden, runSession: forbidden, buildExecutor: forbidden, buildProvider: forbidden, renderObserverFn: forbidden } });
    expect(result.error?.code).toBe("HUMANISH_LAB_ANALYSIS_INVALID");
    expect(forbidden).not.toHaveBeenCalled();
    await expect(access(path.join(cwd, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["cua", "scripted", "terminal", "shared-world", "concurrent-shared-world"])("runLab %s dry-run skips post-run spend exactly once", async backend => {
    const base = fixtures.find(row => row.backend === backend)!.config;
    const run = vi.fn(); const onStart = vi.fn();
    const output = await runLab(base,
      { cwd, dryRun: true, open: false, automaticAnalysis: { run, onStart } });
    expect(output.backend).toBe(backend);
    expect(output.result).toMatchObject({ automaticAnalysis: { state: "skipped", reason: "analysis_dry_run" } });
    expect(run).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled();
  });
  it("dry-run never invokes the analysis lifecycle or provider", async () => {
    const run = vi.fn(); const onStart = vi.fn();
    const result = await completeAutomaticAnalysis({ cwd, runId: "dry", dryRun: true, ok: true }, config, { run, onStart });
    expect(result.automaticAnalysis).toEqual({ state: "skipped", reason: "analysis_dry_run" });
    expect(run).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled();
    expect(automaticAnalysisSucceeded(result)).toBe(true);
  });
  it("keeps a failed participant result while reviewing its finalized recording exactly once", async () => {
    const run = vi.fn(async () => ({ state: "failed", reason: "analysis_validation_failed" }) as AutomaticStudyAnalysisOutcome);
    const cleanup = vi.fn(); const onStart = vi.fn(() => cleanup);
    const prepared = await prepareRunArtifactPaths(cwd, "exact-recording");
    const original = markFinalizedStudyResult({ cwd, runId: "exact-recording", dryRun: false, ok: false, session: { status: "incomplete" } }, prepared);
    const result = await completeAutomaticAnalysis(original, config, { run, onStart });
    expect(run).toHaveBeenCalledExactlyOnceWith(cwd, "exact-recording", config, { expectedRun: prepared, preferLargerOutput: false });
    expect(result.session).toEqual(original.session); expect(result.ok).toBe(false);
    expect(onStart).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce();
    expect(original).not.toHaveProperty("automaticAnalysis");
  });
  it("uses the finalized physical project, not a later-retargeted cwd alias", async () => {
    const run = vi.fn(async () => ({ state: "failed", reason: "synthetic" }) as AutomaticStudyAnalysisOutcome);
    const prepared = await prepareRunArtifactPaths(cwd, "recording");
    const original = markFinalizedStudyResult({ cwd: "/synthetic/retargeted-alias", runId: "recording", dryRun: false }, prepared);
    const unrelated = await prepareRunArtifactPaths(cwd, "unrelated-recording");
    await completeAutomaticAnalysis(original, config, { run, deps: { expectedRun: unrelated } });
    expect(run).toHaveBeenCalledExactlyOnceWith(cwd, "recording", config, { expectedRun: prepared, preferLargerOutput: false });
  });
  it("rejects a replacement recording after final publication instead of rebinding before dispatch", async () => {
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    await runDryRun({ cwd, dryRun: true, runId: "pinned-source" });
    const prepared = (await resolveRunPath(cwd, "pinned-source"))!;
    // Existing synthetic live-source construction, matching the coordinator's retained-source tests.
    const bundle = JSON.parse(await readFile(path.join(prepared.physicalRunRoot, "run.json"), "utf8"));
    bundle.mode = "live"; bundle.streams[0].status = "complete";
    await writeFile(path.join(prepared.physicalRunRoot, "run.json"), JSON.stringify(bundle));
    await rm(path.join(prepared.physicalRunRoot, "status.json"));
    expect((await verifyRun(cwd, "pinned-source")).ok).toBe(true);
    const staging = path.join(cwd, "replacement-staging");
    const originalRoot = path.join(cwd, "original-retained");
    await cp(prepared.physicalRunRoot, staging, { recursive: true });
    const result = markFinalizedStudyResult({ cwd, runId: "pinned-source", dryRun: false, ok: true }, prepared);
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error("unexpected provider call"); });
    const cleanup = vi.fn();
    const output = await completeAutomaticAnalysis(result, config, { deps: { apiKey: "synthetic", fetch }, onStart: () => {
      renameSync(prepared.physicalRunRoot, originalRoot); renameSync(staging, prepared.physicalRunRoot);
      return cleanup;
    } });
    expect(output.automaticAnalysis).toEqual({ state: "failed", reason: "analysis_source_changed" });
    expect(fetch).not.toHaveBeenCalled(); expect(cleanup).toHaveBeenCalledOnce();
    expect((await verifyRun(cwd, "pinned-source")).ok).toBe(true);
    for (const root of [prepared.physicalRunRoot, originalRoot]) {
      await expect(access(path.join(root, "analysis-automatic"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(path.join(root, "analysis-attempts"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("an early producer refusal cannot spend on an existing supplied run ID", async () => {
    const base = fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!.config;
    const prior = await runCuaActorLab({ cwd, config: base, dryRun: true, runId: "prior-recording", open: false });
    expect(prior.runId).toBe("prior-recording");
    const before = await readFile(path.join(cwd, ".humanish", "runs", "prior-recording", "run.json"));
    const run = vi.fn(); const onStart = vi.fn();
    const refused = await runCuaActorLab({ cwd, config: { ...base, actors: [{ type: "unsupported" }], review: { analysis: { maxCostUsd: 5 } } },
      dryRun: false, runId: "prior-recording", automaticAnalysis: { run, onStart } });
    expect(refused.ok).toBe(false); expect(refused.automaticAnalysis?.state).toBe("skipped");
    expect(run).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled();
    expect(await readFile(path.join(cwd, ".humanish", "runs", "prior-recording", "run.json"))).toEqual(before);
    await expect(access(path.join(cwd, ".humanish", "runs", "prior-recording", "analysis-automatic"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never analyzes an older caller-named recording when the producer refused before completion", async () => {
    const run = vi.fn(); const onStart = vi.fn();
    const result = await completeAutomaticAnalysis({ cwd, runId: "older-recording", dryRun: false, ok: false }, config, { run, onStart });
    expect(result.automaticAnalysis).toEqual({ state: "skipped", reason: "analysis_source_unavailable" });
    expect(run).not.toHaveBeenCalled(); expect(onStart).not.toHaveBeenCalled();
  });
  it("retains the run after an analysis exception without exposing exception text", async () => {
    const cleanup = vi.fn();
    const result = await completeAutomaticAnalysis(markFinalizedStudyResult({ cwd, runId: "retained", dryRun: false, ok: true }, await prepareRunArtifactPaths(cwd, "retained")), config,
      { run: async () => { throw new Error("private provider response"); }, onStart: () => cleanup });
    expect(result.ok).toBe(true); expect(result.automaticAnalysis?.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private provider"); expect(cleanup).toHaveBeenCalledOnce();
    expect(automaticAnalysisEnvelope(result)).toMatchObject({ ok: false, runOk: true });
  });
  it("partial status cannot turn an analysis error into CLI success", () => {
    expect(automaticAnalysisSucceeded({ automaticAnalysis: { state: "partial", reason: "analysis_admission_estimate_exceeded" } })).toBe(false);
  });
  it("announces preparation before admission without claiming a provider request", () => {
    const writeErr = vi.fn();
    const hooks = cliAutomaticAnalysisHooks({ writeErr });
    const cleanup = hooks.onStart!();
    try { expect(writeErr).toHaveBeenCalledExactlyOnceWith("Participants finished; preparing analysis…\n"); }
    finally { if (typeof cleanup === "function") cleanup(); }
  });
  it.each([["run"], ["lab", "run"], ["watch"]])("CLI %j discloses default analysis before a keyless live start", async (...prefix) => {
    vi.stubEnv("E2B_API_KEY", "");
    const base = fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!.config;
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "labs", "default.yaml"), JSON.stringify(base));
    let stdout = ""; let stderr = "";
    const program = createProgram({ writeOut: text => { stdout += text; }, writeErr: text => { stderr += text; }, setExitCode: () => {} });
    await program.parseAsync(["node", "humanish", ...prefix, "default", "--cwd", cwd, "--json", "--no-open", "--detach"]);
    expect(stderr).toContain("default analysis · gpt-6-astra · separate $3 admission estimate limit");
    expect(stderr).toContain("not a provider billing cap");
    expect(stderr).not.toContain("preparing analysis");
    expect(JSON.parse(stdout).ok).toBe(false); // Missing participant keys, before any recording/provider.
  });
  it.each([{ prefix: ["run"] }, { prefix: ["lab", "run"] }, { prefix: ["watch"] }])("CLI entry $prefix reports dry-run skip without starting analysis", async ({ prefix }) => {
    const base = fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!.config;
    await mkdir(path.join(cwd, "humanish", "labs"), { recursive: true });
    await writeFile(path.join(cwd, "humanish", "labs", "review.yaml"), JSON.stringify({ ...base, review: { analysis: { maxCostUsd: 5 } } }));
    let stdout = ""; let stderr = ""; let exit = 0;
    const program = createProgram({ writeOut: value => { stdout += value; }, writeErr: value => { stderr += value; }, setExitCode: value => { exit = value; } });
    await program.parseAsync(["node", "humanish", ...prefix, "review", "--cwd", cwd, "--dry-run", "--no-open", "--json"]);
    const result = JSON.parse(stdout);
    expect(result.automaticAnalysis).toEqual({ state: "skipped", reason: "analysis_dry_run" });
    expect(result.ok).toBe(result.runOk);
    expect(exit).toBe(result.ok ? 0 : 2);
    expect(stderr).not.toContain("preparing analysis");
  });
  it("TUI cancellation of finished source only writes the safe marker, never signals a PID", async () => {
    const base = fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!.config;
    const prior = await runCuaActorLab({ cwd, config: base, dryRun: true, runId: "finished-source", open: false });
    const cancel = vi.spyOn(automaticJobs, "requestAutomaticStudyAnalysisCancellation").mockResolvedValue({ requested: true, reason: null });
    const kill = vi.spyOn(process, "kill");
    const result = await stopRun(cwd, prior.runId);
    expect(result.ok).toBe(true); expect(result.message).toContain("analysis");
    expect(cancel).toHaveBeenCalledExactlyOnceWith(cwd, prior.runId); expect(kill).not.toHaveBeenCalled();
  });
  it.each(["running", "missing", "malformed"])("analysis cancellation never signals after source status becomes %s", async state => {
    const base = fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!.config;
    await runCuaActorLab({ cwd, config: base, dryRun: true, runId: "changed-status", open: false });
    const prepared = await resolveRunPath(cwd, "changed-status");
    if (!prepared) throw new Error("missing synthetic run");
    // Queue metadata is synthetic here; this test exercises cancellation authority, never admission.
    const job = await claimAutomaticStudyAnalysis(prepared, { configDigest: "a".repeat(64), promptVersion: "study-evidence-4" });
    expect(job).not.toBeNull();
    const statusPath = path.join(prepared.absoluteRunRoot, "status.json");
    if (state === "missing") await rm(statusPath);
    else await writeFile(statusPath, state === "malformed" ? "{" : JSON.stringify({
      schema: "humanish.run-status.v1", runId: "changed-status", state: "running", mode: "live", pid: 424242,
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    }));
    expect((await readRunDetail(cwd, "changed-status"))?.automaticAnalysis?.state).toBe("queued");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const result = await stopRun(cwd, "changed-status", "analysis");
    expect(result.ok).toBe(true); expect(await job!.cancellationRequested()).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  });
  it("failed marker cancellation cannot fall back to signalling a recorded process", async () => {
    const cancel = vi.spyOn(automaticJobs, "requestAutomaticStudyAnalysisCancellation").mockResolvedValue({ requested: false, reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect((await stopRun(cwd, "absent", "analysis")).ok).toBe(false);
    expect(cancel).toHaveBeenCalledOnce(); expect(kill).not.toHaveBeenCalled();
  });
  it.each(["SIGTERM", "SIGINT"] as const)("%s during the real producer retains default termination and never starts analysis", async signal => {
    const script = `
      import { runLab } from ${JSON.stringify(new URL("../src/lab-engine.ts", import.meta.url).href)};
      import { cliAutomaticAnalysisHooks } from ${JSON.stringify(new URL("../src/program.ts", import.meta.url).href)};
      const config = ${JSON.stringify(fixtures.find(row => row.name === "cua-openai-computer-use-app-url")!.config)};
      config.review = { analysis: { maxCostUsd: 5 } };
      const timer = setInterval(() => {}, 1000);
      const automaticAnalysis = cliAutomaticAnalysisHooks({ writeErr: text => process.stderr.write(text) });
      automaticAnalysis.run = async () => { process.stdout.write("UNEXPECTED_ANALYSIS\\n"); return { state: "failed", reason: "synthetic" }; };
      await runLab(config, { cwd: ${JSON.stringify(cwd)}, dryRun: false, open: false, automaticAnalysis,
        cuaHooks: { env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" },
          loadDesktopModule: async () => { process.stdout.write("ACTOR_READY\\n"); await new Promise(() => {}); } } });
      clearInterval(timer);
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("producer did not reach actor setup")), 15000);
        child.stdout.on("data", chunk => { output += String(chunk); if (output.includes("ACTOR_READY")) { clearTimeout(timer); resolve(); } });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("producer exited before actor setup")); });
      });
      child.kill(signal);
      expect((await exited).signal).toBe(signal);
      expect(output).not.toContain("UNEXPECTED_ANALYSIS");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  }, 20000);
  it("installs cancellation handlers only for the analysis phase and removes them afterward", () => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const counts = signals.map(signal => process.listenerCount(signal));
    const hooks = cliAutomaticAnalysisHooks({ writeErr: vi.fn() });
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(counts);
    const cleanup = hooks.onStart!();
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(counts.map(n => n + 1));
    process.emit("SIGTERM");
    expect(hooks.deps?.signal?.aborted).toBe(true);
    if (cleanup) cleanup();
    expect(signals.map(signal => process.listenerCount(signal))).toEqual(counts);
  });
});
