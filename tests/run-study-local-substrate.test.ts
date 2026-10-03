import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { prepareLocalVmRun } from "../src/routes/computer-use/local-vm.js";

const localVm = vi.hoisted(() =>
  vi.fn<typeof prepareLocalVmRun>(() => {
    throw new Error("unexpected local study");
  }),
);
vi.mock("../src/routes/computer-use/local-vm.js", () => ({
  prepareLocalVmRun: localVm,
}));

import { runStudyWith } from "../src/run-study.js";
import type { StudyConfig } from "../src/study/types.js";
import type { RunAdapterScore, RunScorerProvenance } from "../src/run/bundle.js";
import type { CuaExecutor, CuaProvider } from "../src/actors/computer-use/loop.js";

const config: StudyConfig = {
  schema: "humanish.lab.v2",
  id: "local-scored",
  subject: { source: "app-url", appUrl: "http://127.0.0.1:4173/" },
  actors: [{ type: "openai-computer-use", mission: "Save a synthetic note." }],
  execution: { target: "local" },
  scenario: { mode: "live" },
};

const score = (): RunAdapterScore => ({
  schema: "humanish.adapter-score.v1",
  namespace: "example-adapter",
  status: "pass",
  score: 100,
  summary: "Synthetic pass.",
});

const scorerProvenance: RunScorerProvenance = {
  schema: "humanish.scorer-provenance.v1",
  ref: "scorers/example.mjs",
  digest: "sha256:synthetic",
  source: "cli-flag",
  exports: ["score"],
};

describe("local browser study selection", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-select-"));
  });
  afterEach(async () => {
    localVm.mockClear();
    await rm(cwd, { recursive: true, force: true });
  });

  it("plans a local browser lab with the local study's bindings and keeps the scorer", async () => {
    const close = vi.fn(async () => {});
    localVm.mockImplementationOnce(({ scorerProvenance: _provenance, ...options }) => ({
      // A dry run creates no desktop, so a stand-in desktop is enough to plan and run with. The
      // synthetic scorer provenance names no real file, so the stand-in run leaves it out.
      options: { ...options, dryRun: true, open: false },
      localVm: { desktop: vi.fn(), analysisRefusal: () => undefined },
      close,
    }));

    const outcome = await runStudyWith(config, {
      cwd,
      dryRun: false,
      scorer: {
        score,
      },
      scorerProvenance,
    });

    expect(localVm).toHaveBeenCalledOnce();
    const options = localVm.mock.calls[0]![0];
    expect(options.scorer?.score).toBe(score);
    expect(options.scorerProvenance).toBe(scorerProvenance);
    expect(options.config.execution?.target).toBe("local");
    expect(options.config.subject.appUrl).toBe(config.subject.appUrl);
    expect(outcome.route).toBe("computer-use");
    expect((outcome.result as { ok?: boolean }).ok).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a caller's prepared local VM in place of a second study", async () => {
    const desktop = vi.fn();
    const outcome = await runStudyWith(config, {
      cwd,
      dryRun: true,
      open: false,
      localVm: { desktop, analysisRefusal: () => undefined },
    });

    expect(localVm).not.toHaveBeenCalled();
    expect(outcome.route).toBe("computer-use");
    expect((outcome.result as { ok?: boolean }).ok).toBe(true);
  });

  it("keeps an in-process caller out of the local browser study", async () => {
    const executor = vi.fn(async (): Promise<CuaExecutor> => {
      throw new Error("unexpected executor");
    });
    const createProvider = vi.fn(async (): Promise<CuaProvider> => {
      throw new Error("unexpected provider");
    });
    const outcome = await runStudyWith(
      {
        ...config,
        actors: [{ type: "local-agent", localAgent: "codex", mission: "Save a synthetic note." }],
      },
      { cwd, dryRun: true, open: false, inProcess: { executor }, createProvider },
    );

    expect(localVm).not.toHaveBeenCalled();
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    // The local study is not started, so the run has no local desktop and refuses before either
    // caller function runs.
    expect(outcome.result.error?.code).toBe("HUMANISH_COMPUTER_USE_LOCAL_DESKTOP_MISSING");
    expect(executor).not.toHaveBeenCalled();
    expect(createProvider).not.toHaveBeenCalled();
  });
});
