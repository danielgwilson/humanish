import { renameSync } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisFetch } from "../../src/analysis/provider.js";
import { parseStudy } from "../../src/study/config.js";
import {
  automaticAnalysisBudget,
  resolveAutomaticAnalysis,
} from "../../src/analysis/automatic-config.js";
import {
  completeAutomaticAnalysis,
  automaticAnalysisSucceeded,
} from "../../src/analysis/automatic-completion.js";
import { FinishedRun } from "../../src/run/run.js";
import { asLiveRecording, publishRun } from "../helpers/finished-run.js";
import { automaticAnalysisEnvelope, writeResult } from "../../src/cli/io.js";
import { cliAnalysisOptions } from "../../src/cli/commands/analysis-signals.js";
import { createProgram } from "../../src/cli/program.js";
import { readStudySummary } from "../../src/study/summary.js";
import { runStudyPreflight } from "../../src/study/preflight.js";
import { parse as parseYaml } from "yaml";
import { runStudyWith } from "../../src/run-study.js";
import { claimAutomaticAnalysis } from "../../src/analysis/job.js";
import { prepareRunArtifactPaths } from "../../src/run/paths.js";
import { resolveRunPath } from "../../src/run/locate.js";
import { verifyRun } from "../../src/verify/verify.js";
import { readRunDetail } from "../../src/run/detail.js";
import { stopRun } from "../../src/tui/actions.js";
import * as automaticJobs from "../../src/analysis/automatic.js";
import { routeOf } from "../../src/study/plan.js";
import type { AutomaticAnalysisOutcome } from "../../src/analysis/job.js";
import { libraryConfig } from "../helpers/library-config.js";
import { studyFileText } from "../helpers/study-file.js";
import { runComputerUse, runScripted, runSharedWorld, runTerminal } from "../helpers/route-run.js";

const fixtures = JSON.parse(
  await readFile(new URL("../fixtures/task-route-preflight/labs.json", import.meta.url), "utf8"),
) as Array<{ name: string; config: Record<string, unknown>; route: string }>;
const resolved = resolveAutomaticAnalysis({ maxCostUsd: 5 });
if (!resolved.ok || !resolved.config || resolved.config.provider === "codex")
  throw new Error("invalid synthetic test config");
const config = resolved.config;

describe("automatic analysis admission and producer boundary", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-auto-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it("defaults use a separate three-dollar admission budget and false opts out", () => {
    expect(config).toEqual({
      model: "gpt-6-astra",
      maxCostUsd: 5,
      question: null,
      timeoutMs: 600000,
      maxOutputTokens: 16384,
    });
    expect(resolveAutomaticAnalysis(undefined)).toEqual({
      ok: true,
      config: { ...config, maxCostUsd: 3 },
      preferLargerOutput: true,
    });
    expect(resolveAutomaticAnalysis({ maxCostUsd: 3, maxOutputTokens: 16384 })).not.toHaveProperty(
      "preferLargerOutput",
    );
    expect(resolveAutomaticAnalysis(false)).toEqual({ ok: true, config: undefined });
  });
  it.each([
    null,
    true,
    {},
    { maxCostUsd: 0 },
    { maxCostUsd: Infinity },
    { maxCostUsd: 1001 },
    { maxCostUsd: 2, model: "unsupported" },
    { maxCostUsd: 2, timeoutMs: 0 },
    { maxCostUsd: 2, timeoutMs: 1.5 },
    { maxCostUsd: 2, maxOutputTokens: 32769 },
    { maxCostUsd: 2, question: null },
    { maxCostUsd: 2, question: "x".repeat(4001) },
    { maxCostUsd: 2, enabled: true },
    { maxCostUsd: 2, maxCost: 1 },
  ])("rejects malformed settings %j", (raw) => {
    expect(resolveAutomaticAnalysis(raw).ok).toBe(false);
  });
  it.each(fixtures)("preserves explicit opt-out on every route: $name", ({ config: base }) => {
    const parsed = parseStudy({ ...base, review: { analysis: false } });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.review?.analysis).toBe(false);
  });
  it.each(fixtures)("only describes defaults for routes with participants: $name", ({ config }) => {
    const route = routeOf(libraryConfig(config));
    expect(automaticAnalysisBudget(undefined, route)).toEqual(
      route === "preview" ? undefined : { model: "gpt-6-astra", maxCostUsd: 3, trigger: "default" },
    );
    expect(automaticAnalysisBudget(false, route)).toBeUndefined();
  });
  it("starts no analysis and prints no analysis line for a run a signal interrupted", async () => {
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const finished = await publishRun(cwd, "interrupted", {
      shape: asLiveRecording,
      interruptedBy: "SIGINT",
    });
    expect(finished.interrupted).toBe(true);
    const run = vi.fn();
    const writeErr = vi.fn();
    const { onEvent } = cliAnalysisOptions({ writeErr });
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "interrupted", dryRun: false, ok: false },
      finished,
      config,
      { deps: { analysis: { run } }, emit: (event) => void onEvent!(event) },
    );
    expect(result.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_ACTOR_CANCELLED",
    });
    expect(run).not.toHaveBeenCalled();
    expect(writeErr).not.toHaveBeenCalled();
    const bundle = JSON.parse(
      await readFile(path.join(finished.paths.physicalRunRoot, "run.json"), "utf8"),
    ) as { outcome?: { state?: string } };
    expect(bundle.outcome?.state).toBe("interrupted");
  });
  it("records the analysis of a run where no participant ran, without the analysis events", async () => {
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    // A run that failed at E2B login: its route reported no session start.
    const ran = await publishRun(cwd, "participant-ran");
    const none = await publishRun(cwd, "no-participant", { noParticipant: true });
    const skip = {
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_NO_PARTICIPANT_EVIDENCE",
    } as AutomaticAnalysisOutcome;
    const run = vi.fn(async () => skip);
    const writeErr = vi.fn();
    const { onEvent } = cliAnalysisOptions({ writeErr });
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "no-participant", dryRun: false, ok: false },
      none,
      config,
      { deps: { analysis: { run } }, emit: (event) => void onEvent!(event) },
    );
    expect(run).toHaveBeenCalledOnce();
    expect(result.automaticAnalysis).toEqual(skip);
    expect(writeErr).not.toHaveBeenCalled();
    await completeAutomaticAnalysis(
      { cwd, runId: "participant-ran", dryRun: false, ok: false },
      ran,
      config,
      { deps: { analysis: { run } }, emit: (event) => void onEvent!(event) },
    );
    expect(writeErr).toHaveBeenCalledOnce();
    expect([ran.participantsRan, none.participantsRan]).toEqual([true, false]);
  });
  it("a run that finished before any signal is not marked interrupted", async () => {
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const finished = await publishRun(cwd, "finished", { shape: asLiveRecording });
    expect(finished.interrupted).toBe(false);
  });
  it("false bypasses every lifecycle hook even for a finalized live result", async () => {
    const original = { cwd, runId: "opted-out", dryRun: false, ok: true };
    const finished = await publishRun(cwd, "opted-out");
    const run = vi.fn();
    const emit = vi.fn();
    const disabled = resolveAutomaticAnalysis(false);
    expect(disabled.ok).toBe(true);
    expect(
      await completeAutomaticAnalysis(
        original,
        finished,
        disabled.ok ? disabled.config : undefined,
        { deps: { analysis: { run } }, emit },
      ),
    ).toBe(original);
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it.each(
    (["default", "explicit"] as const).flatMap((trigger) =>
      ["", " \t\n"].map((apiKey) => ({ trigger, apiKey })),
    ),
  )(
    "a missing key records a skip, preserving success only for $trigger requests (key $apiKey)",
    async ({ trigger, apiKey }) => {
      await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
      const finished = await publishRun(cwd, "keyless", { shape: asLiveRecording });
      const file = path.join(finished.paths.physicalRunRoot, "run.json");
      const original = await readFile(file);
      const fetch = vi.fn<AnalysisFetch>(async () => {
        throw new Error("No provider dispatch permitted");
      });
      const result = await completeAutomaticAnalysis(
        { cwd, runId: "keyless", dryRun: false, ok: true },
        finished,
        { ...config, maxCostUsd: 0.000001 },
        { deps: { analysis: { deps: { apiKey, fetch } } } },
        { trigger },
      );
      expect(result.automaticAnalysis).toMatchObject({
        state: "skipped",
        reason:
          trigger === "default"
            ? "AUTOMATIC_ANALYSIS_KEY_MISSING"
            : "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED",
      });
      expect(automaticAnalysisEnvelope(result)).toMatchObject({
        runOk: true,
        ok: trigger === "default",
      });
      expect((await readRunDetail(cwd, "keyless"))?.automaticAnalysis).toMatchObject({
        state: "skipped",
        reason:
          trigger === "default"
            ? "AUTOMATIC_ANALYSIS_KEY_MISSING"
            : "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(file)).toEqual(original);
    },
  );
  it("first-contact and the release gate preserve their explicit zero-spend product scope", async () => {
    const raw = parseYaml(
      await readFile(path.resolve("humanish/studies/first-contact.yaml"), "utf8"),
    );
    expect(raw.review.analysis).toBe(false);
    expect(raw.execution.runtimeAuth).toBe("openai-egress");
    expect(parseStudy(raw).ok).toBe(true);
    expect(await readFile(path.resolve("scripts/release-dogfood.mjs"), "utf8")).toContain(
      "must explicitly disable automatic analysis",
    );
  });
  it("the advertised zero-model-spend scripted demo explicitly disables analysis", async () => {
    const raw = parseYaml(
      await readFile(path.resolve("humanish/studies/scripted-demo.yaml"), "utf8"),
    );
    expect(raw.review.analysis).toBe(false);
    expect(parseStudy(raw).ok).toBe(true);
  });
  it.each([undefined, false, { maxCostUsd: 7 }])(
    "metadata preflight and TUI summary disclose resolved budget %j without dispatch",
    async (setting) => {
      const base = fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!.config;
      await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
      const manifest = {
        ...base,
        ...(setting === undefined ? {} : { review: { analysis: setting } }),
      };
      await writeFile(
        path.join(cwd, "humanish", "studies", "budget.yaml"),
        studyFileText(manifest, cwd),
      );
      const preflight = await runStudyPreflight({ cwd, study: "budget", env: {} });
      expect(preflight.spend).toEqual({ e2bDesktop: false, model: false });
      expect(preflight.analysis).toEqual(automaticAnalysisBudget(setting, "computer-use"));
      expect((await readStudySummary(cwd, "budget"))?.analysis).toEqual(preflight.analysis);
      let stdout = "";
      const program = createProgram({
        writeOut: (text) => {
          stdout += text;
        },
        writeErr: () => {},
        setExitCode: () => {},
      });
      await program.parseAsync(["node", "humanish", "study", "check", "budget", "--cwd", cwd]);
      if (setting === false) expect(stdout).not.toContain("After live runs:");
      else {
        expect(stdout).toContain(
          `refused before it starts if its estimate is over $${typeof setting === "object" ? setting.maxCostUsd : 3}; this is not a billing cap`,
        );
      }
    },
  );
  it.each(fixtures)("parses opt-in only on eligible producer routes: $name", ({ config: base }) => {
    const parsed = parseStudy({ ...base, review: { analysis: { maxCostUsd: 5 } } });
    expect(parsed.ok, JSON.stringify(parsed)).toBe(routeOf(libraryConfig(base)) !== "preview");
    if (parsed.ok) expect(parsed.config.review?.analysis).toEqual({ maxCostUsd: 5 });
  });
  it.each(fixtures.filter((row) => routeOf(libraryConfig(row.config)) === "preview"))(
    "fails direct unsupported $name before filesystem effects",
    async ({ config: base }) => {
      const outcome = await runStudyWith(
        libraryConfig({ ...base, review: { analysis: { maxCostUsd: 5 } } }),
        { cwd: path.join(cwd, "absent"), dryRun: false },
      );
      expect(outcome.result.error?.code).toBe("HUMANISH_STUDY_ANALYSIS_UNSUPPORTED");
      expect(await readdir(cwd)).toEqual([]);
    },
  );
  it.each([runComputerUse, runScripted, runTerminal, runSharedWorld])(
    "validates direct producer config before hooks",
    async (runner) => {
      const base = fixtures.find((row) => row.route === "computer-use")!.config;
      const forbidden = vi.fn(async () => {
        throw new Error("forbidden hook");
      });
      const result = await runner({
        cwd: path.join(cwd, "absent"),
        config: libraryConfig({ ...base, review: { analysis: { maxCostUsd: 0 } } }),
        dryRun: false,
        env: {},
        deps: {
          desktopModule: forbidden,
          runSession: forbidden,
          renderObserver: forbidden,
        },
        inProcess: { executor: forbidden },
        createProvider: forbidden,
      });
      expect(result.error?.code).toBe("HUMANISH_STUDY_ANALYSIS_INVALID");
      expect(forbidden).not.toHaveBeenCalled();
      await expect(access(path.join(cwd, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each(["computer-use", "scripted", "terminal", "shared-world"])(
    "runStudy %s dry-run skips post-run spend exactly once",
    async (route) => {
      const base = libraryConfig(fixtures.find((row) => row.route === route)!.config);
      const run = vi.fn();
      const onEvent = vi.fn();
      const output = await runStudyWith(
        base,
        {
          cwd,
          dryRun: true,
          open: false,
          onEvent,
        },
        { analysis: { run } },
      );
      expect(output.route).toBe(routeOf(base));
      expect(output.result).toMatchObject({
        automaticAnalysis: { state: "skipped", reason: "AUTOMATIC_ANALYSIS_DRY_RUN" },
      });
      expect(run).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalledWith({ type: "analysis-started" });
    },
  );
  it("dry-run never invokes the analysis lifecycle or provider", async () => {
    const run = vi.fn();
    const emit = vi.fn();
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "dry", dryRun: true, ok: true },
      undefined,
      config,
      { deps: { analysis: { run } }, emit },
    );
    expect(result.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_DRY_RUN",
    });
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(automaticAnalysisSucceeded(result)).toBe(true);
  });
  it("keeps a failed participant result while reviewing its finalized recording exactly once", async () => {
    const run = vi.fn(
      async () =>
        ({
          state: "failed",
          reason: "analysis_validation_failed",
        }) as AutomaticAnalysisOutcome,
    );
    const emit = vi.fn();
    const finished = await publishRun(cwd, "exact-recording");
    const prepared = finished.paths;
    const original = {
      cwd,
      runId: "exact-recording",
      dryRun: false,
      ok: false,
      session: { status: "incomplete" },
    };
    const result = await completeAutomaticAnalysis(original, finished, config, {
      deps: { analysis: { run } },
      emit,
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(cwd, "exact-recording", config, {
      expectedRun: prepared,
      preferLargerOutput: false,
    });
    expect(result.session).toEqual(original.session);
    expect(result.ok).toBe(false);
    expect(emit.mock.calls).toEqual([
      [{ type: "analysis-started" }],
      [{ type: "analysis-finished" }],
    ]);
    expect(original).not.toHaveProperty("automaticAnalysis");
  });
  it("hands analysisSignal and the route's refusal to the analysis", async () => {
    const run = vi.fn(
      async () => ({ state: "failed", reason: "synthetic" }) as AutomaticAnalysisOutcome,
    );
    const finished = await publishRun(cwd, "signalled");
    const signal = new AbortController().signal;
    const refusal = () => undefined;
    await completeAutomaticAnalysis(
      { cwd, runId: "signalled", dryRun: false },
      finished,
      config,
      { deps: { analysis: { run } }, analysisSignal: signal },
      { refusal },
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(cwd, "signalled", config, {
      signal,
      refusal,
      expectedRun: finished.paths,
      preferLargerOutput: false,
    });
  });
  it("uses the finalized physical project, not a later-retargeted cwd alias", async () => {
    const run = vi.fn(
      async () => ({ state: "failed", reason: "synthetic" }) as AutomaticAnalysisOutcome,
    );
    const finished = await publishRun(cwd, "recording");
    const prepared = finished.paths;
    const original = { cwd: "/synthetic/retargeted-alias", runId: "recording", dryRun: false };
    const unrelated = await prepareRunArtifactPaths(cwd, "unrelated-recording");
    await completeAutomaticAnalysis(original, finished, config, {
      deps: { analysis: { run, deps: { expectedRun: unrelated } } },
    });
    expect(run).toHaveBeenCalledExactlyOnceWith(cwd, "recording", config, {
      expectedRun: prepared,
      preferLargerOutput: false,
    });
  });
  it("rejects a replacement recording after final publication instead of rebinding before dispatch", async () => {
    await cp(path.resolve("fixtures/minimal-app"), cwd, { recursive: true });
    const finished = await publishRun(cwd, "pinned-source", { shape: asLiveRecording });
    const prepared = finished.paths;
    expect((await verifyRun(cwd, "pinned-source")).ok).toBe(true);
    const staging = path.join(cwd, "replacement-staging");
    const originalRoot = path.join(cwd, "original-retained");
    await cp(prepared.physicalRunRoot, staging, { recursive: true });
    const result = { cwd, runId: "pinned-source", dryRun: false, ok: true };
    const fetch = vi.fn<AnalysisFetch>(async () => {
      throw new Error("unexpected provider call");
    });
    const cleanup = vi.fn();
    const output = await completeAutomaticAnalysis(result, finished, config, {
      deps: { analysis: { deps: { apiKey: "synthetic", fetch } } },
      emit: (event) => {
        if (event.type === "analysis-finished") return cleanup();
        renameSync(prepared.physicalRunRoot, originalRoot);
        renameSync(staging, prepared.physicalRunRoot);
      },
    });
    expect(output.automaticAnalysis).toEqual({
      state: "failed",
      reason: "AUTOMATIC_ANALYSIS_SOURCE_CHANGED",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    expect((await verifyRun(cwd, "pinned-source")).ok).toBe(true);
    for (const root of [prepared.physicalRunRoot, originalRoot]) {
      await expect(access(path.join(root, "analysis-automatic"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(access(path.join(root, "analysis-attempts"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });
  it("an early producer refusal cannot spend on an existing supplied run ID", async () => {
    const base = fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!.config;
    const prior = await runComputerUse({
      cwd,
      config: libraryConfig(base),
      dryRun: true,
      runId: "prior-recording",
      open: false,
    });
    expect(prior.runId).toBe("prior-recording");
    const before = await readFile(
      path.join(cwd, ".humanish", "runs", "prior-recording", "run.json"),
    );
    const run = vi.fn();
    const emit = vi.fn();
    const refused = await runComputerUse({
      cwd,
      config: libraryConfig({
        ...base,
        actor: { type: "unsupported" },
        review: { analysis: { maxCostUsd: 5 } },
      }),
      dryRun: false,
      runId: "prior-recording",
      deps: { analysis: { run } },
      emit,
    });
    expect(refused.ok).toBe(false);
    expect(refused.automaticAnalysis?.state).toBe("skipped");
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(
      await readFile(path.join(cwd, ".humanish", "runs", "prior-recording", "run.json")),
    ).toEqual(before);
    await expect(
      access(path.join(cwd, ".humanish", "runs", "prior-recording", "analysis-automatic")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("never analyzes an older caller-named recording when the producer refused before completion", async () => {
    const run = vi.fn();
    const emit = vi.fn();
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "older-recording", dryRun: false, ok: false },
      undefined,
      config,
      { deps: { analysis: { run } }, emit },
    );
    expect(result.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it("never analyzes a run whose publication token names another run than the result", async () => {
    const run = vi.fn();
    const emit = vi.fn();
    const published = await publishRun(cwd, "published");
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "older-recording", dryRun: false, ok: true },
      published,
      config,
      { deps: { analysis: { run } }, emit },
    );
    expect(result.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
  it("accepts only an issued publication token, never an object shaped like one", async () => {
    const run = vi.fn();
    const forged = {
      runId: "forged",
      paths: await prepareRunArtifactPaths(cwd, "forged"),
      renderObserver: vi.fn(),
    } as unknown as FinishedRun;
    expect(FinishedRun.isIssued(forged)).toBe(false);
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "forged", dryRun: false, ok: true },
      forged,
      config,
      { deps: { analysis: { run } } },
    );
    expect(result.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_SOURCE_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("retains the run after an analysis exception without exposing exception text", async () => {
    const cleanup = vi.fn();
    const result = await completeAutomaticAnalysis(
      { cwd, runId: "retained", dryRun: false, ok: true },
      await publishRun(cwd, "retained"),
      config,
      {
        deps: {
          analysis: {
            run: async () => {
              throw new Error("private provider response");
            },
          },
        },
        emit: (event) => {
          if (event.type === "analysis-finished") cleanup();
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.automaticAnalysis?.state).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("private provider");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(automaticAnalysisEnvelope(result)).toMatchObject({ ok: false, runOk: true });
  });
  it("partial status cannot turn an analysis error into CLI success", () => {
    expect(
      automaticAnalysisSucceeded({
        automaticAnalysis: { state: "partial", reason: "analysis_admission_estimate_exceeded" },
      }),
    ).toBe(false);
  });
  describe("a default analysis over the default cap", () => {
    const overBudget = (code: string, trigger: "default" | "explicit") => ({
      runId: "over-budget",
      ok: true,
      automaticAnalysisTrigger: trigger,
      automaticAnalysis: {
        state: "skipped" as const,
        reason: "AUTOMATIC_ANALYSIS_ADMISSION_REFUSED",
        result: {
          schema: "humanish.analyze-result.v1",
          run: "over-budget",
          dryRun: false,
          reused: false,
          ok: false,
          admission: {
            allowed: false,
            error: code,
            inputTokenAllowance: 207482,
            outputTokenAllowance: 16384,
            estimatedCostUsd: 3.412725,
            ratesAsOf: "2026-09-03",
          },
          warnings: [],
          error: { code, message: "refused" },
        } as unknown as NonNullable<AutomaticAnalysisOutcome["result"]>,
      },
    });

    it("does not fail a run the author never asked to analyze", () => {
      expect(automaticAnalysisSucceeded(overBudget("analysis_budget_exceeded", "default"))).toBe(
        true,
      );
      expect(
        automaticAnalysisEnvelope(overBudget("analysis_budget_exceeded", "default")),
      ).toMatchObject({ ok: true, runOk: true });
    });

    it("still fails an explicitly requested analysis or any other admission refusal", () => {
      expect(automaticAnalysisSucceeded(overBudget("analysis_budget_exceeded", "explicit"))).toBe(
        false,
      );
      expect(automaticAnalysisSucceeded(overBudget("analysis_admission_denied", "default"))).toBe(
        false,
      );
    });

    it("tells a human the command that runs it", () => {
      const out: string[] = [];
      const io = {
        writeOut: (text: string) => out.push(text),
        writeErr: () => {},
        setExitCode: () => {},
      };
      const command = createProgram(io).command("probe-over-budget");
      writeResult(command, io, overBudget("analysis_budget_exceeded", "default"), () => "");
      expect(out.join("")).toContain("humanish analyze --run over-budget --max-cost 4");
    });
  });
  it("announces preparation before admission without claiming a provider request", () => {
    const writeErr = vi.fn();
    const { onEvent } = cliAnalysisOptions({ writeErr });
    void onEvent!({ type: "analysis-started" });
    try {
      expect(writeErr).toHaveBeenCalledExactlyOnceWith(
        "Participants finished; preparing analysis…\n",
      );
    } finally {
      void onEvent!({ type: "analysis-finished" });
    }
  });
  it.each([["run"], ["watch"]])(
    "CLI %j discloses default analysis before a live start",
    async (...prefix) => {
      // Placeholder keys pass the local checks, and a taken run id stops the run before anything
      // is acquired. A missing key would refuse before the disclosure.
      vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
      vi.stubEnv("E2B_API_KEY", "test-e2b-key");
      await mkdir(path.join(cwd, ".humanish", "runs", "taken-run"), { recursive: true });
      const base = fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!.config;
      await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
      await writeFile(
        path.join(cwd, "humanish", "studies", "default.yaml"),
        studyFileText(base, cwd),
      );
      let stdout = "";
      let stderr = "";
      const program = createProgram({
        writeOut: (text) => {
          stdout += text;
        },
        writeErr: (text) => {
          stderr += text;
        },
        setExitCode: () => {},
      });
      await program.parseAsync([
        "node",
        "humanish",
        ...prefix,
        "default",
        "--cwd",
        cwd,
        "--json",
        "--no-open",
        "--detach",
        "--run-id",
        "taken-run",
      ]);
      expect(stderr).toContain(
        "default analysis · gpt-6-astra · refused before it starts if its estimate is over $3; this is not a billing cap",
      );
      expect(stderr).not.toContain("preparing analysis");
      expect(JSON.parse(stdout)).toMatchObject({
        ok: false,
        error: { code: "HUMANISH_RUN_ID_IN_USE" },
      });
    },
  );
  it.each([{ prefix: ["run"] }, { prefix: ["watch"] }])(
    "CLI entry $prefix reports dry-run skip without starting analysis",
    async ({ prefix }) => {
      const base = fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!.config;
      await mkdir(path.join(cwd, "humanish", "studies"), { recursive: true });
      await writeFile(
        path.join(cwd, "humanish", "studies", "review.yaml"),
        studyFileText({ ...base, review: { analysis: { maxCostUsd: 5 } } }, cwd),
      );
      let stdout = "";
      let stderr = "";
      let exit = 0;
      const program = createProgram({
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
        setExitCode: (value) => {
          exit = value;
        },
      });
      await program.parseAsync([
        "node",
        "humanish",
        ...prefix,
        "review",
        "--cwd",
        cwd,
        "--dry-run",
        "--no-open",
        "--json",
      ]);
      const result = JSON.parse(stdout);
      expect(result.automaticAnalysis).toEqual({
        state: "skipped",
        reason: "AUTOMATIC_ANALYSIS_DRY_RUN",
      });
      expect(result.ok).toBe(result.runOk);
      expect(exit).toBe(result.ok ? 0 : 2);
      expect(stderr).not.toContain("preparing analysis");
    },
  );
  it("TUI cancellation of finished source only writes the safe marker, never signals a PID", async () => {
    const base = fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!.config;
    const prior = await runComputerUse({
      cwd,
      config: libraryConfig(base),
      dryRun: true,
      runId: "finished-source",
      open: false,
    });
    const cancel = vi
      .spyOn(automaticJobs, "requestAutomaticAnalysisCancellation")
      .mockResolvedValue({ requested: true, reason: null });
    const kill = vi.spyOn(process, "kill");
    const result = await stopRun(cwd, prior.runId);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("analysis");
    expect(cancel).toHaveBeenCalledExactlyOnceWith(cwd, prior.runId);
    expect(kill).not.toHaveBeenCalled();
  });
  it.each(["running", "missing", "malformed"])(
    "analysis cancellation never signals after source status becomes %s",
    async (state) => {
      const base = fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!.config;
      await runComputerUse({
        cwd,
        config: libraryConfig(base),
        dryRun: true,
        runId: "changed-status",
        open: false,
      });
      const prepared = await resolveRunPath(cwd, "changed-status");
      if (!prepared) throw new Error("missing synthetic run");
      // Queue metadata is synthetic here; this test exercises cancellation authority, never admission.
      const job = await claimAutomaticAnalysis(prepared, {
        configDigest: "a".repeat(64),
        promptVersion: "study-evidence-4",
      });
      expect(job).not.toBeNull();
      const statusPath = path.join(prepared.absoluteRunRoot, "status.json");
      if (state === "missing") await rm(statusPath);
      else
        await writeFile(
          statusPath,
          state === "malformed"
            ? "{"
            : JSON.stringify({
                schema: "humanish.run-status.v1",
                runId: "changed-status",
                state: "running",
                mode: "live",
                pid: 424242,
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }),
        );
      expect((await readRunDetail(cwd, "changed-status"))?.automaticAnalysis?.state).toBe("queued");
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      const result = await stopRun(cwd, "changed-status", "analysis");
      expect(result.ok).toBe(true);
      expect(await job!.cancellationRequested()).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    },
  );
  it("failed marker cancellation cannot fall back to signalling a recorded process", async () => {
    const cancel = vi
      .spyOn(automaticJobs, "requestAutomaticAnalysisCancellation")
      .mockResolvedValue({ requested: false, reason: "AUTOMATIC_ANALYSIS_OUTCOME_UNKNOWN" });
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect((await stopRun(cwd, "absent", "analysis")).ok).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
    expect(kill).not.toHaveBeenCalled();
  });
  it.each(["SIGTERM", "SIGINT"] as const)(
    "%s during the real producer retains default termination and never starts analysis",
    async (signal) => {
      const script = `
      import { runStudyWith } from ${JSON.stringify(new URL("../../src/run-study.ts", import.meta.url).href)};
      import { cliAnalysisOptions } from ${JSON.stringify(new URL("../../src/cli/commands/analysis-signals.ts", import.meta.url).href)};
      const config = ${JSON.stringify(libraryConfig(fixtures.find((row) => row.name === "cua-openai-computer-use-app-url")!.config))};
      config.review = { analysis: { maxCostUsd: 5 } };
      const timer = setInterval(() => {}, 1000);
      const analysis = cliAnalysisOptions({ writeErr: text => process.stderr.write(text) });
      const analysisSeam = { run: async () => { process.stdout.write("UNEXPECTED_ANALYSIS\\n"); return { state: "failed", reason: "synthetic" }; } };
      await runStudyWith(config, { cwd: ${JSON.stringify(cwd)}, dryRun: false, open: false, ...analysis,
        env: { OPENAI_API_KEY: "synthetic", E2B_API_KEY: "synthetic" } },
        { analysis: analysisSeam, desktopModule: async () => { process.stdout.write("ACTOR_READY\\n"); await new Promise(() => {}); } });
      clearInterval(timer);
    `;
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", script],
        { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once("exit", (code, signal) => resolve({ code, signal })),
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("producer did not reach actor setup")),
            15000,
          );
          child.stdout.on("data", (chunk) => {
            output += String(chunk);
            if (output.includes("ACTOR_READY")) {
              clearTimeout(timer);
              resolve();
            }
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("producer exited before actor setup"));
          });
        });
        child.kill(signal);
        expect((await exited).signal).toBe(signal);
        expect(output).not.toContain("UNEXPECTED_ANALYSIS");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  );
  it("installs cancellation handlers only for the analysis phase and removes them afterward", () => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const counts = signals.map((signal) => process.listenerCount(signal));
    const { onEvent, analysisSignal } = cliAnalysisOptions({ writeErr: vi.fn() });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(counts);
    void onEvent!({ type: "analysis-started" });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(
      counts.map((n) => n + 1),
    );
    process.emit("SIGTERM");
    expect(analysisSignal?.aborted).toBe(true);
    void onEvent!({ type: "analysis-finished" });
    expect(signals.map((signal) => process.listenerCount(signal))).toEqual(counts);
  });
});
