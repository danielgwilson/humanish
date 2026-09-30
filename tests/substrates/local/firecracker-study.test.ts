import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { runLab as RunLab, LabOutcome } from "../../../src/lab/engine.js";
import type { LabConfig } from "../../../src/lab/types.js";
import type { createLocalFirecrackerDesktop } from "../../../src/substrates/local/firecracker-desktop.js";
import type { CuaActorSessionOptions } from "../../../src/actors/computer-use/actor.js";
import type { CuaLoopResult, CuaProvider } from "../../../src/actors/computer-use/loop.js";
import type { CuaLaneSpec } from "../../../src/routes/computer-use/types.js";
import type { PreparedOutputDirectory } from "../../../src/run/selected-output-paths.js";
import type { RunScorerProvenance } from "../../../src/run/bundle.js";

const seams = vi.hoisted(() => ({
  runLab: vi.fn<typeof RunLab>(),
  account: vi.fn(),
  createDesktop: vi.fn<typeof createLocalFirecrackerDesktop>(),
}));
vi.mock("../../../src/lab/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lab/engine.js")>()),
  runLab: seams.runLab,
}));
vi.mock("../../../src/analysis/restricted-codex.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/analysis/restricted-codex.js")>()),
  checkRestrictedCodexAnalysisReadiness: seams.account,
}));
vi.mock("../../../src/substrates/local/firecracker-desktop.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/substrates/local/firecracker-desktop.js")
  >()),
  createLocalFirecrackerDesktop: seams.createDesktop,
}));

import { runLocalFirecrackerStudy } from "../../../src/substrates/local/firecracker-study.js";

const appUrl = "http://127.0.0.1:4173/";
const assets = { image: "synthetic-image", runtimeRevision: "synthetic-revision" };

function localLab(type: "openai-computer-use" | "local-agent"): LabConfig {
  return {
    schema: "humanish.lab.v2",
    id: "local-hooks",
    subject: { source: "app-url", appUrl },
    actors: [{ type, mission: "Save a synthetic note." }],
    execution: { target: "local" },
    scenario: { mode: "live" },
  };
}

function reentryHooks() {
  expect(seams.runLab).toHaveBeenCalledOnce();
  const hooks = seams.runLab.mock.calls[0]![1].cuaHooks;
  expect(hooks?.createDesktopLane).toBeTypeOf("function");
  return hooks!;
}

describe("local study re-entry", () => {
  let cwd: string;
  const outcome: LabOutcome = {
    backend: "synthetic",
    result: { schema: "humanish.run-result.v1", ok: true, cwd: "", warnings: [] },
  };
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-reentry-"));
    seams.runLab.mockResolvedValue(outcome);
  });
  afterEach(async () => {
    vi.resetAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the caller's hooks next to its own desktop lane", async () => {
    const score = vi.fn();
    const onPhase = vi.fn();
    const deriveArtifacts = vi.fn();
    const createDesktopLane = vi.fn();
    const scorerProvenance: RunScorerProvenance = {
      schema: "humanish.scorer-provenance.v1",
      ref: "scorers/example.mjs",
      digest: "sha256:synthetic",
      source: "manifest",
      exports: ["score"],
    };

    await runLocalFirecrackerStudy({
      cwd,
      config: localLab("openai-computer-use"),
      dryRun: true,
      cuaHooks: { score, onPhase, deriveArtifacts, createDesktopLane },
      scorerProvenance,
    });

    const hooks = reentryHooks();
    expect(seams.runLab.mock.calls[0]![1].scorerProvenance).toBe(scorerProvenance);
    expect(hooks.score).toBe(score);
    expect(hooks.onPhase).toBe(onPhase);
    expect(hooks.deriveArtifacts).toBe(deriveArtifacts);
    expect(hooks.createDesktopLane).not.toBe(createDesktopLane);
    expect(hooks.buildProvider).toBeUndefined();
    expect(hooks.runSession).toBeUndefined();
  });

  it("uses a caller's provider in place of the Codex account and threads the abort signal", async () => {
    const provider = { id: "synthetic-provider" } as CuaProvider;
    const buildProvider = vi.fn(async () => provider);
    const sessionResult = { status: "done" } as unknown as CuaLoopResult;
    const runSession = vi.fn(async (_options: CuaActorSessionOptions) => sessionResult);
    const close = vi.fn(async () => ({ status: "released" as const }));
    seams.createDesktop.mockResolvedValue({ executor: {}, close } as unknown as Awaited<
      ReturnType<typeof createLocalFirecrackerDesktop>
    >);
    seams.runLab.mockImplementation(async (_config, options) => {
      const spec: Partial<CuaLaneSpec> = { laneId: "lane-1", targetUrl: appUrl };
      const lane = options.cuaHooks!.createDesktopLane!(
        spec as CuaLaneSpec,
        [],
        {} as PreparedOutputDirectory,
      );
      await lane.prepare();
      return outcome;
    });
    const signal = new AbortController().signal;

    await runLocalFirecrackerStudy({
      cwd,
      config: localLab("local-agent"),
      dryRun: false,
      assets,
      signal,
      cuaHooks: { buildProvider, runSession },
    });

    const hooks = reentryHooks();
    expect(hooks.buildProvider).toBe(buildProvider);
    expect(seams.account).not.toHaveBeenCalled();
    expect(seams.createDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ assets, appUrl, signal }),
    );
    expect(close).toHaveBeenCalled();
    const input = { laneId: "lane-1" } as unknown as CuaActorSessionOptions;
    await expect(hooks.runSession!(input)).resolves.toBe(sessionResult);
    expect(runSession).toHaveBeenCalledWith({ ...input, signal });
  });

  it("refuses E2B desktop hooks before preparing anything", async () => {
    const prepareDesktop = vi.fn(async () => {});
    const packLocalTree = vi.fn();

    await expect(
      runLocalFirecrackerStudy({
        cwd,
        config: localLab("local-agent"),
        dryRun: false,
        assets,
        cuaHooks: { prepareDesktop, packLocalTree },
      }),
    ).rejects.toThrow(/does not call cuaHooks\.prepareDesktop, cuaHooks\.packLocalTree\./);

    expect(seams.runLab).not.toHaveBeenCalled();
    expect(seams.account).not.toHaveBeenCalled();
    expect(seams.createDesktop).not.toHaveBeenCalled();
    expect(prepareDesktop).not.toHaveBeenCalled();
  });
});
