import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { prepareLocalVmStudy } from "../src/routes/computer-use/local-vm.js";

const localStudy = vi.hoisted(() =>
  vi.fn<typeof prepareLocalVmStudy>(() => {
    throw new Error("unexpected local study");
  }),
);
vi.mock("../src/routes/computer-use/local-vm.js", () => ({
  prepareLocalVmStudy: localStudy,
}));

import { runLab } from "../src/run-lab.js";
import type { LabConfig } from "../src/lab/types.js";
import type { RunAdapterScore, RunScorerProvenance } from "../src/run/bundle.js";
import type { CuaExecutor } from "../src/actors/computer-use/loop.js";

const config: LabConfig = {
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
    localStudy.mockClear();
    await rm(cwd, { recursive: true, force: true });
  });

  it("plans a local browser lab with the local study's bindings and keeps the scorer", async () => {
    const close = vi.fn(async () => {});
    localStudy.mockImplementationOnce(({ scorerProvenance: _provenance, ...options }) => ({
      // A dry run creates no desktop, so a stand-in lane is enough to plan and run with. The
      // synthetic scorer provenance names no real file, so the stand-in run leaves it out.
      options: {
        ...options,
        dryRun: true,
        open: false,
        cuaHooks: { ...options.cuaHooks, createDesktopLane: vi.fn() },
      },
      close,
    }));

    const outcome = await runLab(config, {
      cwd,
      dryRun: false,
      cuaHooks: { score },
      scorerProvenance,
    });

    expect(localStudy).toHaveBeenCalledOnce();
    const options = localStudy.mock.calls[0]![0];
    expect(options.cuaHooks?.score).toBe(score);
    expect(options.scorerProvenance).toBe(scorerProvenance);
    expect(options.config.execution?.target).toBe("local");
    expect(options.config.subject.appUrl).toBe(config.subject.appUrl);
    expect(outcome.backend).toBe("cua");
    expect((outcome.result as { ok?: boolean }).ok).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("leaves the desktop to a caller that supplies createDesktopLane", async () => {
    const createDesktopLane = vi.fn();
    const outcome = await runLab(config, {
      cwd,
      dryRun: true,
      open: false,
      cuaHooks: { createDesktopLane, score },
    });

    expect(localStudy).not.toHaveBeenCalled();
    expect(outcome.backend).toBe("cua");
    expect((outcome.result as { ok?: boolean }).ok).toBe(true);
  });

  it("keeps an in-process caller out of the local browser study", async () => {
    const buildExecutor = vi.fn(async (): Promise<CuaExecutor> => {
      throw new Error("unexpected executor");
    });
    const outcome = await runLab(
      {
        ...config,
        actors: [{ type: "local-agent", localAgent: "codex", mission: "Save a synthetic note." }],
      },
      { cwd, dryRun: true, open: false, cuaHooks: { buildExecutor } },
    );

    expect(localStudy).not.toHaveBeenCalled();
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    expect(outcome.result.ok).toBe(false);
    expect(outcome.result.error?.code).toBe("HUMANISH_CUA_LAB_EXECUTOR_NO_PROVIDER");
    expect(buildExecutor).not.toHaveBeenCalled();
  });
});
