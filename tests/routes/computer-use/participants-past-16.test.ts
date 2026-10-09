// A live computer-use run of more than 16 participants on fake desktops ($0, real orchestration):
// it finishes, runs no more desktops at once than the E2B plan allows, and records its automatic
// analysis as skipped because one analysis reads at most 16 participants.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import { analysisOutcomeText, automaticAnalysisEnvelope } from "../../../src/cli/io.js";
import { runStudyWith } from "../../../src/run-study.js";
import { studyAnalysisSucceeded } from "../../../src/study/automatic-analysis-plan.js";
import { parseStudy } from "../../../src/study/config.js";
import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import {
  makeFanoutModule,
  scriptedFetch,
  TWO_TURN_SESSION,
  type FanoutModuleHandle,
} from "../../helpers/fanout-desktop.js";

const KEYS = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };
const SETTING = "HUMANISH_E2B_MAX_CONCURRENT_SANDBOXES";

function crowd(count: number, review?: unknown): StudyConfig {
  const parsed = parseStudy({
    schema: STUDY_SCHEMA,
    id: "crowd",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actor: { type: "openai-computer-use", mission: "Explore the app and stop." },
    participants: count,
    execution: { target: "e2b-desktop", timeoutMs: 60_000 },
    ...(review === undefined ? {} : { review: { analysis: review } }),
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

function seams(handle: FanoutModuleHandle) {
  return {
    desktopModule: async () => handle.module,
    runSession: async (options: CuaActorSessionOptions) => {
      // Hold each session so the participants that may overlap do.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return runCuaActorSession({
        ...options,
        openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
      });
    },
  };
}

describe("a live computer-use run of more than 16 participants", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-past-16-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("finishes ok and records its analysis as skipped for its participant count", async () => {
    const handle = makeFanoutModule();
    const analyze = vi.fn();
    const outcome = await runStudyWith(
      crowd(17),
      { cwd, env: KEYS },
      { ...seams(handle), analysis: { run: analyze } },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    const { result } = outcome;
    expect(result.ok).toBe(true);
    expect(result.laneSummary?.passed).toBe(17);
    expect(handle.killed).toHaveLength(17);
    expect(analyze).not.toHaveBeenCalled();
    expect(result.automaticAnalysis).toEqual({
      state: "skipped",
      reason: "AUTOMATIC_ANALYSIS_PARTICIPANT_LIMIT",
    });
    // The CLI prints the reason in words and exits 0: the study did not ask for analysis.
    expect(analysisOutcomeText(result.automaticAnalysis!)).toBe(
      "not run, because the study has more than 16 participants and automatic analysis reads at most 16",
    );
    expect(studyAnalysisSucceeded(result)).toBe(true);
    expect(automaticAnalysisEnvelope(result).ok).toBe(true);
  });

  it("fails the exit rule when the study asked for the analysis it skipped", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      crowd(17, { maxCostUsd: 5 }),
      { cwd, env: KEYS },
      { ...seams(handle), analysis: { run: vi.fn() } },
    );
    if (outcome.route !== "computer-use") throw new Error(`ran on ${outcome.route}`);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.automaticAnalysis?.reason).toBe("AUTOMATIC_ANALYSIS_PARTICIPANT_LIMIT");
    expect(studyAnalysisSucceeded(outcome.result)).toBe(false);
  });

  it("runs 24 participants 20 at a time by default and all at once when the plan allows 100", async () => {
    const atDefault = makeFanoutModule();
    await runStudyWith(
      crowd(24),
      { cwd, env: KEYS },
      { ...seams(atDefault), analysis: { run: vi.fn() } },
    );
    expect(atDefault.createdIds).toHaveLength(24);
    expect(atDefault.maxLive()).toBe(20);

    const onPro = makeFanoutModule();
    await runStudyWith(
      crowd(24),
      { cwd, env: { ...KEYS, [SETTING]: "100" } },
      { ...seams(onPro), analysis: { run: vi.fn() } },
    );
    expect(onPro.createdIds).toHaveLength(24);
    expect(onPro.maxLive()).toBe(24);
  });
});
