import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LabConfig } from "../../../src/lab/types.js";
import type { createLocalFirecrackerDesktop } from "../../../src/substrates/local/firecracker-desktop.js";
import type { CuaActorSessionOptions } from "../../../src/actors/computer-use/actor.js";
import type { CuaLoopResult, CuaProvider } from "../../../src/actors/computer-use/loop.js";
import { participantRun } from "../../helpers/participant-run.js";
import type { PreparedOutputRoot } from "../../../src/run/contained-output.js";
import type { RunScorerProvenance } from "../../../src/run/bundle.js";

const seams = vi.hoisted(() => ({
  account: vi.fn(),
  createDesktop: vi.fn<typeof createLocalFirecrackerDesktop>(),
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

import { prepareLocalVmStudy } from "../../../src/routes/computer-use/local-vm.js";

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

function studyHooks(study: ReturnType<typeof prepareLocalVmStudy>) {
  expect(study.localVm.desktop).toBeTypeOf("function");
  return study.options.cuaHooks!;
}

const laneRun = () =>
  participantRun({
    id: "lane-1",
    index: 0,
    persona: { id: "synthetic-persona", traitsApplied: [], promptDigest: "synthetic" },
    instructions: "Save a synthetic note.",
    targetUrl: appUrl,
  });

describe("local study bindings", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-local-reentry-"));
  });
  afterEach(async () => {
    vi.resetAllMocks();
    await rm(cwd, { recursive: true, force: true });
  });

  it("keeps the caller's hooks next to its own desktop lane", async () => {
    const score = vi.fn();
    const deriveArtifacts = vi.fn();
    const scorerProvenance: RunScorerProvenance = {
      schema: "humanish.scorer-provenance.v1",
      ref: "scorers/example.mjs",
      digest: "sha256:synthetic",
      source: "manifest",
      exports: ["score"],
    };

    const study = prepareLocalVmStudy({
      cwd,
      config: localLab("openai-computer-use"),
      dryRun: true,
      scorer: { score, deriveArtifacts },
      scorerProvenance,
    });

    const hooks = studyHooks(study);
    expect(study.options.scorerProvenance).toBe(scorerProvenance);
    // The scorer stays on the options.
    expect(study.options.scorer?.score).toBe(score);
    expect(study.options.scorer?.deriveArtifacts).toBe(deriveArtifacts);
    // The desktop goes to the run as localVm, not through the hooks.
    expect(hooks.buildProvider).toBeUndefined();
    expect(hooks.runSession).toBeUndefined();
    expect(study.localVm.signal).toBeUndefined();
    expect(study.localVm.analysisRefusal()).toBeUndefined();
  });

  it("uses a caller's provider in place of the Codex account and hands the run the abort signal", async () => {
    const provider = { id: "synthetic-provider" } as CuaProvider;
    const buildProvider = vi.fn(async () => provider);
    const sessionResult = { status: "done" } as unknown as CuaLoopResult;
    const runSession = vi.fn(async (_options: CuaActorSessionOptions) => sessionResult);
    const close = vi.fn(async () => ({ status: "released" as const }));
    seams.createDesktop.mockResolvedValue({ executor: {}, close } as unknown as Awaited<
      ReturnType<typeof createLocalFirecrackerDesktop>
    >);
    const signal = new AbortController().signal;

    const study = prepareLocalVmStudy({
      cwd,
      config: localLab("local-agent"),
      dryRun: false,
      assets,
      signal,
      cuaHooks: { buildProvider, runSession },
    });
    const hooks = studyHooks(study);
    await study.localVm.desktop(laneRun(), [], {} as PreparedOutputRoot).prepare();
    await study.close();

    await hooks.buildProvider!({} as never);
    expect(buildProvider).toHaveBeenCalledOnce();
    expect(seams.account).not.toHaveBeenCalled();
    expect(seams.createDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ assets, appUrl, signal }),
    );
    expect(close).toHaveBeenCalled();
    // The caller's runSession stays as given; the computer-use run adds the study's signal.
    expect(hooks.runSession).toBe(runSession);
    expect(study.localVm.signal).toBe(signal);
    expect(sessionResult).toBeDefined();
  });

  it("stops automatic analysis once a desktop's cleanup is unconfirmed", async () => {
    const close = vi.fn(async () => ({ status: "failed" as const }));
    const container = "c".repeat(64);
    seams.createDesktop.mockResolvedValue({
      executor: {},
      close,
      resourceId: container,
    } as unknown as Awaited<ReturnType<typeof createLocalFirecrackerDesktop>>);
    const study = prepareLocalVmStudy({
      cwd,
      config: localLab("openai-computer-use"),
      dryRun: false,
      assets,
    });
    const desktop = study.localVm.desktop(laneRun(), [], {} as PreparedOutputRoot);
    await desktop.prepare();
    await desktop.finalize({ failed: false });
    expect(study.localVm.analysisRefusal()).toBe("AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED");
    // No receipt names a local VM, so the lane carries the command that removes its container.
    expect(desktop.snapshot().sandboxRelease).toEqual({
      state: "unconfirmed",
      warning: "Local desktop cleanup is unconfirmed.",
      recovery: expect.stringContaining(`docker rm --force --volumes ${container}`),
    });
    await study.close();
  });

  it("refuses E2B desktop hooks before preparing anything", async () => {
    const prepareDesktop = vi.fn(async () => {});
    const packLocalTree = vi.fn();

    expect(() =>
      prepareLocalVmStudy({
        cwd,
        config: localLab("local-agent"),
        dryRun: false,
        assets,
        cuaHooks: { prepareDesktop, packLocalTree },
      }),
    ).toThrow(/does not call cuaHooks\.prepareDesktop, cuaHooks\.packLocalTree\./);

    expect(seams.account).not.toHaveBeenCalled();
    expect(seams.createDesktop).not.toHaveBeenCalled();
    expect(prepareDesktop).not.toHaveBeenCalled();
  });
});
