import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { dispatchLab as DispatchLab, LabOutcome } from "../../../src/lab/engine.js";
import type { LabConfig } from "../../../src/lab/types.js";
import type { createLocalFirecrackerDesktop } from "../../../src/substrates/local/firecracker-desktop.js";
import type { CuaActorSessionOptions } from "../../../src/actors/computer-use/actor.js";
import type { CuaLoopResult, CuaProvider } from "../../../src/actors/computer-use/loop.js";
import type { CuaLaneSpec } from "../../../src/routes/computer-use/types.js";
import type { PreparedOutputDirectory } from "../../../src/run/selected-output-paths.js";
import type { RunScorerProvenance } from "../../../src/run/bundle.js";

const seams = vi.hoisted(() => ({
  dispatchLab: vi.fn<typeof DispatchLab>(),
  account: vi.fn(),
  createDesktop: vi.fn<typeof createLocalFirecrackerDesktop>(),
}));
vi.mock("../../../src/lab/engine.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lab/engine.js")>()),
  dispatchLab: seams.dispatchLab,
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
  expect(seams.dispatchLab).toHaveBeenCalledOnce();
  const hooks = seams.dispatchLab.mock.calls[0]![1].cuaHooks;
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
    seams.dispatchLab.mockResolvedValue(outcome);
  });
  afterEach(async () => {
    vi.resetAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps a class-instance caller bag's methods on re-entry", async () => {
    class CallerHooks {
      readonly #phases: string[] = [];
      onPhase(event: { message: string }) {
        this.#phases.push(event.message);
      }
      phases() {
        return this.#phases;
      }
    }
    const bag = new CallerHooks();
    await runLocalFirecrackerStudy({
      cwd,
      config: localLab("openai-computer-use"),
      dryRun: true,
      cuaHooks: bag as never,
    });

    const hooks = reentryHooks();
    hooks.onPhase!(
      { at: "", type: "phase", message: "cloned" },
      {
        laneId: "lane-01",
        laneIndex: 0,
        laneCount: 1,
      },
    );
    expect(bag.phases()).toEqual(["cloned"]);
  });

  it("keeps a class-instance analysis bag's methods on re-entry", async () => {
    const skipped = { state: "skipped", reason: "AUTOMATIC_ANALYSIS_DRY_RUN" } as never;
    class AnalysisHooks {
      readonly #calls: string[] = [];
      onStart() {
        this.#calls.push("start");
      }
      run() {
        this.#calls.push("run");
        return Promise.resolve(skipped);
      }
      calls() {
        return this.#calls;
      }
    }
    const bag = new AnalysisHooks();
    await runLocalFirecrackerStudy({
      cwd,
      config: localLab("openai-computer-use"),
      dryRun: true,
      automaticAnalysis: bag,
    });

    reentryHooks();
    const analysis = seams.dispatchLab.mock.calls[0]![1].automaticAnalysis!;
    analysis.onStart!();
    await expect(analysis.run!({} as never, {} as never, {} as never)).resolves.toBe(skipped);
    expect(bag.calls()).toEqual(["start", "run"]);
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
    expect(seams.dispatchLab.mock.calls[0]![1].scorerProvenance).toBe(scorerProvenance);
    // The study forwards the caller's members bound to the caller's bag, so each reaches the
    // caller's function.
    await hooks.score!({} as never);
    hooks.onPhase!(
      { at: "", type: "phase", message: "m" },
      { laneId: "lane-01", laneIndex: 0, laneCount: 1 },
    );
    await hooks.deriveArtifacts!({} as never);
    expect(score).toHaveBeenCalledOnce();
    expect(onPhase).toHaveBeenCalledOnce();
    expect(deriveArtifacts).toHaveBeenCalledOnce();
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
    seams.dispatchLab.mockImplementation(async (_config, options) => {
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
    await hooks.buildProvider!({} as never);
    expect(buildProvider).toHaveBeenCalledOnce();
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

    expect(seams.dispatchLab).not.toHaveBeenCalled();
    expect(seams.account).not.toHaveBeenCalled();
    expect(seams.createDesktop).not.toHaveBeenCalled();
    expect(prepareDesktop).not.toHaveBeenCalled();
  });
});
