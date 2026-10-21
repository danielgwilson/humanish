import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STUDY_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { libraryConfig } from "../../helpers/library-config.js";
import type { createLocalFirecrackerDesktop } from "../../../src/substrates/local/firecracker-desktop.js";
import type { CuaProvider } from "../../../src/actors/computer-use/loop.js";
import { participantRun } from "../../helpers/participant-run.js";
import { parseStudy } from "../../../src/study/config.js";
import { planComputerUseStudy } from "../../../src/routes/computer-use/plan.js";
import { participantRunsAndPlan } from "../../../src/routes/computer-use/participant-runs.js";
import { concurrentSandboxes, sandboxCeiling } from "../../../src/substrates/e2b/lifetime.js";
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

import { prepareLocalVmRun } from "../../../src/routes/computer-use/local-vm.js";

const appUrl = "http://127.0.0.1:4173/";
const assets = { image: "synthetic-image", runtimeRevision: "synthetic-revision" };

function localLab(type: "openai-computer-use" | "local-agent"): StudyConfig {
  return libraryConfig({
    schema: STUDY_SCHEMA,
    id: "local-hooks",
    route: "computer-use",
    mode: "live",
    subject: { source: "app-url", appUrl },
    actor: { type, mission: "Save a synthetic note." },
    execution: { target: "local" },
  });
}

/** The participant runs a parsed study plans, as the computer-use route builds them. */
function plannedRuns(config: StudyConfig) {
  const planned = planComputerUseStudy(config, {
    dryRun: false,
    sandboxCeiling: sandboxCeiling({}),
    concurrentSandboxes: concurrentSandboxes({}),
  });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return participantRunsAndPlan(planned.plan).runs;
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

  it("keeps the caller's hooks next to its own desktop participant", async () => {
    const score = vi.fn();
    const deriveArtifacts = vi.fn();
    const scorerProvenance: RunScorerProvenance = {
      schema: "humanish.scorer-provenance.v1",
      ref: "scorers/example.mjs",
      digest: "sha256:synthetic",
      source: "manifest",
      exports: ["score"],
    };

    const study = prepareLocalVmRun({
      cwd,
      config: localLab("openai-computer-use"),
      dryRun: true,
      scorer: { score, deriveArtifacts },
      scorerProvenance,
    });

    expect(study.localVm.desktop).toBeTypeOf("function");
    expect(study.options.scorerProvenance).toBe(scorerProvenance);
    // The scorer stays on the options.
    expect(study.options.scorer?.score).toBe(score);
    expect(study.options.scorer?.deriveArtifacts).toBe(deriveArtifacts);
    // The desktop goes to the run as localVm, and an openai participant gets no account provider.
    expect(study.options.createProvider).toBeUndefined();
    expect(study.localVm.signal).toBeUndefined();
    expect(study.localVm.analysisRefusal()).toBeUndefined();
  });

  it("uses a caller's provider in place of the Codex account and hands the run the abort signal", async () => {
    const provider = { id: "synthetic-provider" } as CuaProvider;
    const createProvider = vi.fn(async () => provider);
    const close = vi.fn(async () => ({ status: "released" as const }));
    seams.createDesktop.mockResolvedValue({ executor: {}, close } as unknown as Awaited<
      ReturnType<typeof createLocalFirecrackerDesktop>
    >);
    const signal = new AbortController().signal;

    const study = prepareLocalVmRun({
      cwd,
      config: localLab("local-agent"),
      dryRun: false,
      assets,
      signal,
      createProvider,
    });
    expect(study.localVm.desktop).toBeTypeOf("function");
    await study.localVm.desktop(laneRun(), [], {} as PreparedOutputRoot).prepare();
    await study.close();

    await study.options.createProvider!({} as never);
    expect(createProvider).toHaveBeenCalledOnce();
    expect(seams.account).not.toHaveBeenCalled();
    expect(seams.createDesktop).toHaveBeenCalledWith(
      expect.objectContaining({ assets, appUrl, signal }),
    );
    expect(close).toHaveBeenCalled();
    // The computer-use run adds the study's signal to each session.
    expect(study.localVm.signal).toBe(signal);
  });

  it("stops automatic analysis once a desktop's cleanup is unconfirmed", async () => {
    const close = vi.fn(async () => ({ status: "failed" as const }));
    const container = "c".repeat(64);
    seams.createDesktop.mockResolvedValue({
      executor: {},
      close,
      resourceId: container,
    } as unknown as Awaited<ReturnType<typeof createLocalFirecrackerDesktop>>);
    const study = prepareLocalVmRun({
      cwd,
      config: localLab("openai-computer-use"),
      dryRun: false,
      assets,
    });
    const desktop = study.localVm.desktop(laneRun(), [], {} as PreparedOutputRoot);
    await desktop.prepare();
    await desktop.finalize({ failed: false });
    expect(study.localVm.analysisRefusal()).toBe("AUTOMATIC_ANALYSIS_CLEANUP_UNCONFIRMED");
    // No receipt names a local VM, so the participant carries the command that removes its
    // container.
    expect(desktop.snapshot().sandboxRelease).toEqual({
      state: "unconfirmed",
      warning: "Local desktop cleanup is unconfirmed.",
      recovery: expect.stringContaining(`docker rm --force --volumes ${container}`),
    });
    await study.close();
  });

  it("starts each participant's guest at its device size, emulating only the phone", async () => {
    seams.createDesktop.mockResolvedValue({
      executor: {},
      close: async () => ({ status: "released" }),
    } as unknown as Awaited<ReturnType<typeof createLocalFirecrackerDesktop>>);
    const parsed = parseStudy({
      schema: STUDY_SCHEMA,
      id: "three-devices",
      route: "computer-use",
      mode: "live",
      subject: { source: "app-url", appUrl },
      actor: { type: "openai-computer-use", mission: "Save a synthetic note." },
      participants: [
        { id: "phone-01", device: "mobile" },
        { id: "tablet-01", device: "tablet" },
        { id: "desktop-01", device: "desktop" },
      ],
      execution: { target: "local", desktop: { fidelity: { mobileEmulation: true } } },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    const study = prepareLocalVmRun({ cwd, config: parsed.config, dryRun: false, assets });
    const desktops = plannedRuns(parsed.config).map((run) =>
      study.localVm.desktop(run, [], {} as PreparedOutputRoot),
    );
    for (const desktop of desktops) await desktop.prepare();
    await study.close();

    const displays = seams.createDesktop.mock.calls.map(([options]) => options.display);
    expect(displays).toEqual([
      // The 414-wide phone renders on a 500-wide screen, Chromium's narrowest window, and its
      // pages get the phone's viewport through emulation.
      {
        width: 500,
        height: 896,
        mobileEmulation: {
          width: 414,
          height: 896,
          deviceScaleFactor: 3,
          touch: true,
          userAgent: expect.stringContaining("iPhone"),
        },
      },
      { width: 820, height: 1180 },
      { width: 1440, height: 950 },
    ]);
    expect(desktops[0]!.snapshot().desktopGeometry?.fidelity).toMatchObject({
      tier: "mobile-emulated",
      requested: { width: 414, height: 896, deviceScaleFactor: 3, touch: true },
    });
    expect(desktops[1]!.snapshot().desktopGeometry?.fidelity).toBeUndefined();
  });

  it("starts a study without a device on the guest's default screen", async () => {
    seams.createDesktop.mockResolvedValue({
      executor: {},
      close: async () => ({ status: "released" }),
    } as unknown as Awaited<ReturnType<typeof createLocalFirecrackerDesktop>>);
    const parsed = parseStudy(localLab("openai-computer-use"));
    if (!parsed.ok) throw new Error(parsed.error.message);
    const study = prepareLocalVmRun({ cwd, config: parsed.config, dryRun: false, assets });
    const [run] = plannedRuns(parsed.config);
    await study.localVm.desktop(run!, [], {} as PreparedOutputRoot).prepare();
    await study.close();
    expect(seams.createDesktop.mock.calls[0]![0].display).toBeUndefined();
  });
});
