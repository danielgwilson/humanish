// A live computer-use run of more than 16 participants on fake desktops ($0, real orchestration):
// it finishes, runs no more desktops at once than the E2B plan allows, and requests the automatic
// analysis of every participant.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { runAutomaticAnalysis } from "../../../src/analysis/automatic.js";
import { runStudyWith } from "../../../src/run-study.js";
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

  it("finishes ok and requests the analysis of all 17 participants", async () => {
    const handle = makeFanoutModule();
    const analyze = vi.fn<typeof runAutomaticAnalysis>(async () => ({
      state: "complete",
      reason: null,
    }));
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
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(result.automaticAnalysis).toMatchObject({ state: "complete" });
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
