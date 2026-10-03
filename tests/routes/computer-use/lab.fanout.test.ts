import { deriveRunFacts } from "../../../src/cli/telemetry.js";
import type { StudyEvent } from "../../../src/study/run-study-events.js";
import { browserScorer } from "../../../src/study/adapter-scorer-loader.js";
import { CuaAdmissionLimitError } from "../../../src/actors/computer-use/admission-limit.js";
import { draftFeedback } from "../../../src/feedback/feedback.js";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { measuredChromeDesktop } from "../../helpers/measured-chrome-desktop.js";
import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";
import { captureStderr, runDirSnapshot } from "../../helpers/run-golden.js";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  runCuaActorSession,
  type CuaActorSessionOptions,
} from "../../../src/actors/computer-use/actor.js";
import type { CuaProvider } from "../../../src/actors/computer-use/loop.js";
import { buildCuaFanoutBundle } from "../../../src/routes/computer-use/fanout-bundle.js";
import { participantFactsOf } from "../../../src/routes/computer-use/participant-facts.js";
import { judgeParticipants } from "../../../src/run/judge.js";
import {
  floorRenderResolution,
  MIN_DESKTOP_RENDER_WIDTH,
  resolveParticipantDevice,
} from "../../../src/study/device-presets.js";
import { resolveCuaParticipantPlan } from "../../../src/routes/computer-use/participant-runs.js";
import { runComputerUsePlan, runCuaActorLab } from "../../../src/routes/computer-use/route.js";
import { planComputerUseLab } from "../../../src/routes/computer-use/plan.js";
import type { ComputerUsePlan } from "../../../src/study/plan-types.js";
import { declaredScreenForRender } from "../../../src/substrates/e2b/desktop-geometry.js";
import { runCuaParticipants } from "../../../src/routes/computer-use/participant-execution.js";
import type { StudyDeps } from "../../../src/study/study-deps.js";
import {
  type DesktopParticipantRun,
  type ParticipantRunOutcome,
} from "../../../src/routes/computer-use/types.js";
import { getActor } from "../../../src/actors/registry.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../../src/substrates/e2b/sdk.js";
import { V2_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { parseStudy } from "../../../src/study/config.js";
import { runStudyWith } from "../../../src/run-study.js";
import {
  OPENAI_RESPONSES_CU_CAPABILITIES,
  type FetchLike,
} from "../../../src/actors/computer-use/openai-provider.js";
import type { BrowserLabScoringContext, RunAdapterScore, RunBundle } from "../../../src/index.js";
import {
  serveObserver,
  type ObserverResult,
  type ObserverServer,
} from "../../../src/observer/render.js";
import { readReview } from "../../../src/run/stored-runs.js";
import { reclaimRunSandboxes } from "../../../src/run/reclaim.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { participantRun } from "../../helpers/participant-run.js";
import type { ProviderContext } from "../../../src/study/run-study-homes.js";
import { DEVICE_PRESETS } from "../../../src/study/device-presets.js";

// ---------------------------------------------------------------------------
// Fan-out fakes: a desktop module that mints a distinct sandbox per create()
// (unique sandboxId), records create options (per-participant metadata) and kill calls
// (by id), tracks peak concurrent live sandboxes, and answers xdpyinfo with the
// requested geometry (so the per-participant geometry assertion passes). It has no
// `list` method: enumerate-and-kill is physically impossible.
// ---------------------------------------------------------------------------

function makePng(seed: number): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (seed * 37 + i) % 256;
    png.data[i + 1] = (seed * 89 + i) % 256;
    png.data[i + 2] = (seed * 13 + i) % 256;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

function scriptedFetch(responses: unknown[]): FetchLike {
  let i = 0;
  return async () => {
    const value = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
      json: async () => value,
    };
  };
}

const TWO_TURN_SESSION = [
  {
    id: "resp_1",
    output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }],
  },
  {
    id: "resp_2",
    output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
  },
];
const HOLLOW_SESSION = [{ id: "r1", output: [{ type: "message", content: [] }] }];
const FANOUT_ADAPTER_NAMESPACE = "fanout-browser-adapter-proof";

function fanoutFailScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "humanish.adapter-score.v1",
    namespace: FANOUT_ADAPTER_NAMESPACE,
    status: "fail",
    score: 15,
    summary: `${ctx.route} fan-out adapter found no product-level success evidence.`,
    data: {
      route: ctx.route,
      participantCount: ctx.participantCount,
    },
  };
}

/** The seams, writable so a test can swap one. */
type TestDeps = { -readonly [K in keyof StudyDeps]: StudyDeps[K] };

/** The keys every fake fan-out run gets. */
const FANOUT_ENV = { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" };

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForCondition(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

interface FanoutModuleOptions {
  /** Override the geometry a given sandbox reports (participantIndex from metadata). Default: matches. */
  geometryOverride?: (laneIndex: number, requested: [number, number]) => [number, number];
  /** Every kill by id throws, as when the provider cannot be reached at teardown. */
  killFails?: boolean;
  /** Answers one participant's sandbox command; undefined falls through to the default reply. */
  commandHandler?: (laneIndex: number, command: string) => { stdout: string } | undefined;
  /** Chrome launches and reports measured geometry (measured-chrome-desktop.ts). */
  measuredChrome?: boolean;
}

interface FanoutModuleHandle {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  /** Parallel to `created`: the custom template each participant's create() got (undefined ==
   *  default). */
  templates: (string | undefined)[];
  opened: string[];
  killed: string[];
  createdIds: string[];
  /** Peak count of simultaneously-live (created, not yet killed) sandboxes. */
  maxLive: () => number;
}

function makeFanoutModule(options: FanoutModuleOptions = {}): FanoutModuleHandle {
  const created: E2BDesktopCreateOptions[] = [];
  const templates: (string | undefined)[] = [];
  const opened: string[] = [];
  const createdIds: string[] = [];
  const killed: string[] = [];
  let serial = 0;
  let live = 0;
  let maxLive = 0;

  const makeSandbox = (id: string, createOptions: E2BDesktopCreateOptions): E2BDesktopSandbox => {
    const requested = createOptions.resolution ?? [1440, 950];
    const laneIndex = Number(createOptions.metadata?.participantIndex ?? "0");
    const reported = options.geometryOverride
      ? options.geometryOverride(laneIndex, requested)
      : requested;
    let frame = 0;
    const record = (name: string) => async (): Promise<void> => {
      void name;
    };
    const measured = options.measuredChrome ? measuredChromeDesktop(() => reported) : undefined;
    return {
      sandboxId: id,
      // Captured stock shape; resource-size variation tests live in desktop-resource-pricing.
      getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
      commands: {
        run: async (command: string) => {
          const handled = options.commandHandler?.(laneIndex, command);
          if (handled) return { exitCode: 0, ...handled };
          if (command.includes("xdpyinfo")) {
            return {
              exitCode: 0,
              stdout: `  dimensions:    ${reported[0]}x${reported[1]} pixels (300x200 millimeters)\n`,
            };
          }
          const targetUrl = command.match(/^target_url='([^']+)'$/m)?.[1];
          if (targetUrl) {
            opened.push(targetUrl);
          }
          return measured?.(command) ?? { exitCode: 0, stdout: "" };
        },
      },
      files: { write: async () => undefined },
      launch: record("launch") as (application: string, uri?: string) => Promise<void>,
      open: (async (fileOrUrl: string) => {
        opened.push(fileOrUrl);
      }) as (fileOrUrl: string) => Promise<void>,
      async screenshot() {
        frame += 1;
        return makePng(frame);
      },
      async wait() {
        /* settle is instant in the fake */
      },
      stream: {
        getAuthKey: () => "fake-auth-key",
        getUrl: () => "https://stream.invalid/fake-auth-key",
        start: async () => undefined,
      },
      leftClick: record("leftClick"),
      rightClick: record("rightClick"),
      middleClick: record("middleClick"),
      doubleClick: record("doubleClick"),
      moveMouse: record("moveMouse"),
      scroll: record("scroll"),
      write: record("write"),
      press: record("press"),
      drag: record("drag"),
    } as unknown as E2BDesktopSandbox;
  };

  const module: E2BDesktopModule = {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) or create(template, opts).
      create: async (
        templateOrOptions: string | E2BDesktopCreateOptions,
        maybeOptions?: E2BDesktopCreateOptions,
      ) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions =
          typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
        serial += 1;
        live += 1;
        maxLive = Math.max(maxLive, live);
        const id = `fake-sandbox-${String(serial).padStart(2, "0")}`;
        templates.push(template);
        created.push(createOptions);
        createdIds.push(id);
        return makeSandbox(id, createOptions);
      },
      kill: async (sandboxId) => {
        if (options.killFails) throw new Error("synthetic kill failure");
        killed.push(sandboxId);
        live -= 1;
        return true;
      },
      // No `list`: the run can only kill the exact ids it created, never enumerate.
    },
  };

  return { module, created, templates, opened, killed, createdIds, maxLive: () => maxLive };
}

/** A 4-participant differentiated roster on a loopback app-url subject. */
function fanoutConfig(overrides?: {
  concurrency?: number;
  lanes?: StudyConfig["actors"][0]["lanes"];
  template?: string;
  reasoningEffort?: string;
}): StudyConfig {
  const parsed = parseStudy({
    schema: V2_SCHEMA,
    id: "fanout-proof",
    title: "Fan-out proof",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [
      {
        type: "openai-computer-use",
        mission: "Explore the app and stop.",
        ...(overrides?.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: overrides.reasoningEffort }),
        lanes: overrides?.lanes ?? [
          {
            id: "mobile-newcomer",
            persona: "first-time-visitor",
            device: "mobile",
            instruction: "Sign up from a phone.",
          },
          {
            id: "small-skimmer",
            persona: "impatient-skimmer",
            device: "small-mobile",
            instruction: "Skim and bounce.",
          },
          {
            id: "desktop-power",
            persona: "power-user",
            device: "desktop",
            instruction: "Open advanced settings.",
          },
          {
            id: "wide-researcher",
            persona: "comparison-shopper",
            device: "wide",
            instruction: "Compare the plans.",
          },
        ],
      },
    ],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      concurrency: overrides?.concurrency ?? 2,
      ...(overrides?.template === undefined ? {} : { desktop: { template: overrides.template } }),
    },
    scenario: { mode: "live" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

// Execution builds its participants from the plan, not from a second read of the config: a plan
// whose participants, bound and budgets differ from what the config would rebuild runs as planned.
describe("computer-use participants come from the plan", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-plan-authority-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("runs the plan's participants, bound and budgets", async () => {
    const config = fanoutConfig({ concurrency: 2 });
    const planned = planComputerUseLab(config, { dryRun: true });
    if (!planned.ok) throw new Error(planned.refusal.message);
    const [first, second] = planned.plan.runner.participants;
    if (first === undefined || second === undefined) throw new Error("expected four participants");
    // The config declares four participants, the first as mobile-newcomer on a mobile device; the
    // plan keeps two and renames, re-personas and re-devices the first.
    const plan: ComputerUsePlan = {
      ...planned.plan,
      runner: {
        ...planned.plan.runner,
        participants: [
          {
            ...first,
            id: "plan-only-participant",
            personaId: "plan-only-persona",
            device: { name: "wide", preset: DEVICE_PRESETS.wide, resolution: [1920, 1080] },
          },
          second,
        ],
      } as ComputerUsePlan["runner"],
      concurrency: 1,
      sessionBudgetMs: 123_000,
      sandboxMs: 600_000,
    };

    const result = await runComputerUsePlan(plan, { cwd }, config);

    expect(result.plan?.lanes.map(({ id, persona, device }) => ({ id, persona, device }))).toEqual([
      { id: "plan-only-participant", persona: "plan-only-persona", device: "wide" },
      { id: second.id, persona: second.personaId, device: second.device.name },
    ]);
    expect(result.plan).toMatchObject({
      laneCount: 2,
      concurrency: 1,
      waves: 2,
      perLaneSessionBudgetMs: 123_000,
      worstCaseSandboxMinutes: 20,
    });
  });
});

describe("cua fan-out: dry-run ($0 contract bundle)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-fanout-dry-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("dry-run run directory matches its golden", async () => {
    const stderr = captureStderr();
    const outcome = await runStudyWith(fanoutConfig(), { cwd, dryRun: true }).finally(stderr.stop);
    const runId = outcome.result.runId;
    if (!runId) throw new Error("the run wrote no bundle");
    const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", runId), {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [cwd, "[cwd]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/computer-use-fanout-dry-run.json",
    );
  });

  it("a 4-participant roster yields one bundle, simCount 4, per-participant requested screens, a plan event, contract statuses; verifyRun ok", async () => {
    const planEvents: StudyEvent[] = [];
    const outcome = await runStudyWith(fanoutConfig(), {
      cwd,
      dryRun: true,
      onEvent: (event) => {
        if (event.type === "plan") planEvents.push(event);
      },
    });
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.diagnostics).toEqual({ category: "preview" });
    expect(deriveRunFacts(result).outcome).toBe("contract_proof_only");
    expect(result.lanes).toHaveLength(4);
    expect(result.laneSummary?.total).toBe(4);

    // The pre-flight plan is observable before any provider call and marked $0 in dry-run.
    expect(planEvents).toHaveLength(1);
    expect(result.plan?.dryRun).toBe(true);
    expect(result.plan?.laneCount).toBe(4);
    expect(result.plan?.concurrency).toBe(2);
    expect(result.plan?.waves).toBe(2);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.schema).toBe("humanish.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simCount).toBe(4);
    expect(bundle.streams).toHaveLength(4);
    expect(bundle.streams.map((s: { status: string }) => s.status)).toEqual([
      "contract_proof_only",
      "contract_proof_only",
      "contract_proof_only",
      "contract_proof_only",
    ]);
    // Dry-run carries the requested screens but does not invent measured CSS viewports. Sub-500 mobile
    // widths (mobile 414, small-mobile 360) are floored to Chrome's 500px window minimum (no clip).
    expect(
      bundle.streams.map(
        (s: { desktopGeometry: { screen: { requested: { width: number; height: number } } } }) => [
          s.desktopGeometry.screen.requested.width,
          s.desktopGeometry.screen.requested.height,
        ],
      ),
    ).toEqual([
      [500, 896],
      [500, 740],
      [1440, 950],
      [1920, 1080],
    ]);
    expect(bundle.streams.every((s: { viewport?: unknown }) => s.viewport === undefined)).toBe(
      true,
    );
    expect(bundle.simulations.map((s: { personaId: string }) => s.personaId)).toEqual([
      "first-time-visitor",
      "impatient-skimmer",
      "power-user",
      "comparison-shopper",
    ]);
    // The plan is recorded as a bundle event.
    expect(bundle.events.some((e: { type: string }) => e.type === "cua-lab.fanout.plan")).toBe(
      true,
    );

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("resolveCuaParticipantPlan is pure: concurrency defaults to all participants, env override only lowers (and is recorded)", () => {
    const config = fanoutConfig({
      concurrency: undefined as unknown as number,
      lanes: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
    });
    // No declared concurrency on a 5-participant roster → every participant runs at once: 5
    // participants, 1 wave.
    const planDefault = resolveCuaParticipantPlan({
      ...config,
      execution: { target: "e2b-desktop" },
    });
    expect(planDefault.concurrency).toBe(5);
    expect(planDefault.waves).toBe(1);
    expect(planDefault.envLoweredConcurrencyFrom).toBeUndefined();
    // Env override lowers to 2, and the lowering is recorded, never silent.
    const planLowered = resolveCuaParticipantPlan(
      { ...config, execution: { target: "e2b-desktop" } },
      { env: { HUMANISH_CUA_MAX_CONCURRENCY: "2" } },
    );
    expect(planLowered.concurrency).toBe(2);
    expect(planLowered.envLoweredConcurrencyFrom).toBe(5);
    // Env override may not raise above the declared cap (clamped to laneCount + the base).
    const planRaiseAttempt = resolveCuaParticipantPlan(
      { ...config, execution: { target: "e2b-desktop", concurrency: 2 } },
      { env: { HUMANISH_CUA_MAX_CONCURRENCY: "9" } },
    );
    expect(planRaiseAttempt.concurrency).toBe(2);
    expect(planRaiseAttempt.envLoweredConcurrencyFrom).toBeUndefined();
  });

  it("direct live fan-out bundle builder fails closed when outcomes are missing", () => {
    const config = fanoutConfig({
      lanes: [
        {
          id: "role-a",
          persona: "first-time-visitor",
          device: "desktop",
          instruction: "Review the dashboard.",
        },
        {
          id: "role-b",
          persona: "power-user",
          device: "desktop",
          instruction: "Review the settings.",
        },
      ],
    });
    const participantPlan = resolveCuaParticipantPlan(config);
    const specs: DesktopParticipantRun[] = [
      participantRun({
        id: "role-a",
        index: 0,
        recordId: "sim-role-a",
        streamId: "stream-role-a",
        persona: { id: "first-time-visitor", traitsApplied: [], promptDigest: "prompt-a" },
        instructions: "Review the dashboard.",
        screenshotDir: "role-a",
        traceArtifactPath: "actors/stream-role-a.json",
      }),
      participantRun({
        id: "role-b",
        index: 1,
        recordId: "sim-role-b",
        streamId: "stream-role-b",
        persona: { id: "power-user", traitsApplied: [], promptDigest: "prompt-b" },
        instructions: "Review the settings.",
        screenshotDir: "role-b",
        traceArtifactPath: "actors/stream-role-b.json",
      }),
    ];
    const source: RunBundle["source"] = {
      packageName: "humanish",
      humanishSource: "present",
      git: {
        schema: "humanish.git-state.v1",
        status: "clean",
        capturedAt: "2026-01-01T00:00:00.000Z",
        head: { shortSha: "abc1234", refState: "attached" },
        changes: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
        note: "test fixture",
      },
    };
    const subject = {
      source: "app-url" as const,
      state: { provenance: "undeclared" as const },
    };

    const bundle = buildCuaFanoutBundle({
      // No participant produced an outcome: the judge fails a live fan-out that proved no
      // participant.
      verdict: judgeParticipants({
        dryRun: false,
        inProgress: false,
        expected: specs.length,
        participants: [],
      }).verdict,
      specs,
      outcomes: [],
      subjects: [subject, subject],
      aggregateSubject: subject,
      descriptor: getActor("openai-computer-use"),
      appUrl: "http://127.0.0.1:3000/",
      run: { runId: "missing-outcomes-proof", mode: "live", createdAt: "2026-01-01T00:00:00.000Z" },
      dryRun: false,
      plan: planOf(config),
      source,
      participantPlan,
    });

    expect(bundle.mode).toBe("live");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("0/2");
    expect(bundle.review.gaps).toEqual(["role-a: did not pass", "role-b: did not pass"]);
  });
});

/** The computer-use plan a fixture config makes; the bundle reads the lab's identity from it. */
function planOf(config: StudyConfig): ComputerUsePlan {
  const planned = planComputerUseLab(config, { dryRun: true });
  if (!planned.ok) throw new Error(planned.refusal.message);
  return planned.plan;
}

describe("cua fan-out bundle: desktop browser provenance", () => {
  function twoLaneInputs(resolved: [string, string]) {
    const config = fanoutConfig({
      lanes: [
        { id: "role-a", persona: "first-time-visitor", device: "desktop", instruction: "Look." },
        { id: "role-b", persona: "power-user", device: "desktop", instruction: "Look." },
      ],
    });
    config.execution = { ...config.execution, desktop: { browser: "chrome" } };
    const specs: DesktopParticipantRun[] = ["role-a", "role-b"].map((id, index) =>
      participantRun({
        id,
        index,
        recordId: `sim-${id}`,
        streamId: `stream-${id}`,
        persona: { id: `persona-${id}`, traitsApplied: [], promptDigest: `prompt-${id}` },
        instructions: "Look.",
        screenshotDir: id,
        traceArtifactPath: `actors/stream-${id}.json`,
      }),
    );
    const outcomes: ParticipantRunOutcome[] = specs.map((spec, index) => ({
      spec,
      killed: true,
      streamUrlPresent: false,
      screenshots: [],
      stateStepRecords: [],
      phaseRecords: [],
      warnings: [],
      noEngagement: false,
      selfReportedBlocker: false,
      harnessError: false,
      sessionError: "synthetic lane error",
      desktopBrowser: { requested: "chrome", resolved: resolved[index]! },
    }));
    const subject = { source: "app-url" as const, state: { provenance: "undeclared" as const } };
    return buildCuaFanoutBundle({
      verdict: judgeParticipants({
        dryRun: false,
        inProgress: false,
        expected: specs.length,
        participants: outcomes.map(participantFactsOf),
      }).verdict,
      specs,
      outcomes,
      subjects: [subject, subject],
      aggregateSubject: subject,
      descriptor: getActor("openai-computer-use"),
      appUrl: "http://127.0.0.1:3000/",
      run: {
        runId: "browser-provenance-proof",
        mode: "live",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      dryRun: false,
      plan: planOf(config),
      source: {
        packageName: "humanish",
        humanishSource: "present",
        git: {
          schema: "humanish.git-state.v1",
          status: "clean",
          capturedAt: "2026-01-01T00:00:00.000Z",
          head: { shortSha: "abc1234", refState: "attached" },
          changes: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
          note: "test fixture",
        },
      },
      participantPlan: resolveCuaParticipantPlan(config),
    });
  }

  it("records the resolved browser when every participant resolved the same one", () => {
    expect(twoLaneInputs(["google-chrome", "google-chrome"]).desktopBrowser).toEqual({
      requested: "chrome",
      resolved: "google-chrome",
    });
  });

  it("records only the request when participants resolved different browsers", () => {
    expect(twoLaneInputs(["google-chrome", "chromium"]).desktopBrowser).toEqual({
      requested: "chrome",
    });
  });
});

describe("cua fan-out: live with fake substrate ($0, real orchestration)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-fanout-live-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  function passingSeams(
    handle: FanoutModuleHandle,
    extra?: TestDeps & { active?: { count: number; max: number } },
  ): TestDeps {
    const { active = { count: 0, max: 0 }, ...seams } = extra ?? {};
    return {
      desktopModule: async () => handle.module,
      runSession: async (options: CuaActorSessionOptions) => {
        active.count += 1;
        active.max = Math.max(active.max, active.count);
        try {
          await delay(20); // hold so concurrent participants genuinely overlap
          // Fresh fetch per participant (each participant its own session transport).
          return await runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        } finally {
          active.count -= 1;
        }
      },
      ...seams,
    };
  }

  // Characterization: the complete run directory of a four-participant fan-out, pinned so a
  // refactor of bundle assembly or artifact writing shows up as a diff. Regenerate with -u.
  it("live run directory matches its golden", async () => {
    const handle = makeFanoutModule({ measuredChrome: true });
    // One participant at a time. Overlapping participants reach sandbox creation and append their
    // receipts in whatever order the scheduler gives them, which changed the snapshot once under
    // full-suite load. The concurrency behavior has its own tests in this file.
    const stderr = captureStderr();
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 1 }),
      {
        cwd,
        env: FANOUT_ENV,
      },
      {
        ...passingSeams(handle, { now: () => 1_000_000 }),
        analysis: { run: automaticAnalysisBoundary() },
      },
    ).finally(stderr.stop);
    const runId = outcome.result.runId;
    if (!runId) throw new Error("the run wrote no bundle");
    const snapshot = await runDirSnapshot(path.join(cwd, ".humanish", "runs", runId), {
      result: outcome.result,
      stderr: stderr.text(),
      replace: [
        [runId, "[run]"],
        [cwd, "[cwd]"],
      ],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      "../../golden/routes/computer-use-fanout-live.json",
    );
  });

  // createProvider receives each participant's id, 0-based index and the run's participant count,
  // matching the golden plan.
  it("hands createProvider each participant's ref with the golden's values", async () => {
    const golden = JSON.parse(
      await readFile(
        path.join(import.meta.dirname, "../../golden/routes/computer-use-fanout-live.json"),
        "utf8",
      ),
    ) as { "<result>": { plan: { lanes: { id: string; index: number }[] } } };
    const seen: ProviderContext["participant"][] = [];
    const provider: CuaProvider = {
      id: "synthetic-provider",
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => ({
        actions: [],
        message: "Done.",
        outcome: "reached",
        pendingSafetyChecks: [],
        done: true,
      }),
    };
    await runStudyWith(
      fanoutConfig({ concurrency: 1 }),
      {
        cwd,
        env: FANOUT_ENV,
        createProvider: async ({ participant }) => {
          seen.push(participant);
          return provider;
        },
      },
      {
        ...passingSeams(makeFanoutModule(), { now: () => 1_000_000 }),
        analysis: { run: automaticAnalysisBoundary() },
      },
    );
    const lanes = golden["<result>"].plan.lanes;
    expect(seen).toEqual(
      lanes.map((lane) => ({ id: lane.id, index: lane.index - 1, count: lanes.length })),
    );
  });

  it("carries each participant's declared reasoning effort into the provider options", async () => {
    // The link a unit test cannot see and a live run costs money to check: study YAML ->
    // participant spec -> the options the provider is actually built from. A declared effort that
    // stops short of this call is indistinguishable from no effort at all, which is the defect
    // being closed.
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      concurrency: 2,
      reasoningEffort: "medium",
      lanes: [
        { id: "default-effort", persona: "p", device: "desktop", instruction: "Work." },
        {
          id: "harder-effort",
          persona: "p",
          device: "desktop",
          instruction: "Work.",
          reasoningEffort: "high",
        },
      ],
    });
    const seen: (string | undefined)[] = [];
    const seams = passingSeams(handle);
    const inner = seams.runSession!;
    seams.runSession = async (options: CuaActorSessionOptions) => {
      seen.push(options.openai?.reasoningEffort);
      return inner(options);
    };

    const result = await runStudyWith(
      config,
      { cwd, runId: "cua-fanout-effort", env: FANOUT_ENV },
      seams,
    );

    expect(result.route).toBe("computer-use");
    // Both participants share a persona and a mission; the effort is the only thing that may
    // differ.
    expect([...seen].sort()).toEqual(["high", "medium"]);
  });

  it("publishes an attached live Observer while CUA fan-out actors are still running", async () => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      concurrency: 2,
      lanes: [
        { id: "role-a", persona: "role-a", device: "desktop", instruction: "Explore role A." },
        { id: "role-b", persona: "role-b", device: "desktop", instruction: "Explore role B." },
      ],
    });
    config.actors[0]!.mission = "Explore with test-openai-key.";
    const runId = "cua-fanout-live-observer";
    const runRoot = path.join(cwd, ".humanish", "runs", runId);
    let actorSessionsStarted = 0;
    let resolveActorsStarted: () => void = () => {};
    const actorsStarted = new Promise<void>((resolve) => {
      resolveActorsStarted = resolve;
    });
    let releaseActors: () => void = () => {};
    const actorsReleased = new Promise<void>((resolve) => {
      releaseActors = resolve;
    });
    let readyObserver: (ObserverResult & { ok: true }) | undefined;
    let observerServer: ObserverServer | undefined;

    const seams = passingSeams(handle);
    seams.runSession = async (options: CuaActorSessionOptions) => {
      expect(options.instructions).toContain("Explore with test-openai-key.");
      actorSessionsStarted += 1;
      if (actorSessionsStarted >= 2) {
        resolveActorsStarted();
      }
      await actorsReleased;
      return runCuaActorSession({
        ...options,
        openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
      });
    };

    const runPromise = runStudyWith(
      config,
      {
        cwd,
        runId,
        onObserverReady: async (observer) => {
          readyObserver = observer;
          observerServer = await serveObserver(observer, { port: 0 });
        },
        env: FANOUT_ENV,
      },
      seams,
    );

    try {
      await waitForCondition("observer server", () => observerServer !== undefined);
      await actorsStarted;
      await waitForCondition("both actor sessions started", () => actorSessionsStarted === 2);

      const persistedRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(
        (JSON.parse(persistedRunText) as RunBundle).streams.map((stream) => stream.assignment),
      ).toEqual([
        { mission: "Explore with [REDACTED_SECRET].", focus: "Explore role A." },
        { mission: "Explore with [REDACTED_SECRET].", focus: "Explore role B." },
      ]);
      expect(persistedRunText).not.toContain("test-openai-key");
      expect(persistedRunText).not.toContain("fake-auth-key");
      expect(persistedRunText).not.toContain("stream.invalid");

      const persistedObserverDataText = await readFile(
        path.join(runRoot, "observer", "observer-data.json"),
        "utf8",
      );
      expect(persistedObserverDataText).not.toContain("test-openai-key");
      expect(persistedObserverDataText).not.toContain("fake-auth-key");
      expect(persistedObserverDataText).not.toContain("stream.invalid");
      const persistedObserverData = JSON.parse(persistedObserverDataText) as {
        events: Array<{ type: string }>;
        streams: Array<{ status: string; transport: string }>;
        summary: { active: number };
      };
      expect(persistedObserverData.summary.active).toBe(2);
      expect(persistedObserverData.streams.map((stream) => stream.status)).toEqual([
        "running",
        "running",
      ]);
      expect(persistedObserverData.streams.map((stream) => stream.transport)).toEqual([
        "snapshot",
        "snapshot",
      ]);
      expect(
        persistedObserverData.events.filter((event) => event.type === "cua-lab.session.running"),
      ).toHaveLength(2);

      expect(readyObserver).toBeTruthy();
      expect(observerServer).toBeTruthy();
      const served = await fetch(new URL("observer-data.json", observerServer!.url));
      const servedObserverData = (await served.json()) as {
        streams: Array<{ embed?: { kind: string; url?: string }; transport: string; url?: string }>;
      };
      expect(servedObserverData.streams).toHaveLength(2);
      expect(servedObserverData.streams.every((stream) => stream.transport === "sse")).toBe(true);
      expect(servedObserverData.streams.every((stream) => stream.embed?.kind === "iframe")).toBe(
        true,
      );
      expect(
        servedObserverData.streams.every(
          (stream) => stream.url === "https://stream.invalid/fake-auth-key",
        ),
      ).toBe(true);

      releaseActors();
      const outcome = await runPromise;
      expect(outcome.route).toBe("computer-use");
      if (outcome.route !== "computer-use") return;
      expect(outcome.result.ok).toBe(true);

      const finalRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(finalRunText).not.toContain("test-openai-key");
      expect(finalRunText).not.toContain("fake-auth-key");
      expect(finalRunText).not.toContain("stream.invalid");
      const finalObserverData = JSON.parse(
        await readFile(path.join(runRoot, "observer", "observer-data.json"), "utf8"),
      ) as {
        summary: { active: number };
        streams: Array<{ status: string; transport: string }>;
      };
      expect(JSON.stringify(finalObserverData)).not.toContain("test-openai-key");
      expect(finalObserverData.summary.active).toBe(0);
      expect(finalObserverData.streams.map((stream) => stream.status)).toEqual([
        "passed",
        "passed",
      ]);
      expect(finalObserverData.streams.map((stream) => stream.transport)).toEqual([
        "snapshot",
        "snapshot",
      ]);
    } finally {
      releaseActors();
      await observerServer?.close();
      await runPromise.catch(() => undefined);
    }
  });

  it("execution.desktop.template: every fan-out participant's Sandbox.create gets the template; bundle records it", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2, template: "acme-desktop-with-runtimes" }),
      { cwd, env: FANOUT_ENV },
      passingSeams(handle),
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    expect(outcome.result.ok).toBe(true);
    // All four per-participant desktops launched on the custom template (subject + every
    // participant is uniform).
    expect(handle.created).toHaveLength(4);
    expect(handle.templates).toEqual([
      "acme-desktop-with-runtimes",
      "acme-desktop-with-runtimes",
      "acme-desktop-with-runtimes",
      "acme-desktop-with-runtimes",
    ]);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.desktopTemplate).toBe("acme-desktop-with-runtimes");
  });

  it("byte-stable default: no template → every fan-out participant's create gets no template arg, bundle omits desktopTemplate", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: FANOUT_ENV,
      },
      passingSeams(handle),
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    expect(handle.created).toHaveLength(4);
    expect(handle.templates).toEqual([undefined, undefined, undefined, undefined]);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.desktopTemplate).toBeUndefined();
  });

  it("after every participant's teardown kill fails, reclaim kills each receipted participant sandbox", async () => {
    const handle = makeFanoutModule();
    const kill = handle.module.Sandbox.kill!;
    handle.module.Sandbox.kill = async (sandboxId, options) => {
      await kill(sandboxId, options);
      throw new Error("synthetic kill failure");
    };
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: FANOUT_ENV,
      },
      passingSeams(handle, { active: { count: 0, max: 0 } }),
    );
    if (outcome.route !== "computer-use") throw new Error(`unexpected backend ${outcome.route}`);
    expect(handle.createdIds).toHaveLength(4);

    const reclaimed: string[] = [];
    await reclaimRunSandboxes(cwd, outcome.result.runId, {
      loadModule: async () =>
        ({
          Sandbox: {
            async kill(sandboxId: string) {
              reclaimed.push(sandboxId);
              return true;
            },
          },
        }) as unknown as E2BDesktopModule,
    });
    expect(reclaimed.sort()).toEqual([...handle.createdIds].sort());
  });

  it("runs the real orchestration at N=4, concurrency 2: 4 per-participant sandboxes, bounded concurrency, teardown kills only each participant's own id, verifyRun ok", async () => {
    const handle = makeFanoutModule();
    const active = { count: 0, max: 0 };
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: FANOUT_ENV,
      },
      passingSeams(handle, { active }),
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.laneSummary).toMatchObject({
      total: 4,
      passed: 4,
      skipped: 0,
      harnessErrors: 0,
      hollow: 0,
      concurrency: 2,
      waves: 2,
    });

    // Four sandboxes created, each with per-participant metadata.
    expect(handle.created).toHaveLength(4);
    expect(handle.created.map((c) => c.metadata?.participantId)).toEqual([
      "mobile-newcomer",
      "small-skimmer",
      "desktop-power",
      "wide-researcher",
    ]);
    expect(handle.created.map((c) => c.metadata?.participantIndex)).toEqual(["0", "1", "2", "3"]);
    expect(handle.created.every((c) => c.metadata?.participantCount === "4")).toBe(true);
    // Per-participant device geometry drove each sandbox's resolution (sub-500 mobile widths
    // floored to the 500px Chrome window minimum so the window fits its X screen: no clip).
    expect(handle.created.map((c) => c.resolution)).toEqual([
      [500, 896],
      [500, 740],
      [1440, 950],
      [1920, 1080],
    ]);
    // The model's key never enters any sandbox.
    expect(handle.created.every((c) => c.envs === undefined)).toBe(true);

    // Bounded concurrency: never more than 2 participants in flight at once (and genuinely
    // parallel).
    expect(active.max).toBe(2);
    expect(handle.maxLive()).toBeLessThanOrEqual(2);

    // Teardown kills exactly the four created ids, by id, never an enumerate-and-kill (the fake
    // module exposes no `list`, and the killed set equals the created set).
    expect([...handle.killed].sort()).toEqual([...handle.createdIds].sort());
    expect(handle.createdIds).toEqual([
      "fake-sandbox-01",
      "fake-sandbox-02",
      "fake-sandbox-03",
      "fake-sandbox-04",
    ]);

    // The bundle passes verifyRun; being written is not enough.
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    // Per-participant evidence on disk: one screenshots/<laneId>/ dir + one actors/<streamId>.json
    // each.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams).toHaveLength(4);
    for (const laneId of ["mobile-newcomer", "small-skimmer", "desktop-power", "wide-researcher"]) {
      const shots = await readdir(path.join(runDir, "screenshots", laneId));
      expect(shots.length, laneId).toBeGreaterThan(0);
    }
    const traceFiles = await readdir(path.join(runDir, "actors"));
    expect(traceFiles).toHaveLength(4);
    // Per-participant provider-neutral actor seam filled per stream.
    expect(
      bundle.streams.every((s: { actor?: { lane: string } }) => s.actor?.lane === "computer-use"),
    ).toBe(true);
  });

  it("runs no more participants at once than the env override allows, below the lab's concurrency", async () => {
    const handle = makeFanoutModule();
    const active = { count: 0, max: 0 };
    const seams = passingSeams(handle, { active });
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 4 }),
      {
        cwd,
        env: { ...FANOUT_ENV, HUMANISH_CUA_MAX_CONCURRENCY: "2" },
      },
      {
        ...seams,
      },
    );
    if (outcome.route !== "computer-use") throw new Error(`unexpected backend ${outcome.route}`);
    const { result } = outcome;
    expect(result.ok).toBe(true);
    expect(result.plan).toMatchObject({ concurrency: 2, envLoweredConcurrencyFrom: 4, waves: 2 });
    expect(result.laneSummary).toMatchObject({ concurrency: 2, waves: 2 });
    // The lab declares 4. The runner must take its bound from the participant plan, which the env
    // override lowered to 2; the route plan still says 4, and both have a concurrency field.
    expect(active.max).toBe(2);
    expect(handle.maxLive()).toBeLessThanOrEqual(2);
  });

  describe("a rerun of failed fan-out participants", () => {
    // The source run and its rerun are made once, in their own project, by the first test that
    // needs them, and each verify is its own test. As one test, two route runs and four verifies
    // hit the 20 s default at load 66-78. The per-test cwd above is removed after each test.
    type RerunProof = {
      project: string;
      sourceRunId: string;
      sourceOk: boolean;
      sourceLanes: { passed?: number; harnessErrors?: number } | undefined;
      sourceBundle: RunBundle;
      sourceAfterRerun: RunBundle;
      rerun: Extract<Awaited<ReturnType<typeof runStudyWith>>, { route: "computer-use" }>["result"];
      rerunHandle: FanoutModuleHandle;
      rerunBundle: RunBundle;
      rerunText: string;
    };
    let made: Promise<RerunProof> | undefined;
    afterAll(async () => {
      const proof = await made?.catch(() => undefined);
      if (proof) await rm(proof.project, { recursive: true, force: true });
    });
    const rerunPath = (proof: RerunProof) =>
      path.join(proof.project, ".humanish", "runs", "fanout-rerun-proof", "run.json");
    const readBundle = async (project: string, runId: string) =>
      JSON.parse(
        await readFile(path.join(project, ".humanish", "runs", runId, "run.json"), "utf8"),
      ) as RunBundle;
    const rerunProof = () =>
      (made ??= (async (): Promise<RerunProof> => {
        const project = await mkdtemp(path.join(tmpdir(), "humanish-fanout-rerun-"));
        const sourceHandle = makeFanoutModule();
        const sourceOutcome = await runStudyWith(
          fanoutConfig({ concurrency: 4 }),
          { cwd: project, env: FANOUT_ENV },
          {
            ...passingSeams(sourceHandle),
            runSession: async (options: CuaActorSessionOptions) => {
              if (options.persona.id === "power-user") {
                throw new Error("transient actor transport failed");
              }
              return runCuaActorSession({
                ...options,
                openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
              });
            },
          },
        );
        if (sourceOutcome.route !== "computer-use")
          throw new Error("the source run is not a cua run");
        const sourceRunId = sourceOutcome.result.runId;
        const sourceBundle = await readBundle(project, sourceRunId);
        const rerunHandle = makeFanoutModule();
        const rerunOutcome = await runStudyWith(
          fanoutConfig({ concurrency: 4 }),
          { cwd: project, runId: "fanout-rerun-proof", rerun: { sourceRunId }, env: FANOUT_ENV },
          passingSeams(rerunHandle),
        );
        if (rerunOutcome.route !== "computer-use") throw new Error("the rerun is not a cua run");
        const rerunText = await readFile(
          path.join(project, ".humanish", "runs", "fanout-rerun-proof", "run.json"),
          "utf8",
        );
        return {
          project,
          sourceRunId: sourceOutcome.result.runId,
          sourceOk: sourceOutcome.result.ok,
          sourceLanes: sourceOutcome.result.laneSummary,
          sourceBundle,
          sourceAfterRerun: await readBundle(project, sourceOutcome.result.runId),
          rerun: rerunOutcome.result,
          rerunHandle,
          rerunBundle: JSON.parse(rerunText) as RunBundle,
          rerunText,
        };
      })());
    async function verifyRerun(proof: RerunProof, bundle?: RunBundle) {
      await writeFile(
        rerunPath(proof),
        bundle === undefined ? proof.rerunText : `${JSON.stringify(bundle, null, 2)}\n`,
        "utf8",
      );
      return verifyRun(proof.project, "fanout-rerun-proof");
    }

    // This test builds the shared proof: two route runs that cannot be split. Measured at 2.3 s
    // alone and 8.9-13.0 s at load 46-66 (48 and 64 busy loops on 16 cores), so 60 s holds
    // there and still fails a hang.
    it("reruns failed fan-out participants as a new linked run without mutating the source verdict", async () => {
      const proof = await rerunProof();
      expect(proof.sourceOk).toBe(false);
      expect(proof.sourceLanes?.passed).toBe(3);
      expect(proof.sourceLanes?.harnessErrors).toBe(1);
      expect(proof.sourceBundle.review.verdict).toBe("fail");
      expect(
        proof.sourceBundle.streams.find((stream) => stream.laneId === "desktop-power")?.status,
      ).toBe("failed");

      expect(proof.rerun.ok).toBe(true);
      expect(proof.rerun.rerun).toMatchObject({
        sourceRunId: proof.sourceRunId,
        selectedLaneIds: ["desktop-power"],
        previous: [{ laneId: "desktop-power", status: "failed" }],
      });
      expect(proof.rerun.laneSummary).toMatchObject({
        total: 1,
        passed: 1,
        skipped: 0,
        harnessErrors: 0,
      });
      expect(proof.rerunHandle.created).toHaveLength(1);
      expect(proof.rerunHandle.created[0]?.metadata?.participantId).toBe("desktop-power");

      expect(proof.rerunBundle.rerun).toEqual(proof.rerun.rerun);
      expect(proof.rerunBundle.events.some((event) => event.type === "cua-lab.fanout.rerun")).toBe(
        true,
      );
      expect(proof.rerunBundle.review.summary).toContain(`Rerun from ${proof.sourceRunId}`);
      expect(proof.sourceAfterRerun.review.verdict).toBe("fail");

      expect((await verifyRerun(proof)).ok).toBe(true);
    }, 60_000);

    it("fails verify's bundle shape when the rerun drops its previous statuses", async () => {
      const proof = await rerunProof();
      const weakLineage = await verifyRerun(proof, {
        ...proof.rerunBundle,
        rerun: { ...proof.rerunBundle.rerun!, previous: [] },
      });
      expect(weakLineage.ok).toBe(false);
      expect(weakLineage.checks.find((check) => check.name === "run bundle shape")?.ok).toBe(false);
    });

    it("fails verify's rerun lineage without the rerun event", async () => {
      const proof = await rerunProof();
      const missingEvent = await verifyRerun(proof, {
        ...proof.rerunBundle,
        events: proof.rerunBundle.events.filter((event) => event.type !== "cua-lab.fanout.rerun"),
      });
      expect(missingEvent.ok).toBe(false);
      const rerunCheck = missingEvent.checks.find((check) => check.name === "rerun lineage");
      expect(rerunCheck?.ok).toBe(false);
      expect(rerunCheck?.message).toContain("missing cua-lab.fanout.rerun event");
    });

    it("fails verify's rerun lineage for a selected participant the run lacks", async () => {
      const proof = await rerunProof();
      const selectedMismatch = await verifyRerun(proof, {
        ...proof.rerunBundle,
        rerun: { ...proof.rerunBundle.rerun!, selectedLaneIds: ["desktop-power", "ghost-lane"] },
      });
      expect(selectedMismatch.ok).toBe(false);
      const selectedMismatchCheck = selectedMismatch.checks.find(
        (check) => check.name === "rerun lineage",
      );
      expect(selectedMismatchCheck?.ok).toBe(false);
      expect(selectedMismatchCheck?.message).toContain(
        "selected participant ghost-lane is missing prior status",
      );
      expect(selectedMismatchCheck?.message).toContain(
        "selected participant ghost-lane is missing from current streams",
      );
    });
  });

  it("reruns only the participants a rerun names and refuses an id the source run lacks", async () => {
    const sourceOutcome = await runStudyWith(
      fanoutConfig({ concurrency: 4 }),
      {
        cwd,
        env: FANOUT_ENV,
      },
      passingSeams(makeFanoutModule()),
    );
    expect(sourceOutcome.route).toBe("computer-use");
    if (sourceOutcome.route !== "computer-use") return;
    expect(sourceOutcome.result.ok).toBe(true);

    const rerunHandle = makeFanoutModule();
    const named = await runStudyWith(
      fanoutConfig({ concurrency: 4 }),
      {
        cwd,
        runId: "fanout-named-rerun",
        rerun: { sourceRunId: sourceOutcome.result.runId, participantIds: ["small-skimmer"] },
        env: FANOUT_ENV,
      },
      passingSeams(rerunHandle),
    );
    expect(named.route).toBe("computer-use");
    if (named.route !== "computer-use") return;
    expect(named.result.rerun).toMatchObject({
      selectedLaneIds: ["small-skimmer"],
      previous: [{ laneId: "small-skimmer", status: "passed" }],
    });
    expect(rerunHandle.created.map((created) => created.metadata?.participantId)).toEqual([
      "small-skimmer",
    ]);

    const ghost = await runStudyWith(
      fanoutConfig({ concurrency: 4 }),
      {
        cwd,
        rerun: { sourceRunId: sourceOutcome.result.runId, participantIds: ["ghost-lane"] },
        env: FANOUT_ENV,
      },
      passingSeams(makeFanoutModule()),
    );
    expect(ghost.route).toBe("computer-use");
    if (ghost.route !== "computer-use") return;
    expect(ghost.result.ok).toBe(false);
    expect(ghost.result.error?.code).toBe("HUMANISH_COMPUTER_USE_RERUN_INVALID");
    expect(ghost.result.error?.message).toContain("ghost-lane");
  });

  it("opens each participant's explicit target and records per-participant routes in the bundle", async () => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      concurrency: 2,
      lanes: [
        {
          id: "role-a",
          actorType: "reviewer",
          surface: "review-queue",
          caseGroup: "case-001",
          persona: "role-a",
          target: "http://127.0.0.1:3001/role-a",
          instruction: "Start from target A.",
        },
        {
          id: "role-b",
          actorType: "operator",
          surface: "dashboard",
          caseGroup: "case-001",
          persona: "role-b",
          target: "http://127.0.0.1:3002/role-b",
          instruction: "Start from target B.",
        },
      ],
    });
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: FANOUT_ENV,
      },
      passingSeams(handle),
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;

    expect(outcome.result.ok).toBe(true);
    expect(handle.opened).toEqual(["http://127.0.0.1:3001/role-a", "http://127.0.0.1:3002/role-b"]);
    expect(outcome.result.plan?.lanes.map((lane) => lane.targetDigest)).toEqual([
      expect.stringMatching(/^[a-f0-9]{16}$/),
      expect.stringMatching(/^[a-f0-9]{16}$/),
    ]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams.map((stream: { ui: { route: string } }) => stream.ui.route)).toEqual([
      "http://127.0.0.1:3001/role-a",
      "http://127.0.0.1:3002/role-b",
    ]);
    expect(
      bundle.streams.map(
        (stream: {
          actorType?: string;
          caseGroup?: string;
          laneId?: string;
          surface?: string;
        }) => ({
          laneId: stream.laneId,
          actorType: stream.actorType,
          surface: stream.surface,
          caseGroup: stream.caseGroup,
        }),
      ),
    ).toEqual([
      { laneId: "role-a", actorType: "reviewer", surface: "review-queue", caseGroup: "case-001" },
      { laneId: "role-b", actorType: "operator", surface: "dashboard", caseGroup: "case-001" },
    ]);
    const verified = await verifyRun(cwd, outcome.result.runId);
    expect(verified.ok).toBe(true);
  });

  it("preserves adapter participant metadata and explicit target on the single-participant bundle path", async () => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      lanes: [
        {
          id: "role-a",
          actorType: "reviewer",
          surface: "review-queue",
          caseGroup: "case-001",
          persona: "role-a",
          target: "http://127.0.0.1:3001/role-a?scenario=alpha",
          instruction: "Start from target A.",
        },
      ],
    });
    const outcome = await runStudyWith(config, { cwd, env: FANOUT_ENV }, passingSeams(handle));
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;

    expect(outcome.result.ok).toBe(true);
    expect(handle.opened).toEqual(["http://127.0.0.1:3001/role-a?scenario=alpha"]);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.streams).toHaveLength(1);
    expect(bundle.streams[0]).toMatchObject({
      laneId: "role-a",
      actorType: "reviewer",
      surface: "review-queue",
      caseGroup: "case-001",
      ui: { route: "http://127.0.0.1:3001/role-a?scenario=alpha" },
    });

    const verified = await verifyRun(cwd, outcome.result.runId);
    expect(verified.ok).toBe(true);
  });

  it.each([1, 2])(
    "keeps a recorded admission refusal in the %i-participant review and feedback without changing outcomes",
    async (count) => {
      const handle = makeFanoutModule();
      const config = fanoutConfig({
        concurrency: 1,
        lanes: Array.from({ length: count }, (_, index) => ({
          id: `participant-${index + 1}`,
          persona: "first-time-visitor",
        })),
      });
      config.policies = { ...config.policies, redactScreenshots: true };
      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: FANOUT_ENV,
        },
        {
          ...passingSeams(handle),
          runSession: async (options) => {
            let dispatched = 0;
            // Exercise the real actor loop and bundle writers with a provider contract fixture.
            // Each participant acts before the adapter refuses a subsequent dispatch.
            return runCuaActorSession({
              ...options,
              provider: {
                id: "synthetic-admission",
                capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
                nextTurn: async () => {
                  if (dispatched === 4) throw new CuaAdmissionLimitError();
                  dispatched += 1;
                  return {
                    actions: [{ kind: "click", x: 10 + dispatched, y: 20 }],
                    pendingSafetyChecks: [],
                    done: false,
                    usage: {
                      input: 100 * dispatched,
                      output: 10,
                      cachedInput: 0,
                      cacheWriteInput: 0,
                    },
                  };
                },
              },
            });
          },
        },
      );
      expect(outcome.route).toBe("computer-use");
      if (outcome.route !== "computer-use") return;
      const result = outcome.result;
      expect(result.ok).toBe(false);
      const runDir = path.join(cwd, ".humanish", "runs", result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
      expect(bundle.review.participants).toEqual({
        total: count,
        reachedGoal: 0,
        abandoned: 0,
        ranOut: count,
        blocked: 0,
        harnessFailed: 0,
        reportedFriction: 0,
      });
      expect(bundle.review.verdict).toBe("fail");
      expect(bundle.review.summary).not.toContain("stop details unavailable");
      expect(bundle.review.summary).toContain(
        count === 1
          ? "local admission limit before provider dispatch"
          : "0/2 recorded completions, 2 interrupted (adapter admission limit)",
      );
      for (const stream of bundle.streams) {
        expect(stream.actor).toMatchObject({
          status: "incomplete",
          completionReason: "budget_reached",
          stopCause: "adapter_limit",
          counts: { turns: 4, actions: 4 },
          tokenUsage: { input: 1000, output: 40 },
        });
      }
      expect(await readReview(cwd, result.runId)).toMatchObject({
        summary: bundle.review.summary,
        participants: bundle.review.participants,
      });
      const original = await readFile(path.join(runDir, "run.json"), "utf8");
      const drafted = await draftFeedback(cwd, result.runId);
      expect(drafted.ok).toBe(true);
      expect(drafted.draft?.actual).toContain(
        `Participants: 0/${count} recorded completions, ${count} interrupted (adapter admission limit).`,
      );
      expect(await readFile(path.join(runDir, "run.json"), "utf8")).toBe(original);
      expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
      expect(handle.killed.sort()).toEqual(handle.createdIds.sort());
    },
  );

  // One judgment decides the bundle's verdict and the result's ok, and status.json repeats the
  // bundle's verdict. Each participant's session runs the real loop with a scripted provider.
  type Ending = "pass" | "hollow" | "blocker" | "error";
  const scriptedEnding = (ending: Ending): CuaProvider => {
    let turn = 0;
    return {
      id: `synthetic-${ending}`,
      capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
      nextTurn: async () => {
        turn += 1;
        if (ending === "error") throw new Error("synthetic provider failure");
        // A hollow completion claims the goal on the first turn without acting or speaking.
        if (ending === "hollow") return { actions: [], pendingSafetyChecks: [], done: true };
        if (turn === 1)
          return {
            actions: [{ kind: "click", x: 10, y: 20 }],
            pendingSafetyChecks: [],
            done: false,
          };
        return {
          actions: [],
          pendingSafetyChecks: [],
          done: true,
          message:
            ending === "blocker"
              ? "I could not complete the task; the save button was disabled."
              : "Reached the goal: the note is saved.",
        };
      },
    };
  };
  it.each<[Ending[], RunBundle["review"]["verdict"], boolean]>([
    [["pass"], "pass", true],
    [["hollow"], "fail", false],
    [["blocker"], "blocked", false],
    [["error"], "fail", false],
    [["pass", "pass"], "pass", true],
    [["pass", "hollow"], "fail", false],
    [["pass", "blocker"], "fail", false],
    [["pass", "error"], "fail", false],
  ])(
    "agrees across bundle, result and status for participants ending %j",
    async (endings, verdict, ok) => {
      const handle = makeFanoutModule();
      const config = fanoutConfig({
        concurrency: 1,
        lanes: endings.map((_, index) => ({
          id: `participant-${index + 1}`,
          persona: "first-time-visitor",
        })),
      });
      let lane = 0;
      const outcome = await runStudyWith(
        config,
        {
          cwd,
          env: FANOUT_ENV,
        },
        {
          ...passingSeams(handle),
          runSession: async (options) =>
            runCuaActorSession({ ...options, provider: scriptedEnding(endings[lane++]!) }),
        },
      );
      if (outcome.route !== "computer-use") throw new Error("expected the computer-use route");
      const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
      const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
        outcome?: { verdict?: string; ok?: boolean };
      };
      expect(bundle.review.verdict).toBe(verdict);
      expect(status.outcome?.verdict).toBe(bundle.review.verdict);
      expect(outcome.result.ok).toBe(ok);
      expect(status.outcome?.ok).toBe(outcome.result.ok);
    },
  );

  // The judge reads a goal_satisfied session that reports a blocker as blocked, so a rerun of the
  // failed participants must select it. Rerun selection that read the trace status, which stays
  // "passed" for that session, would skip it.
  it("reruns a participant whose session reported a blocker", async () => {
    const config = fanoutConfig({
      concurrency: 1,
      lanes: [
        { id: "participant-1", persona: "first-time-visitor" },
        { id: "participant-2", persona: "first-time-visitor" },
      ],
    });
    const endings: Ending[] = ["pass", "blocker"];
    let lane = 0;
    const source = await runStudyWith(
      config,
      {
        cwd,
        env: FANOUT_ENV,
      },
      {
        ...passingSeams(makeFanoutModule()),
        runSession: async (options) =>
          runCuaActorSession({ ...options, provider: scriptedEnding(endings[lane++]!) }),
      },
    );
    if (source.route !== "computer-use") throw new Error("expected the computer-use route");
    expect(source.result.ok).toBe(false);

    const rerun = await runStudyWith(
      config,
      {
        cwd,
        rerun: { sourceRunId: source.result.runId },
        env: FANOUT_ENV,
      },
      passingSeams(makeFanoutModule()),
    );
    if (rerun.route !== "computer-use") throw new Error("expected the computer-use route");
    expect(rerun.result.error).toBeUndefined();
    expect(rerun.result.rerun).toMatchObject({
      sourceRunId: source.result.runId,
      selectedLaneIds: ["participant-2"],
    });
  });

  // The scorer folds into the judged verdict last, and can only make it stricter: a failing
  // score turns a pass into a fail, a passing score cannot lift a blocked run, and a failing score
  // leaves a blocked run blocked with the scorer's failure as a gap.
  it.each<[Ending, "pass" | "fail", RunBundle["review"]["verdict"]]>([
    ["pass", "pass", "pass"],
    ["pass", "fail", "fail"],
    ["blocker", "pass", "blocked"],
    ["blocker", "fail", "blocked"],
  ])("folds a %s participant and a %s score into %s", async (ending, scoreStatus, verdict) => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      concurrency: 1,
      lanes: [{ id: "participant-1", persona: "first-time-visitor" }],
    });
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: FANOUT_ENV,
        scorer: {
          score: () => ({
            schema: "humanish.adapter-score.v1",
            namespace: "fold-proof",
            status: scoreStatus,
            score: scoreStatus === "pass" ? 90 : 10,
            summary: `rubric ${scoreStatus}`,
          }),
        },
      },
      {
        ...passingSeams(handle),
        runSession: async (options) =>
          runCuaActorSession({ ...options, provider: scriptedEnding(ending) }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected the computer-use route");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string; ok?: boolean };
    };
    expect(bundle.review.verdict).toBe(verdict);
    expect(status.outcome?.verdict).toBe(verdict);
    expect(outcome.result.ok).toBe(verdict === "pass");
    expect(status.outcome?.ok).toBe(outcome.result.ok);
    expect(bundle.review.gaps.includes("Adapter scorer failed the run: rubric fail")).toBe(
      scoreStatus === "fail",
    );
  });

  it("fails a live participant whose session threw an error with an empty message", async () => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      concurrency: 1,
      lanes: [{ id: "participant-1", persona: "first-time-visitor" }],
    });
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: FANOUT_ENV,
      },
      {
        ...passingSeams(handle),
        runSession: async () => {
          throw new Error("");
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected the computer-use route");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string; ok?: boolean };
    };
    expect(bundle.mode).toBe("live");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.simulations[0]?.status).toBe("failed");
    expect(status.outcome?.verdict).toBe("fail");
    expect(outcome.result.ok).toBe(false);
    expect(status.outcome?.ok).toBe(outcome.result.ok);
  });

  // A participant whose session passed but whose provider cleanup is unconfirmed is a passed
  // participant and an execution failure: the fan-out's verdict is pass, and its ok is false.
  it("passes a fan-out whose participant could not confirm its provider's cleanup, and fails the run", async () => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      concurrency: 1,
      lanes: [
        { id: "participant-1", persona: "first-time-visitor" },
        { id: "participant-2", persona: "first-time-visitor" },
      ],
    });
    let built = 0;
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: FANOUT_ENV,
        createProvider: async () => {
          const cleanupFails = built++ === 1;
          return {
            ...scriptedEnding("pass"),
            close: async () => {
              if (cleanupFails) throw new Error("synthetic provider close failure");
            },
          };
        },
      },
      {
        ...passingSeams(handle),
        runSession: async (options) =>
          runCuaActorSession({ ...options, provider: scriptedEnding("pass") }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected the computer-use route");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: {
        verdict?: string;
        ok?: boolean;
        execution?: { failures: Array<{ kind: string; message: string }> };
      };
    };
    expect(bundle.review.verdict).toBe("pass");
    expect(status.outcome?.verdict).toBe("pass");
    expect(outcome.result.ok).toBe(false);
    expect(status.outcome?.ok).toBe(false);
    expect(status.outcome?.execution?.failures).toEqual([
      {
        kind: "provider-cleanup",
        message: "participant-2: Model provider cleanup is unconfirmed.",
      },
    ]);
    expect(outcome.result.error?.message).toContain("Model provider cleanup is unconfirmed.");
  });

  it("keeps the verdict when the sandbox kill fails: cleanup does not judge", async () => {
    const handle = makeFanoutModule({ killFails: true });
    const config = fanoutConfig({
      concurrency: 1,
      lanes: [{ id: "participant-1", persona: "first-time-visitor" }],
    });
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: FANOUT_ENV,
      },
      {
        ...passingSeams(handle),
        runSession: async (options) =>
          runCuaActorSession({ ...options, provider: scriptedEnding("pass") }),
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected the computer-use route");
    const runDir = path.join(cwd, ".humanish", "runs", outcome.result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string; ok?: boolean };
    };
    // No route's verdict reads cleanup today: the failed teardown is a warning, and the pass stands.
    expect(bundle.review.verdict).toBe("pass");
    expect(status.outcome?.verdict).toBe("pass");
    expect(outcome.result.ok).toBe(true);
    expect(status.outcome?.ok).toBe(outcome.result.ok);
    expect(handle.killed).toEqual([]);
    expect(outcome.result.warnings).toContain(
      "Sandbox teardown failed (server-side kill-on-timeout will reclaim it): synthetic kill failure",
    );
  });

  it("projects each recorded interruption through real participant orchestration and summarizes divergent causes", async () => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      lanes: [
        { id: "first", persona: "first-time-visitor" },
        { id: "second", persona: "power-user" },
      ],
    });
    let sessions = 0;
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: FANOUT_ENV,
      },
      {
        ...passingSeams(handle),
        runSession: async (options) => {
          const interruption =
            sessions++ === 0 ? ("output_limit" as const) : ("token_limit" as const);
          // A provider contract fixture, not an invented HTTP wire response.
          return runCuaActorSession({
            ...options,
            provider: {
              id: "synthetic-interruption",
              capabilities: OPENAI_RESPONSES_CU_CAPABILITIES,
              nextTurn: async () => ({
                actions: [],
                pendingSafetyChecks: [],
                done: false,
                interruption,
              }),
            },
          });
        },
      },
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    expect(result.ok).toBe(false);
    expect(result.laneSummary).toMatchObject({ total: 2, passed: 0, harnessErrors: 0 });
    expect(result.lanes?.map((lane) => lane.session?.stopCause).sort()).toEqual([
      "provider_output_limit",
      "provider_token_limit",
    ]);
    expect(result.session?.stopCause).toBe(result.lanes?.[0]?.session?.stopCause);
    expect(result.diagnostics).toEqual({ category: "mixed", stopCause: "mixed" });
    expect(deriveRunFacts(result)).toMatchObject({
      outcome: "none_passed",
      diagnosticCategory: "mixed",
      stopCause: "mixed",
    });
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.review.summary).toContain(
      "1 interrupted (provider output limit), 1 interrupted (provider token limit)",
    );
    expect(bundle.review.summary).not.toContain("stop details unavailable");
    expect(
      bundle.streams.map((stream: { actor: { stopCause: string } }) => stream.actor.stopCause),
    ).toEqual(result.lanes?.map((lane) => lane.session?.stopCause));
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
    expect(handle.killed.sort()).toEqual(handle.createdIds.sort());
  });

  it("adapter fail score turns an otherwise green CUA fan-out run red while preserving the verified bundle", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: FANOUT_ENV,
        scorer: browserScorer({ score: fanoutFailScore }),
      },
      passingSeams(handle),
    );

    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    expect(result.laneSummary).toMatchObject({
      total: 4,
      passed: 4,
      skipped: 0,
      harnessErrors: 0,
      hollow: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(FANOUT_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.adapterScore?.data?.participantCount).toBe(4);
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(
      true,
    );

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  describe("clone subject across two participants", () => {
    const cloneFanoutConfig = (): StudyConfig => {
      const parsed = parseStudy({
        schema: V2_SCHEMA,
        id: "clone-fanout-proof",
        title: "Clone fan-out proof",
        subject: {
          source: "clone",
          repos: ["example-org/example-app"],
          serve: { start: "pnpm start", url: "http://127.0.0.1:3000/" },
        },
        actors: [
          {
            type: "openai-computer-use",
            persona: "first-time-visitor",
            mission: "Explore the app and stop.",
            count: 2,
          },
        ],
        execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency: 2 },
        scenario: { mode: "live" },
      });
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.config;
    };
    const cloneModule = (commits: readonly [string, string]) =>
      makeFanoutModule({
        commandHandler: (laneIndex, command) => {
          if (command.includes("/status")) return { stdout: "0" };
          if (command.includes("rev-parse")) return { stdout: `${commits[laneIndex]}\n` };
          if (command.includes("curl")) return { stdout: "READY" };
          return undefined;
        },
      });

    it("gives each participant its own commit and omits a divergent top-level commit", async () => {
      const commits = ["1111111111111111aaaa", "2222222222222222bbbb"] as const;
      const outcome = await runStudyWith(
        cloneFanoutConfig(),
        {
          cwd,
          env: FANOUT_ENV,
        },
        passingSeams(cloneModule(commits)),
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      const result = outcome.result;
      expect(result.lanes?.map((entry) => entry.subject?.commit)).toEqual(commits);
      expect(result.subject?.commit).toBeUndefined();
      expect(result.warnings.some((warning) => warning.includes("different subject commits"))).toBe(
        true,
      );
    });

    it("carries the commit at the top level when both participants resolved the same one", async () => {
      const commit = "3333333333333333cccc";
      const outcome = await runStudyWith(
        cloneFanoutConfig(),
        {
          cwd,
          env: FANOUT_ENV,
        },
        passingSeams(cloneModule([commit, commit])),
      );
      if (outcome.route !== "computer-use") throw new Error("expected cua backend");
      expect(outcome.result.subject?.commit).toBe(commit);
      expect(outcome.result.warnings.some((warning) => warning.includes("DIVERGENT"))).toBe(false);
    });
  });

  it("pipeline gate: lane-1 provisioning failure ⇒ the remaining participants never start a sandbox", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: FANOUT_ENV,
        // Fail provisioning for participant 0 (the gate owner) through prepareDesktop's target.
        prepareDesktop: async (_desktop, target) => {
          if (target.kind === "participant" && target.participant.index === 0)
            throw new Error("lane-0 world failed to provision");
        },
      },
      passingSeams(handle),
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    // Only participant 0's sandbox was ever created; the gate kept participants 2-4 from starting.
    expect(handle.created).toHaveLength(1);
    expect(handle.created[0]?.metadata?.participantId).toBe("mobile-newcomer");
    // Participant 0's sandbox was still torn down by id.
    expect(handle.killed).toEqual(["fake-sandbox-01"]);
    // The other participants are reported blocked.
    expect(result.laneSummary?.skipped).toBe(3);
    expect(result.lanes?.slice(1).every((lane) => lane.status === "blocked")).toBe(true);
    expect(result.lanes?.[1]?.skippedReason).toContain("pipeline gate");
    // The skip names the participant whose provisioning failed.
    expect(result.lanes?.[1]?.skippedReason).toContain(
      "participant mobile-newcomer failed to provision",
    );
  });

  it("fail-fast on a harness error: in-flight participants finish, queued participants are blocked + a fail-fast event, run ok=false, completed evidence intact", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          // Participant "small-skimmer" (index 1) hits a harness error; participant 0 finishes in
          // flight.
          if (options.persona.id === "impatient-skimmer") {
            await delay(5);
            throw new Error("provider exploded mid-session");
          }
          await delay(25);
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.laneSummary?.harnessErrors).toBe(1);
    expect(result.laneSummary?.skipped).toBeGreaterThanOrEqual(1);
    // Only the in-flight participants (0 and 1) ever created a sandbox; queued participants were
    // skipped.
    expect(handle.created.length).toBeLessThanOrEqual(2);
    // Every created sandbox was torn down by id (no leak, no enumerate).
    expect([...handle.killed].sort()).toEqual([...handle.createdIds].sort());

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    // A fail-fast event is recorded.
    expect(bundle.events.some((e: { type: string }) => e.type === "cua-lab.fanout.fail-fast")).toBe(
      true,
    );
    // Completed evidence intact: participant 0 reached a terminal session with an actor trace.
    const laneZero = bundle.streams.find((s: { id: string }) => s.id === "stream-001");
    expect(laneZero?.actor?.lane).toBe("computer-use");
    // The bundle is still a verifiable record (the failure is the evidence).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("a hollow participant (zero actions/messages) ⇒ run ok=false and verifyRun fails the engagement check", async () => {
    const handle = makeFanoutModule();
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          const responses = options.persona.id === "power-user" ? HOLLOW_SESSION : TWO_TURN_SESSION;
          return runCuaActorSession({
            ...options,
            openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(responses) },
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.laneSummary?.hollow).toBe(1);
    // No fail-fast: a mission/hollow verdict never trips it; all participants still ran.
    expect(handle.created).toHaveLength(4);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(false);
  });

  it("geometry mismatch ⇒ DEVICE_GEOMETRY (the per-participant device claim is verified in-sandbox)", async () => {
    // Single participant whose desktop reports the wrong dimensions.
    const handle = makeFanoutModule({ geometryOverride: () => [800, 600] });
    const config = parseStudy({
      schema: V2_SCHEMA,
      id: "geometry-proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", mission: "Explore." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { device: "mobile" } },
      scenario: { mode: "live" },
    });
    if (!config.ok) throw new Error(config.error.message);
    const outcome = await runStudyWith(
      config.config,
      { cwd, env: FANOUT_ENV },
      passingSeams(handle),
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_DEVICE_GEOMETRY");
    // The sandbox was still torn down by id (fail-closed never leaks).
    expect(handle.killed).toEqual(handle.createdIds);
  });

  it("per-participant secret scrub holds: a provisioned/actor key value never reaches any artifact", async () => {
    const handle = makeFanoutModule();
    const secret = "test-openai-key";
    const outcome = await runStudyWith(
      fanoutConfig({ concurrency: 2 }),
      {
        cwd,
        env: { OPENAI_API_KEY: secret, E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          // One participant's harness error echoes the actor key value: it must be scrubbed
          // everywhere.
          if (options.persona.id === "comparison-shopper") {
            throw new Error(`request failed using ${secret} while connecting`);
          }
          await delay(10);
          return runCuaActorSession({
            ...options,
            openai: { apiKey: secret, fetchFn: scriptedFetch(TWO_TURN_SESSION) },
          });
        },
      },
    );
    if (outcome.route !== "computer-use") throw new Error("expected cua backend");
    const result = outcome.result;

    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(runDir, file), "utf8");
      expect(text, file).not.toContain(secret);
    }
    // And the actor traces likewise.
    const traceFiles = await readdir(path.join(runDir, "actors"));
    for (const traceFile of traceFiles) {
      const text = await readFile(path.join(runDir, "actors", traceFile), "utf8");
      expect(text, traceFile).not.toContain(secret);
    }
    // The participant error is still diagnosable but scrubbed.
    expect(JSON.stringify(result.lanes)).not.toContain(secret);
  });
});

describe("cua fan-out: engine fail-closed guards", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-fanout-guard-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("rejects multi-participant fan-out on the in-process route (inProcess): single participant only", async () => {
    const handle = makeFanoutModule();
    const result = await runCuaActorLab({
      cwd,
      config: fanoutConfig({ concurrency: 2 }),
      dryRun: false,
      deps: {
        desktopModule: async () => handle.module,
      },
      inProcess: {
        executor: async () => ({
          observe: async () => ({ stateSignature: "x", appState: {} }),
          execute: async () => undefined,
        }),
      },
      createProvider: async () => ({
        id: "p",
        capabilities: {
          headless: true,
          structuredTrace: true,
          lanes: ["computer-use"],
          producesScreenshots: false,
          byoModel: true,
          preGrantableApprovals: false,
          inProcessTools: false,
          license: "open",
        },
        async nextTurn() {
          return { actions: [], pendingSafetyChecks: [], done: true };
        },
      }),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_FANOUT_INVALID");
    // Nothing was provisioned.
    expect(handle.created).toHaveLength(0);
  });

  it("re-enforces clone.fanout rejection at the engine even if a config bypasses the parser", async () => {
    const base = fanoutConfig({ concurrency: 2 });
    const tampered = { ...base, subject: { ...base.subject, clone: { fanout: 2 } } } as StudyConfig;
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_COMPUTER_USE_FANOUT_INVALID");
  });
});

describe("cua fan-out: cost estimate (sum participant token lines + one aggregate desktop line)", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-fanout-cost-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  const usageSession = (input: number, output: number): unknown[] => [
    {
      id: "resp_1",
      output: [
        { type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] },
      ],
      usage: { input_tokens: input, output_tokens: output },
    },
    {
      id: "resp_2",
      output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  ];

  it("emits model and observed-desktop lines per participant, summing without double-counting", async () => {
    const handle = makeFanoutModule();
    const config = fanoutConfig({
      concurrency: 2,
      lanes: [
        { id: "role-a", persona: "role-a", device: "desktop", instruction: "Explore role A." },
        { id: "role-b", persona: "role-b", device: "desktop", instruction: "Explore role B." },
      ],
    });
    const outcome = await runStudyWith(
      config,
      {
        cwd,
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      },
      {
        desktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) =>
          runCuaActorSession({
            ...options,
            openai: {
              ...options.openai,
              apiKey: "test-openai-key",
              fetchFn: scriptedFetch(usageSession(1000, 200)),
            },
          }),
      },
    );
    expect(outcome.route).toBe("computer-use");
    if (outcome.route !== "computer-use") return;
    const result = outcome.result;
    expect(result.ok).toBe(true);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    const cost = bundle.cost;
    expect(cost.schema).toBe("humanish.run-cost-summary.v1");

    const modelLines = cost.breakdown.filter((l: { kind: string }) => l.kind === "model-tokens");
    const desktopLines = cost.breakdown.filter(
      (l: { kind: string }) => l.kind === "desktop-minutes",
    );
    // Each owned desktop retains its participant and resource basis.
    expect(modelLines).toHaveLength(2);
    expect(new Set(modelLines.map((l: { laneId?: string }) => l.laneId))).toEqual(
      new Set(["role-a", "role-b"]),
    );
    expect(desktopLines).toHaveLength(2);
    expect(new Set(desktopLines.map((line: { laneId?: string }) => line.laneId))).toEqual(
      new Set(["role-a", "role-b"]),
    );

    // Token usage summed across both participants (2 * {input:1000, output:200}).
    expect(cost.tokenUsage).toEqual({ input: 2000, output: 400, total: 2400 });

    // The total is exactly the sum of the known lines: the invariant verify also asserts.
    const knownSum = cost.breakdown
      .filter((l: { estimatedCostUsd: number | null }) => l.estimatedCostUsd !== null)
      .reduce((s: number, l: { estimatedCostUsd: number }) => s + l.estimatedCostUsd, 0);
    expect(cost.estimatedTotalUsd).toBeCloseTo(Math.round(knownSum * 1e6) / 1e6, 9);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.checks.find((c) => c.name === "cost estimate labeling")?.ok).toBe(true);
    expect(verify.ok).toBe(true);
  });
});

describe("resolveParticipantDevice floors sub-500 mobile widths to the Chrome window minimum (no clip)", () => {
  const cfg = (device?: string, rawResolution?: [number, number]): StudyConfig => {
    const parsed = parseStudy({
      schema: V2_SCHEMA,
      id: "floor-probe",
      title: "floor probe",
      subject: { source: "app-url", appUrl: "https://example.com/" },
      policies: { allowPublicTargets: true },
      actors: [
        {
          type: "openai-computer-use",
          mission: "Look.",
          lanes: [
            { id: "solo", ...(device ? { device } : {}), instruction: "Look at the screen." },
          ],
        },
      ],
      execution: {
        target: "e2b-desktop",
        timeoutMs: 60_000,
        ...(rawResolution ? { desktop: { resolution: rawResolution } } : {}),
      },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  };

  it("floorRenderResolution raises a sub-minimum width, leaves height + wide screens untouched", () => {
    expect(floorRenderResolution([414, 896])).toEqual([MIN_DESKTOP_RENDER_WIDTH, 896]);
    expect(floorRenderResolution([360, 740])).toEqual([MIN_DESKTOP_RENDER_WIDTH, 740]);
    expect(floorRenderResolution([1440, 950])).toEqual([1440, 950]);
    expect(MIN_DESKTOP_RENDER_WIDTH).toBe(500);
  });

  it("mobile participant renders at the 500px floor but keeps the 414 device identity", () => {
    const d = resolveParticipantDevice(cfg("mobile"), "mobile");
    expect(d.resolution).toEqual([500, 896]); // rendered screen the window fits (no clip)
    expect(d.preset.width).toBe(414); // declared device identity (prompt + metadata) is unfloored
    expect(d.preset.isMobile).toBe(true);
  });

  it("records the declared preset when the width was floored, so the bundle is not self-confirming", () => {
    // A floored run must not look like a faithful one. `verified` compares the floored number with
    // itself, so without `declared` a reader sees requested 500 / verified 500 and concludes a
    // 500-wide screen was asked for. Both mobile presets render at 500 and are otherwise identical.
    const mobile = resolveParticipantDevice(cfg("mobile"), "mobile");
    expect(declaredScreenForRender(mobile.preset, mobile.name, mobile.resolution)).toEqual({
      width: 414,
      height: 896,
      preset: "mobile",
    });

    const small = resolveParticipantDevice(cfg("small-mobile"), "small-mobile");
    expect(declaredScreenForRender(small.preset, small.name, small.resolution)).toEqual({
      width: 360,
      height: 740,
      preset: "small-mobile",
    });

    // ...and the two floored participants really are indistinguishable by rendered width, which is
    // the reason a study cannot claim it exercised two different mobile layouts on this route.
    expect(mobile.resolution[0]).toBe(small.resolution[0]);
  });

  it("omits `declared` when the preset rendered faithfully", () => {
    const desktop = resolveParticipantDevice(cfg("desktop"), "desktop");
    expect(
      declaredScreenForRender(desktop.preset, desktop.name, desktop.resolution),
    ).toBeUndefined();
  });

  it("small-mobile floors to 500 too; desktop is untouched", () => {
    expect(resolveParticipantDevice(cfg("small-mobile"), "small-mobile").resolution).toEqual([
      500, 740,
    ]);
    expect(resolveParticipantDevice(cfg("desktop"), "desktop").resolution).toEqual([1440, 950]);
  });

  it("a raw sub-500 escape-hatch resolution is floored as well", () => {
    expect(resolveParticipantDevice(cfg(undefined, [400, 800]), undefined).resolution).toEqual([
      500, 800,
    ]);
  });
});

// The participant runner is total: every exit path records an outcome. Before the guard, one
// participant's late throw (e.g. its post-teardown trace write hitting ENOSPC) rejected the whole
// mapWithConcurrency while sibling workers kept launching sandboxes nobody would record: spent
// money, vanished evidence. These drive runCuaParticipants directly with an injected participant
// runner so the throw path (not the already-guarded in-session error path) is what is under test.
describe("runCuaParticipants total-runner guard", () => {
  const spec = (id: string, index: number): DesktopParticipantRun =>
    participantRun({
      id,
      index,
      recordId: `sim-${id}`,
      streamId: `stream-${id}`,
      persona: { id: "p", traitsApplied: [], promptDigest: `prompt-${id}` },
      instructions: "x",
      screenshotDir: id,
      traceArtifactPath: `actors/stream-${id}.json`,
    });
  const okOutcome = (s: DesktopParticipantRun) => ({
    spec: s,
    killed: true,
    streamUrlPresent: false,
    screenshots: [],
    stateStepRecords: [],
    phaseRecords: [],
    warnings: [],
    noEngagement: false,
    selfReportedBlocker: false,
    harnessError: false,
  });
  const deps = {} as unknown as Parameters<typeof runCuaParticipants>[1];

  it("a throwing participant records a harness_error outcome; siblings and the aggregate stay intact", async () => {
    const specs = [spec("lane-01", 0), spec("lane-02", 1), spec("lane-03", 2)];
    const { outcomes, failFastReason } = await runCuaParticipants(
      specs,
      deps,
      1,
      async (s, laneDeps) => {
        if (s.planned.index === 0) {
          (laneDeps as { signalProvisioned?: (ok: boolean) => void }).signalProvisioned?.(true);
          return okOutcome(s);
        }
        if (s.planned.id === "lane-02")
          throw new Error("ENOSPC: no space left on device, write actors/stream-lane-02.json");
        return okOutcome(s);
      },
    );

    // Every participant appears exactly once with a terminal status: nothing vanished.
    expect(outcomes.map((o) => o.spec.planned.id)).toEqual(["lane-01", "lane-02", "lane-03"]);
    expect(outcomes[0]!.harnessError).toBe(false);
    expect(outcomes[1]!.harnessError).toBe(true);
    expect(outcomes[1]!.sessionError).toContain(
      "participant runner threw outside the session guard",
    );
    expect(outcomes[1]!.sessionError).toContain("ENOSPC");
    // fail-fast tripped by the harness error, so the queued participant is blocked with a pinned
    // reason rather than silently launching after the run already failed.
    expect(outcomes[2]!.skippedReason).toContain("fail-fast");
    expect(failFastReason).toContain("lane-02");
  });

  it("participant 0 throwing before it signals the provisioning gate releases the followers as blocked instead of hanging them", async () => {
    const specs = [spec("lane-01", 0), spec("lane-02", 1), spec("lane-03", 2)];
    const { outcomes } = await runCuaParticipants(specs, deps, 3, async (s) => {
      if (s.planned.index === 0) throw new Error("world provisioning exploded before signal");
      return okOutcome(s);
    });
    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]!.harnessError).toBe(true);
    // Followers were awaiting the gate; the guard rejects it on lane-0 throw so they resolve as
    // blocked (pipeline gate): the run ends instead of hanging on a promise nobody will settle.
    expect(outcomes[1]!.skippedReason ?? "").toContain("pipeline gate");
    expect(outcomes[2]!.skippedReason ?? "").toContain("pipeline gate");
  });
});
