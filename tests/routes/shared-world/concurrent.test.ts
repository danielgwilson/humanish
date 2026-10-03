import { automaticAnalysisBoundary } from "../../helpers/automatic-analysis-boundary.js";
import type { StudyDeps } from "../../../src/study/study-deps.js";
import { phaseEvent, type StudyEvent } from "../../../src/study/run-study-events.js";
import type { BrowserScorer } from "../../../src/study/adapter-extension.js";
import { captureStderr, runDirSnapshot } from "../../helpers/run-golden.js";
import { expectFailureGolden } from "../../helpers/failure-golden.js";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Command } from "commander";
import { parse } from "yaml";
import { PNG } from "pngjs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ACTOR_TRACE_SCHEMA,
  type ActorCompletionReason,
  type ActorStatus,
  type ActorTrace,
} from "../../../src/actors/contract.js";
import type { CuaActorSessionOptions } from "../../../src/actors/computer-use/actor.js";
import type { CuaLoopResult } from "../../../src/actors/computer-use/loop.js";
import type {
  E2BDesktopCreateOptions,
  E2BDesktopModule,
  E2BDesktopSandbox,
} from "../../../src/substrates/e2b/sdk.js";
import {
  concurrentSharedWorldValidationReason,
  sharedWorldValidationReason,
} from "../../../src/study/validation.js";
import { V2_SCHEMA, type StudyConfig } from "../../../src/study/types.js";
import { parseStudyDocument } from "../../../src/study/config.js";
import { isSharedWorldComposition } from "../../../src/study/routing.js";
import { prepareStudy, runStudyWith } from "../../../src/run-study.js";
import { routeOf } from "../../../src/study/plan.js";
import { sharedWorldRouteRun } from "../../../src/cli/commands/study-route-shared-world.js";
import { runConcurrentSharedWorld } from "../../../src/routes/shared-world/route.js";
import {
  extractLobbyCodeFromNarration,
  parseLobbyCodeReply,
  extractResponsesOutputText,
  readLobbyCodeFromFrame,
} from "../../../src/routes/shared-world/lobby-code.js";
import type { BrowserScoringContext, RunAdapterScore, RunBundle } from "../../../src/index.js";
import type { SubjectPhaseEvent } from "../../../src/subject/steps.js";
import { reclaimRunSandboxes } from "../../../src/run/reclaim.js";
import { verifyRun } from "../../../src/verify/verify.js";
import { sharedWorldEvidenceFindings } from "../../../src/verify/shared-world.js";
import {
  LANE_SHAPE_VARIANTS,
  pinnedVerifyResult,
  verifyGolden,
  type PinnedVerifyResult,
} from "../../helpers/verify-findings.js";
import { computeStats } from "../../../src/run/stats.js";
import {
  serveObserver,
  type ObserverResult,
  type ObserverServer,
} from "../../../src/observer/render.js";
import type { LocalTreeArchive } from "../../../src/subject/local-tree-archive.js";

// ---------------------------------------------------------------------------
// Fakes for the N+1 substrate. The module records create/kill by id and exposes
// no `list` (enumerate-and-kill is impossible by construction). Each fake sandbox
// has getHost(port) → a bare tokenless host keyed on its id (no scheme, exactly as
// the real @e2b SDK returns it: the orchestrator normalizes it to https://). The command handler drives
// the detached primitive (provisioning + checkpoints) and returns stateful
// checkpoint output (a shared worldVersion the fake runSession bumps per turn).
//
// Overlap is produced, not injected. The fake runSession blocks on a
// rendezvous latch until all N actors have entered, so N participant fns are genuinely
// in-flight while the real orchestrator clock (Date.now, not overridden) measures
// the wrapped [start,end] laneWindows. The windows therefore overlap for real.
// ---------------------------------------------------------------------------

interface FakeSandbox extends E2BDesktopSandbox {
  calls: Array<[string, ...unknown[]]>;
}

const FAKE_DESKTOP_SCREEN = { width: 1440, height: 950 } as const;
const FAKE_DESKTOP_VIEWPORT = { width: 1440, height: 817, deviceScaleFactor: 1 } as const;

function browserTargetFromCalls(calls: Array<[string, ...unknown[]]>): string | undefined {
  for (const call of calls) {
    if (call[0] === "open") return String(call[1]);
    if (call[0] !== "commands.run") continue;
    const target = String(call[1]).match(/^target_url='([^']+)'$/m)?.[1];
    if (target) return target;
  }
  return undefined;
}

function makeFakeSandbox(
  id: string,
  commandHandler: (command: string) => { stdout?: string } | undefined,
): FakeSandbox {
  const calls: Array<[string, ...unknown[]]> = [];
  const sandbox = {
    calls,
    sandboxId: id,
    commands: {
      run: async (command: string) => {
        calls.push(["commands.run", command]);
        return commandHandler(command) ?? { exitCode: 0, stdout: "" };
      },
    },
    files: {
      // Raw data (never String()-coerced): existing callers write string script content
      // (String(data) === data for those, unchanged), and the local-tree upload path writes a
      // real ArrayBuffer that tests need to inspect directly (byteLength, reference equality).
      write: async (filePath: string, data: string | ArrayBuffer) => {
        calls.push(["files.write", filePath, data]);
        return undefined;
      },
    },
    launch: async (application: string, uri?: string) => {
      calls.push(["launch", application, uri]);
    },
    open: async (fileOrUrl: string) => {
      calls.push(["open", fileOrUrl]);
    },
    getHost: (port: number) => `${port}-${id}.e2b.app`, // bare host (no scheme); matches the real @e2b SDK
    async screenshot() {
      return new Uint8Array([1, 2, 3, 4]);
    },
    async wait(ms: number) {
      calls.push(["wait", ms]);
    },
    stream: {
      getAuthKey: () => "fake-auth-key",
      getUrl: () => "https://stream.invalid/fake-auth-key",
      start: async (options?: unknown) => {
        calls.push(["stream.start", options]);
      },
    },
  };
  return sandbox as unknown as FakeSandbox;
}

function makeFakeModule(
  commandHandler: (command: string) => { stdout?: string } | undefined,
  fitToResolution = true,
): {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
} {
  const created: E2BDesktopCreateOptions[] = [];
  // Parallel to `created`: the custom template each create() got; subject and every actor sandbox.
  // undefined == called with no template arg (the byte-stable default).
  const templates: (string | undefined)[] = [];
  const killed: string[] = [];
  const sandboxes: FakeSandbox[] = [];
  let n = 0;
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
        n += 1;
        const [width, height] = createOptions.resolution ?? [1440, 950];
        const sandbox = makeFakeSandbox(`fake-sandbox-${String(n).padStart(3, "0")}`, (command) => {
          // A phone participant has its own physical display, including in the committed live
          // fixture.
          if (fitToResolution && command.includes("xdpyinfo"))
            return { stdout: `dimensions: ${width}x${height} pixels\n` };
          if (fitToResolution && command.includes("xwininfo -id"))
            return {
              stdout: `Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: ${width}\nHeight: ${height}\nMap State: IsViewable\n`,
            };
          return commandHandler(command);
        });
        templates.push(template);
        created.push(createOptions);
        sandboxes.push(sandbox);
        return sandbox;
      },
      kill: async (sandboxId) => {
        killed.push(sandboxId);
        return true;
      },
      // NOTE: no `list` method.
    },
  };
  return { module, created, templates, killed, sandboxes };
}

function makeCommandHandler(state: {
  worldVersion: number;
}): (command: string) => { stdout?: string } | undefined {
  return (command: string): { stdout?: string } | undefined => {
    if (command.includes("xdpyinfo"))
      return { stdout: "dimensions: 1440x950 pixels (381x251 millimeters)\n" };
    if (command.includes("browser_preference='default'"))
      return { stdout: "HUMANISH_BROWSER_RESOLVED=google-chrome\n" };
    if (command.includes("/status")) return { stdout: "0" };
    if (command.includes("rev-parse")) return { stdout: "abc123def4567890abc1\n" };
    if (command.includes("curl")) return { stdout: "READY" };
    if (command.includes("checkpoint-") && command.includes("tail -c"))
      return { stdout: `world=${state.worldVersion}\n` };
    if (command.includes("find_chrome_window")) return { stdout: "WINDOW_ID=424242\n" };
    if (command.includes("xwininfo -id"))
      return {
        stdout:
          "Absolute upper-left X: 0\nAbsolute upper-left Y: 0\nWidth: 1440\nHeight: 950\nMap State: IsViewable\n",
      };
    if (command.includes("browserWindow: { x: window.screenX")) {
      return {
        stdout: JSON.stringify({
          browserWindow: { x: 0, y: 0, ...FAKE_DESKTOP_SCREEN },
          viewport: FAKE_DESKTOP_VIEWPORT,
        }),
      };
    }
    if (command.includes("tail -c")) return { stdout: "" };
    return undefined;
  };
}

/** A rendezvous latch: the returned fn blocks until `count` callers have entered, then releases
 *  them all, so `count` participant fns are genuinely in-flight at once (real overlap). */
function makeRendezvous(count: number): () => Promise<void> {
  let arrived = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrived += 1;
    if (arrived >= count) release();
    await gate;
  };
}

// A full-suite run on a loaded machine can take several seconds to reach a condition that is
// immediate when the file runs alone. The wait returns as soon as the condition holds.
async function waitForCondition(
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeTrace(args: {
  persona: { id: string; traitsApplied: string[]; promptDigest: string };
  status: ActorStatus;
  completionReason: ActorCompletionReason;
  actions: number;
  messages: number;
  reason?: string;
}): ActorTrace {
  return {
    schema: ACTOR_TRACE_SCHEMA,
    provider: "fake-cua",
    protocol: "cua-loop",
    lane: "computer-use",
    persona: args.persona,
    redaction: { status: "passed", screenshots: "n/a", notes: "fake trace (no frames captured)" },
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1000,
    status: args.status,
    completionReason: args.completionReason,
    reason: args.reason ?? `${args.status} (${args.completionReason})`,
    ids: {},
    counts: { actions: args.actions, messages: args.messages, screenshots: 0 },
    items: [
      ...(args.messages > 0
        ? [
            {
              id: "i-msg",
              kind: "message" as const,
              lifecycle: "completed" as const,
              title: "message",
              text: "did my task",
            },
          ]
        : []),
      ...(args.actions > 0
        ? [
            {
              id: "i-act",
              kind: "ui_action" as const,
              lifecycle: "completed" as const,
              title: "click",
            },
          ]
        : []),
    ],
    capabilities: {
      headless: true,
      structuredTrace: true,
      lanes: ["computer-use"],
      producesScreenshots: true,
      byoModel: false,
      preGrantableApprovals: false,
      inProcessTools: false,
      license: "proprietary",
    },
  };
}

/** A runSession fake: rendezvous (real overlap) → bump the shared world → engaged passed trace,
 *  unless a per-call override (harness throw / mission failure) applies. */
function makeRunSession(
  state: { worldVersion: number },
  rendezvous: () => Promise<void>,
  override?: (index: number) =>
    | {
        throwMessage?: string;
        status?: ActorStatus;
        completionReason?: ActorCompletionReason;
        reason?: string;
        actions?: number;
        messages?: number;
        /** False leaves the shared world unchanged by this participant's turn. */
        mutates?: boolean;
      }
    | undefined,
): (options: CuaActorSessionOptions) => Promise<CuaLoopResult> {
  let calls = -1;
  return async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
    calls += 1;
    // The override targets a participant (by its persona id), never "the Nth call": concurrent
    // participants interleave however the scheduler likes, so call order is an accident: asserting
    // on it made these tests flake the moment an unrelated await shifted the schedule.
    const personaMatch = /^persona-(\d+)$/.exec(options.persona.id);
    const myIndex = personaMatch ? Number(personaMatch[1]) - 1 : calls;
    await rendezvous(); // all actors are in-flight here → their windows overlap on the real clock
    // All participants were released together; hold them concurrently for a measurable interval so
    // the real orchestrator clock records overlapping [start,end] windows (Date.now is
    // ms-resolution: without this the instant fake collapses every window to a zero-width point).
    // The overlap is genuinely produced (all participants are in this delay at once), not injected.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 15);
    });
    const o = override?.(myIndex);
    if (o?.mutates !== false) state.worldVersion += 1; // each actor's turn mutates the shared world
    if (o?.throwMessage) {
      throw new Error(o.throwMessage);
    }
    const status = o?.status ?? "passed";
    const completionReason = o?.completionReason ?? "goal_satisfied";
    const trace = makeTrace({
      persona: options.persona,
      status,
      completionReason,
      actions: o?.actions ?? 1,
      messages: o?.messages ?? 1,
      ...(o?.reason === undefined ? {} : { reason: o.reason }),
    });
    return { status, completionReason, reason: trace.reason, trace };
  };
}

function concurrentConfig(roleCount = 3, concurrency = 3, template?: string): StudyConfig {
  const lanes = Array.from({ length: roleCount }, (_unused, i) => ({
    id: `persona-${String(i + 1).padStart(2, "0")}`,
    actorType: i === 0 ? "initiator" : "collaborator",
    surface: i === 0 ? "intake" : "review",
    caseGroup: "case-001",
    persona: `persona-${i + 1}`,
    entry: `/seat-${i + 1}`,
  }));
  const parsed = parseStudyDocument({
    schema: V2_SCHEMA,
    id: "concurrent-shared-world-proof",
    title: "Concurrent shared-world proof",
    subject: {
      source: "clone",
      topology: "shared-world",
      exposure: "synthetic",
      repos: ["example-org/collab-app"],
      env: ["DATABASE_URL"],
      serve: {
        install: "pnpm install",
        start: "pnpm start -H 0.0.0.0",
        url: "http://127.0.0.1:3000/",
      },
      state: {
        seed: [{ name: "migrate", command: "pnpm db:migrate" }],
        checkpoint: [
          { name: "notes-count", command: "psql query notes" },
          { name: "reviews-count", command: "psql query reviews" },
        ],
      },
    },
    actors: [{ type: "openai-computer-use", mission: "Use the shared app.", lanes }],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      concurrency,
      ...(template === undefined ? {} : { desktop: { template } }),
    },
    scenario: { mode: "live" },
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

/** The seams, writable so a test can swap one. */
type TestDeps = { -readonly [K in keyof StudyDeps]: StudyDeps[K] };

/** Keys and the subject env value every fake run gets. */
const testEnv = (): Record<string, string> => ({
  OPENAI_API_KEY: "test-openai-key",
  E2B_API_KEY: "test-e2b-key",
  DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak",
});

function baseSeams(
  state: { worldVersion: number },
  rendezvous: () => Promise<void>,
  override?: Parameters<typeof makeRunSession>[2],
): {
  env: Record<string, string>;
  deps: TestDeps;
  created: E2BDesktopCreateOptions[];
  templates: (string | undefined)[];
  killed: string[];
  sandboxes: FakeSandbox[];
  phaseEvents: SubjectPhaseEvent[];
} {
  const { module, created, templates, killed, sandboxes } = makeFakeModule(
    makeCommandHandler(state),
  );
  const phaseEvents: SubjectPhaseEvent[] = [];
  const deps: TestDeps = {
    desktopModule: async () => module,
    runSession: makeRunSession(state, rendezvous, override),
    detachedTimers: { now: () => 0, sleep: async () => {} },
    proberCadenceMs: 100_000, // large: no periodic snapshot fires in the fast test (baseline+final carry the gate)
    // Captures instead of writing to real stderr (the default without a sink); also lets tests
    // assert the ordered phase-boundary sequence.
    subjectPhaseSink: (event) => phaseEvents.push(event),
  };
  return { env: testEnv(), deps, created, templates, killed, sandboxes, phaseEvents };
}

const CONCURRENT_ADAPTER_NAMESPACE = "concurrent-browser-adapter-proof";

function concurrentFailScore(ctx: BrowserScoringContext): RunAdapterScore {
  return {
    schema: "humanish.adapter-score.v1",
    namespace: CONCURRENT_ADAPTER_NAMESPACE,
    status: "fail",
    score: 20,
    summary: `${ctx.route} adapter found no product-level concurrent success evidence.`,
    data: {
      route: ctx.route,
      participantCount: ctx.participantCount,
    },
  };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "humanish-concurrent-sw-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("runConcurrentSharedWorld (the heart: real orchestration + rendezvous latch, $0)", () => {
  it.each([true, false])("preserves each role's authored focus (dryRun %s)", async (dryRun) => {
    const config = concurrentConfig();
    delete config.review; // Omitted config uses the separate default analysis budget.
    const analyze = automaticAnalysisBoundary();
    config.actors[0]!.lanes!.forEach((lane, i) => {
      lane.instruction = `Review section ${i + 1}.`;
    });
    config.actors[0]!.mission = "Use the shared app with test-openai-key.";
    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({
      cwd,
      config,
      dryRun,
      env,
      deps: { ...deps, analysis: { run: analyze } },
    });
    expect(analyze).toHaveBeenCalledTimes(dryRun ? 0 : 1);
    expect(result.automaticAnalysis?.reason).toBe(
      dryRun ? "AUTOMATIC_ANALYSIS_DRY_RUN" : "synthetic_no_provider",
    );
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.streams.map((stream) => stream.assignment)).toEqual(
      [1, 2, 3].map((i) => ({
        mission: "Use the shared app with [REDACTED_SECRET].",
        focus: `Review section ${i}.`,
      })),
    );
    expect(JSON.stringify(bundle)).not.toContain("test-openai-key");
    expect(
      await readFile(
        path.join(cwd, ".humanish", "runs", result.runId, "observer", "observer-data.json"),
        "utf8",
      ),
    ).not.toContain("test-openai-key");
    expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
  });

  it("shares one actor budget on the provisioned plane", async () => {
    const config = concurrentConfig();
    config.actors[0]!.model = "gpt-5.5";
    config.execution!.caps = { maxUsd: 1, maxTotalUsd: 0.04 };
    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const session = deps.runSession!;
    const seen: CuaActorSessionOptions[] = [];
    deps.runSession = (options) => {
      seen.push(options);
      return session(options);
    };
    await runConcurrentSharedWorld({ cwd, config, dryRun: false, env, deps });
    expect(seen).toHaveLength(3);
    const usage = { input: 5000, output: 0 };
    expect(seen[0]!.overRunBudget?.(usage)).toBeNull();
    expect(seen[1]!.overRunBudget?.(usage)).toContain("study budget reached");
    expect(seen[0]!.overRunBudget?.(usage)).toContain("study budget reached");
  });

  it("refuses an unpriceable cap before provisioning the shared plane", async () => {
    const config = concurrentConfig();
    config.actors[0]!.model = "unknown-priced-model";
    config.execution!.caps = { maxTotalUsd: 1 };
    const { env, created, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, env, deps });
    expect(result.error?.message).toContain("humanish has no rate for model");
    expect(created).toHaveLength(0);
  });

  it("refuses a custom session before allocating the concurrent shared plane with an output limit", async () => {
    const config = concurrentConfig();
    config.actors[0]!.maxOutputTokens = 16;
    const { env, created, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, env, deps });
    expect(result.error?.message).toContain("custom runSession");
    expect(created).toHaveLength(0);
  });
  it("saves the study's provenance as study in the bundle head, after artifactRoot", async () => {
    const lab = {
      id: "shared-lab",
      path: "humanish/labs/shared-lab.yaml",
      origin: "committed" as const,
    };
    // runStudyWith takes the provenance the CLI resolved, and planStudy puts it on the plan.
    const outcome = await runStudyWith(concurrentConfig(), { cwd, dryRun: true, study: lab });
    if (outcome.route !== "shared-world") throw new Error(`routed to ${outcome.route}`);
    const { result } = outcome;
    expect(result.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.study).toEqual(lab);
    expect(bundle).not.toHaveProperty("lab");
    expect(Object.keys(bundle).slice(0, 9)).toEqual([
      "schema",
      "runId",
      "mode",
      "simCount",
      "createdAt",
      "cwd",
      "artifactRoot",
      "study",
      "source",
    ]);
  });

  it("dry-run produces a verified contract bundle (concurrent shape + attributionClass + limits), no sandboxes", async () => {
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(),
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.subjectSandbox).toBeUndefined();
    expect(result.topologyMode).toBe("concurrent");
    expect(result.roleCount).toBe(3);
    expect(result.concurrency).toBe(3);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.timeline).toBeUndefined();
    expect(bundle.sharedWorld.attributionLimits).toEqual(
      expect.arrayContaining([
        "concurrent",
        "best-effort-causal-attribution",
        "non-deterministic-shared-state",
        "window-and-snapshot-granularity",
        "contention-observed-not-proven-safe",
        "state-change-not-isolated-to-actors",
      ]),
    );
    expect(bundle.sharedWorld.attributionLimits).not.toContain("sequential-only");
    const publicTruth = JSON.stringify({
      events: bundle.events,
      review: bundle.review,
    }).toLowerCase();
    expect(publicTruth).toContain(
      "this dry run proves nothing about live concurrency, scale, or adoption",
    );
    expect(publicTruth).toContain(
      "checks the evidence shape only, not live behavior, scale, or adopter-harness replacement",
    );
    expect(publicTruth).not.toContain("receipt");
    expect(publicTruth).not.toContain("deferred live receipt");
    expect(publicTruth).not.toContain("capability at scale");
    expect(
      bundle.streams.every((stream: { viewport?: unknown }) => stream.viewport === undefined),
    ).toBe(true);
    expect(
      bundle.streams.map(
        (stream: { desktopGeometry: { screen: { requested: unknown } } }) =>
          stream.desktopGeometry.screen.requested,
      ),
    ).toEqual([FAKE_DESKTOP_SCREEN, FAKE_DESKTOP_SCREEN, FAKE_DESKTOP_SCREEN]);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("execution.desktop.template: both the subject and every actor sandbox launch on the template; bundle records it; absent stays byte-stable", async () => {
    // With a custom template: all N+1 creates (subject + N actors) get it.
    const withState = { worldVersion: 0 };
    const withTemplate = baseSeams(withState, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3, "acme-desktop-with-runtimes"),
      dryRun: false,
      env: withTemplate.env,
      deps: withTemplate.deps,
    });
    expect(result.ok).toBe(true);
    expect(withTemplate.created).toHaveLength(4); // 1 subject + 3 actors
    expect(withTemplate.templates).toHaveLength(4);
    expect(withTemplate.templates.every((t) => t === "acme-desktop-with-runtimes")).toBe(true);
    const withBundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(withBundle.desktopTemplate).toBe("acme-desktop-with-runtimes");

    // Byte-stable default: no template → every create called with no template arg, bundle omits it.
    const noState = { worldVersion: 0 };
    const noTemplate = baseSeams(noState, makeRendezvous(3));
    const result2 = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env: noTemplate.env,
      deps: noTemplate.deps,
    });
    expect(result2.ok).toBe(true);
    expect(noTemplate.templates).toHaveLength(4);
    expect(noTemplate.templates.every((t) => t === undefined)).toBe(true);
    const noBundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result2.runId, "run.json"), "utf8"),
    );
    expect(noBundle.desktopTemplate).toBeUndefined();
  });

  it.each([
    [
      "a not-found kill error reads as already gone",
      async (sandboxId: string): Promise<boolean> => {
        throw Object.assign(new Error(`Sandbox ${sandboxId} not found`), {
          name: "SandboxNotFoundError",
        });
      },
      true,
      "Subject sandbox was already absent when cleanup ran",
    ],
    [
      "a non-boolean kill answer is not proof of release",
      async () => "ok" as unknown as boolean,
      false,
      "Subject sandbox teardown returned an unexpected result",
    ],
  ] as const)("subject teardown: %s", async (_label, subjectKill, killed, warning) => {
    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const module = await deps.desktopModule!();
    const seatKill = module.Sandbox.kill!;
    // The subject is the first sandbox created; the participants keep the ordinary kill.
    module.Sandbox.kill = async (sandboxId, options) =>
      sandboxId === "fake-sandbox-001" ? subjectKill(sandboxId) : seatKill(sandboxId, options);
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });
    expect(result.subjectSandbox).toEqual({ sandboxId: "fake-sandbox-001", killed });
    expect(result.warnings.join("\n")).toContain(warning);
    // An unconfirmed release leaves the run ok and shows in status.json with the reclaim command.
    expect(result.ok).toBe(true);
    const status = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "status.json"), "utf8"),
    );
    expect(status.outcome.ok).toBe(true);
    expect(status.outcome.execution.warnings).toEqual(
      killed
        ? undefined
        : [
            {
              kind: "sandbox-cleanup",
              message: expect.stringMatching(
                new RegExp(`^subject: ${warning}.*humanish reclaim --run ${result.runId}`),
              ),
            },
          ],
    );
  });

  it("records a participant sandbox whose release is unconfirmed as a status.json warning", async () => {
    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const module = await deps.desktopModule!();
    const kill = module.Sandbox.kill!;
    // fake-sandbox-001 is the subject; the next one is the first participant's.
    module.Sandbox.kill = async (sandboxId, options) =>
      sandboxId === "fake-sandbox-002" ? ("ok" as unknown as boolean) : kill(sandboxId, options);
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });
    expect(result.ok).toBe(true);
    const status = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "status.json"), "utf8"),
    );
    expect(status.outcome.execution.warnings).toEqual([
      {
        kind: "sandbox-cleanup",
        message: expect.stringMatching(
          new RegExp(
            `^[^:]+: Sandbox teardown returned an unexpected result.*humanish reclaim --run ${result.runId}`,
          ),
        ),
      },
    ]);
  });

  it("good run: one subject + N actors all torn down by id (killed==created, N+1), same getHost URL, real overlap, state delta, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { env, created, killed, sandboxes, deps } = baseSeams(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // One subject sandbox + 3 actor sandboxes = 4 created; all torn down by exact id (no list).
    expect(created).toHaveLength(4);
    expect(sandboxes).toHaveLength(4);
    expect(created[0]?.metadata?.kind).toBe("subject");
    expect(created[0]?.metadata?.topologyMode).toBe("concurrent");
    const createdIds = sandboxes.map((s) => s.sandboxId).sort();
    expect([...killed].sort()).toEqual(createdIds); // killed-set == created-set (N+1)
    expect(result.subjectSandbox).toEqual({ sandboxId: "fake-sandbox-001", killed: true });

    // Subject creds entered only the subject sandbox: actor creates carry no envs.
    expect(created[0]?.envs).toEqual({ DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak" });
    for (const createOpts of created.slice(1)) {
      expect(createOpts.envs).toBeUndefined();
    }

    // provisionCloneSubject ran exactly once, on the subject sandbox only (one git clone written).
    const cloneWrites = sandboxes
      .flatMap((s) => s.calls)
      .filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(1);

    // Every actor actually opened the same harness-minted getHost URL: one shared plane.
    // (The raw URL appears only in the in-memory fake's recorded calls, never in the bundle.)
    const getHostUrl = `https://3000-fake-sandbox-001.e2b.app`;
    const actorSandboxes = sandboxes.slice(1);
    expect(actorSandboxes).toHaveLength(3);
    for (const actor of actorSandboxes) {
      const opened = browserTargetFromCalls(actor.calls);
      expect(opened, "each actor opens a seat URL").toBeTruthy();
      expect(new URL(opened!).origin).toBe(new URL(getHostUrl).origin);
    }
    // The published bundle records the host as a digest (public-safe), never the raw e2b URL; the
    // raw tokenless URL is surfaced only on the ephemeral result.
    expect(result.host).toBe(getHostUrl);
    const runText = await readFile(
      path.join(cwd, ".humanish", "runs", result.runId, "run.json"),
      "utf8",
    );
    expect(runText).not.toContain("e2b.app");

    const bundle = JSON.parse(runText);
    const livePublicTruth = JSON.stringify({
      events: bundle.events,
      review: bundle.review,
    }).toLowerCase();
    expect(livePublicTruth).toContain(
      "this run reports only its own observed overlap and state changes",
    );
    expect(livePublicTruth).toContain(
      "does not prove scale, repeatability, or adopter-harness replacement",
    );
    expect(livePublicTruth).not.toContain("receipt");
    expect(bundle.simulations.map((sim: { progress: number }) => sim.progress)).toEqual([
      100, 100, 100,
    ]);
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.plane.hostDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(bundle.sharedWorld.plane.exposure).toBe("synthetic");
    for (const stream of bundle.streams) {
      expect(stream.desktopGeometry).toEqual({
        screen: {
          requested: FAKE_DESKTOP_SCREEN,
          verified: { ...FAKE_DESKTOP_SCREEN, source: "xdpyinfo" },
        },
        browserWindow: { x: 0, y: 0, ...FAKE_DESKTOP_SCREEN, source: "xwininfo" },
        viewport: { ...FAKE_DESKTOP_VIEWPORT, source: "cdp" },
      });
      expect(stream.viewport).toEqual({ ...FAKE_DESKTOP_VIEWPORT, isMobile: false });
    }

    // Proven concurrency: the laneWindows the real clock measured overlap (≥2 in flight).
    const windows = bundle.sharedWorld.laneWindows as Array<{
      startedAt: number;
      endedAt: number;
      routeHostDigest: string;
      actorType?: string;
      surface?: string;
      caseGroup?: string;
    }>;
    expect(windows).toHaveLength(3);
    expect(windows.map((w) => [w.actorType, w.surface, w.caseGroup])).toEqual([
      ["initiator", "intake", "case-001"],
      ["collaborator", "review", "case-001"],
      ["collaborator", "review", "case-001"],
    ]);
    const overlapping = windows.some((a, i) =>
      windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt),
    );
    expect(overlapping).toBe(true);
    expect(result.overlapProven).toBe(true);
    // Every actor drove exactly the harness-minted host: routeHostDigest == plane.hostDigest.
    for (const w of windows) {
      expect(w.routeHostDigest).toBe(bundle.sharedWorld.plane.hostDigest);
    }

    // A stateSeries delta occurred under load (the world changed).
    const series = bundle.sharedWorld.stateSeries as Array<{ timestamp: number; digest: string }>;
    expect(series.length).toBeGreaterThanOrEqual(2);
    expect(series.some((s, i) => i > 0 && s.digest !== series[i - 1]!.digest)).toBe(true);

    // Per-persona outcomes recorded (the "M of N" headline).
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    expect(
      (
        bundle.sharedWorld.outcomes as Array<{
          actorType?: string;
          surface?: string;
          caseGroup?: string;
        }>
      ).map((o) => [o.actorType, o.surface, o.caseGroup]),
    ).toEqual([
      ["initiator", "intake", "case-001"],
      ["collaborator", "review", "case-001"],
      ["collaborator", "review", "case-001"],
    ]);
    expect((bundle.sharedWorld.outcomes as Array<{ ok: boolean }>).every((o) => o.ok)).toBe(true);

    // verifyRun ok on the good concurrent bundle (incl. the concurrency-on-pass gate).
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);

    const observerData = JSON.parse(
      await readFile(
        path.join(cwd, ".humanish", "runs", result.runId, "observer", "observer-data.json"),
        "utf8",
      ),
    );
    expect(observerData.laneGroups).toEqual([
      expect.objectContaining({
        roleId: "persona-01",
        actorType: "initiator",
        surface: "intake",
        caseGroup: "case-001",
        status: "passed",
      }),
      expect.objectContaining({
        roleId: "persona-02",
        actorType: "collaborator",
        surface: "review",
        caseGroup: "case-001",
        status: "passed",
      }),
      expect.objectContaining({
        roleId: "persona-03",
        actorType: "collaborator",
        surface: "review",
        caseGroup: "case-001",
        status: "passed",
      }),
    ]);
    expect(
      observerData.streams.map((stream: { label: string }) => stream.label).join("\n"),
    ).toContain("type:initiator / surface:intake / case:case-001");

    // Per-actor traces written.
    const actorsDir = await readdir(path.join(cwd, ".humanish", "runs", result.runId, "actors"));
    expect(actorsDir.sort()).toEqual(["stream-001.json", "stream-002.json", "stream-003.json"]);
  });

  it("comms:email:fake: deploys the catch on the subject sandbox, injects env there only, drains to run-level evidence", async () => {
    const state = { worldVersion: 0 };
    const commsPort = 8025;
    const verificationHtml =
      '<p>Confirm.</p><a href="https://app.example.test/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({
        t: 1,
        path: "/emails",
        body: JSON.stringify({
          from: "no-reply@example.test",
          to: ["user@example.test"],
          subject: "Confirm your email",
          html: verificationHtml,
        }),
      }) + "\n";
    // The base subject handler + comms overrides (health service-marker + the teardown drain `cat`).
    const baseHandler = makeCommandHandler(state);
    const commandHandler = (command: string): { stdout?: string } | undefined => {
      // Both the loopback capture (commsPort) and the 0.0.0.0 inbox (commsPort+1) listeners are probed on
      // /health; the serve readiness probe hits `/` (no /health), so this only marks the comms listeners.
      if (command.includes("/health"))
        return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
      if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
        return { stdout: capturedNdjson };
      return baseHandler(command);
    };
    const { module, created } = makeFakeModule(commandHandler);
    const env = {
      OPENAI_API_KEY: "test-openai-key",
      E2B_API_KEY: "test-e2b-key",
      DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak",
    };
    const deps: StudyDeps = {
      desktopModule: async () => module,
      runSession: makeRunSession(state, makeRendezvous(3)),
      detachedTimers: { now: () => 0, sleep: async () => {} },
      proberCadenceMs: 100_000,
    };
    const config: StudyConfig = {
      ...concurrentConfig(3, 3),
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_API_URL",
          port: commsPort,
          recipients: [{ lane: "user", address: "user@example.test" }],
        },
      },
    };
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, env, deps });
    expect(result.ok).toBe(true);

    // The catch base-URL env is injected into the subject sandbox (created[0]) alongside DATABASE_URL:
    // and nowhere else: the actor sandboxes still carry no envs.
    expect(created[0]?.envs?.RESEND_API_URL).toBe(`http://127.0.0.1:${commsPort}`);
    expect(created[0]?.envs?.DATABASE_URL).toBe("opaque-pw-7f3a9c2e-do-not-leak");
    for (let i = 1; i < created.length; i += 1)
      expect(
        (created[i]?.envs as Record<string, string> | undefined)?.RESEND_API_URL,
      ).toBeUndefined();

    // The captured mail was drained at subject teardown + written as a run-level digest-only artifact,
    // registered once on the first stream (a property of the shared app, not any single persona).
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    const onStream0 = bundle.streams[0].artifacts.find(
      (a: { path: string; kind: string; label: string }) => a.path === "comms/thread.json",
    );
    expect(onStream0).toMatchObject({ kind: "log", label: "comms thread" });
    expect(
      bundle.streams[1]?.artifacts.find((a: { path: string }) => a.path === "comms/thread.json"),
    ).toBeUndefined();
    const threadRaw = await readFile(path.join(runDir, "comms", "thread.json"), "utf8");
    const thread = JSON.parse(threadRaw) as { schema: string; count: number };
    expect(thread.schema).toBe("humanish.comms-thread.v1");
    expect(thread.count).toBe(1);
    // Public-safety: no raw address / link / OTP / subject text in the persisted evidence.
    expect(threadRaw).not.toContain("user@example.test");
    expect(threadRaw).not.toContain("app.example.test/verify");
    expect(threadRaw).not.toContain("481920");
    expect(threadRaw).not.toContain("Confirm your email");

    // The evidence artifact does not break bundle verification.
    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("comms:email:fake: getHost-exposes the inbox, renders the live surface on the subject, and tells the matching persona its inbox URL", async () => {
    const state = { worldVersion: 0 };
    const commsPort = 8025;
    const verificationHtml =
      '<p>Confirm.</p><a href="http://127.0.0.1:3000/verify?token=abc123XYZ-9">Verify</a><p>Code: 481920</p>';
    const capturedNdjson =
      JSON.stringify({
        t: 1,
        path: "/emails",
        body: JSON.stringify({
          from: "no-reply@example.test",
          to: ["user@example.test"],
          subject: "Confirm your email",
          html: verificationHtml,
        }),
      }) + "\n";
    const baseHandler = makeCommandHandler(state);
    const commandHandler = (command: string): { stdout?: string } | undefined => {
      if (command.includes("/health"))
        return { stdout: '{"ok":true,"service":"humanish-comms-catch"}' };
      if (command.startsWith("cat ") && command.includes("deliveries.ndjson"))
        return { stdout: capturedNdjson };
      return baseHandler(command);
    };
    const { module, sandboxes } = makeFakeModule(commandHandler);
    // Capture the instructions each persona actually received.
    const seenInstructions: string[] = [];
    const baseRun = makeRunSession(state, makeRendezvous(3));
    const env = {
      OPENAI_API_KEY: "k",
      E2B_API_KEY: "k",
      DATABASE_URL: "opaque-pw-7f3a9c2e-do-not-leak",
    };
    const deps: StudyDeps = {
      desktopModule: async () => module,
      runSession: async (options) => {
        seenInstructions.push(options.instructions);
        return baseRun(options);
      },
      detachedTimers: { now: () => 0, sleep: async () => {} },
      proberCadenceMs: 100_000,
    };
    const config: StudyConfig = {
      ...concurrentConfig(3, 3),
      // The recipient's `lane` matches the first persona's participant id, so only it is told to
      // check the inbox.
      comms: {
        email: {
          kind: "fake",
          injectEnv: "RESEND_API_URL",
          port: commsPort,
          recipients: [{ lane: "persona-01", address: "user@example.test" }],
        },
      },
    };
    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, env, deps });
    expect(result.ok).toBe(true);

    // The read-only inbox listener was getHost-exposed on commsPort+1; the matching persona was told that
    // URL (a getHost host, reachable from its own (different) sandbox), not the loopback capture URL.
    const inboxHost = `https://${commsPort + 1}-${sandboxes[0]!.sandboxId}.e2b.app/inbox`;
    expect(seenInstructions.some((text) => text.includes(inboxHost))).toBe(true);
    // The full handoff rides the same injection on this route too: address + wait steering.
    expect(
      seenInstructions.some((text) => text.includes("Your email address is user@example.test")),
    ).toBe(true);
    expect(
      seenInstructions.some((text) =>
        text.includes("stop based on your situation and what you observe"),
      ),
    ).toBe(true);
    expect(seenInstructions.some((text) => text.includes(`127.0.0.1:${commsPort}`))).toBe(false); // never the capture URL

    // The live inbox surface was rendered into the subject sandbox (created first) during the run.
    expect(
      sandboxes[0]!.calls.some(
        ([name, p]) =>
          name === "files.write" && typeof p === "string" && p.endsWith("/surface/inbox/index"),
      ),
    ).toBe(true);
  });

  it("tells named and unnamed participants their own inbox, from the recipients the parser filled", async () => {
    const commsPort = 8025;
    const state = { worldVersion: 0 };
    const baseHandler = makeCommandHandler(state);
    const { module, sandboxes } = makeFakeModule((command: string) =>
      command.includes("/health")
        ? { stdout: '{"ok":true,"service":"humanish-comms-catch"}' }
        : baseHandler(command),
    );
    const seenInstructions: string[] = [];
    const baseRun = makeRunSession(state, makeRendezvous(2));
    const env = { OPENAI_API_KEY: "k", E2B_API_KEY: "k", DATABASE_URL: "opaque-pw-7f3a9c2e" };
    const deps: StudyDeps = {
      desktopModule: async () => module,
      runSession: async (options) => {
        seenInstructions.push(options.instructions);
        return baseRun(options);
      },
      detachedTimers: { now: () => 0, sleep: async () => {} },
      proberCadenceMs: 100_000,
    };
    const declared = concurrentConfig(2, 2);
    const [named, unnamed] = declared.actors[0]!.lanes!;
    const { id: _id, ...unnamedSeat } = unnamed!;
    // The second participant has no id, and email has no recipients: the parser fills one per
    // participant.
    const labWith = (email: Record<string, unknown>) =>
      parseStudyDocument({
        ...declared,
        actors: [{ ...declared.actors[0], lanes: [named, unnamedSeat] }],
        comms: { email: { kind: "fake", injectEnv: "RESEND_API_URL", port: commsPort, ...email } },
      });
    const parsed = labWith({});
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.config.comms?.email?.recipients?.map((recipient) => recipient.lane)).toEqual([
      "persona-01",
      "role-02",
    ]);
    // A recipient may name the unnamed participant by the id the route gives it.
    expect(labWith({ recipients: [{ lane: "role-02", address: "b@example.test" }] }).ok).toBe(true);

    const result = await runConcurrentSharedWorld({
      cwd,
      config: parsed.config,
      dryRun: false,
      env,
      deps,
    });
    expect(result.ok).toBe(true);

    const inboxUrl = `https://${commsPort + 1}-${sandboxes[0]!.sandboxId}.e2b.app/inbox`;
    for (const [index, recipient] of (parsed.config.comms?.email?.recipients ?? []).entries()) {
      const seat = seenInstructions.find((text) => text.includes(`Persona: persona-${index + 1}.`));
      expect(seat).toContain(inboxUrl);
      expect(seat).toContain(`Your email address is ${recipient.address}`);
    }
  });

  it("subjectPhaseSink (injected DI seam): the one shared-plane provision reports clone started/completed, then ready completed ok true, in order, off real stderr, and emits each as a subject event", async () => {
    const state = { worldVersion: 0 };
    const { env, phaseEvents, deps } = baseSeams(state, makeRendezvous(3));
    const emitted: StudyEvent[] = [];
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
      emit: (event) => {
        if (event.type === "subject-phase") emitted.push(event);
      },
    });

    expect(result.ok).toBe(true);
    expect(phaseEvents.length).toBeGreaterThan(0);
    expect(emitted).toEqual(phaseEvents.map((event) => phaseEvent(event, { kind: "subject" })));

    const cloneStartedIndex = phaseEvents.findIndex(
      (e) => e.type === "cua-lab.subject.clone.started",
    );
    const cloneCompletedIndex = phaseEvents.findIndex(
      (e) => e.type === "cua-lab.subject.clone.completed",
    );
    const readyCompletedIndex = phaseEvents.findIndex(
      (e) => e.type === "cua-lab.subject.ready.completed",
    );
    expect(cloneStartedIndex).toBeGreaterThanOrEqual(0);
    expect(cloneCompletedIndex).toBeGreaterThan(cloneStartedIndex);
    expect(readyCompletedIndex).toBeGreaterThan(cloneCompletedIndex);

    expect(phaseEvents[cloneCompletedIndex]!.ok).toBe(true);
    expect(phaseEvents[readyCompletedIndex]!.ok).toBe(true);
  });

  it("publishes an attached live Observer while concurrent actors are still running", async () => {
    const state = { worldVersion: 0 };
    const { env, sandboxes, deps } = baseSeams(state, async () => {});
    const config = concurrentConfig(3, 3);
    config.actors[0]!.mission = "Use the shared app with test-openai-key.";
    const runId = "concurrent-shared-world-live-observer";
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

    deps.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      actorSessionsStarted += 1;
      if (actorSessionsStarted >= 3) {
        resolveActorsStarted();
      }
      await actorsReleased;
      state.worldVersion += 1;
      const trace = makeTrace({
        persona: options.persona,
        status: "passed",
        completionReason: "goal_satisfied",
        actions: 1,
        messages: 1,
      });
      return { status: "passed", completionReason: "goal_satisfied", reason: trace.reason, trace };
    };

    const runPromise = runConcurrentSharedWorld({
      cwd,
      config,
      dryRun: false,
      env,
      deps,
      onObserverReady: async (observer) => {
        readyObserver = observer;
        observerServer = await serveObserver(observer, { port: 0 });
      },
      runId,
    });

    try {
      await waitForCondition("observer server", () => observerServer !== undefined);
      await actorsStarted;
      await waitForCondition("all actor sessions started", () => actorSessionsStarted === 3);
      const streamStarts = sandboxes.flatMap((sandbox) =>
        sandbox.calls.filter(([name]) => name === "stream.start"),
      );
      expect(streamStarts).toHaveLength(3);
      expect(
        streamStarts.every(
          ([, options]) => (options as { windowId?: string }).windowId === "424242",
        ),
      ).toBe(true);

      const persistedRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(
        (JSON.parse(persistedRunText) as RunBundle).streams.map((stream) => stream.assignment),
      ).toEqual([
        { mission: "Use the shared app with [REDACTED_SECRET]." },
        { mission: "Use the shared app with [REDACTED_SECRET]." },
        { mission: "Use the shared app with [REDACTED_SECRET]." },
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
        streams: Array<{ status: string }>;
        summary: { active: number };
      };
      expect(persistedObserverData.summary.active).toBe(3);
      expect(persistedObserverData.streams.map((stream) => stream.status)).toEqual([
        "running",
        "running",
        "running",
      ]);
      expect(
        persistedObserverData.events.filter((event) => event.type === "actor.running"),
      ).toHaveLength(3);

      expect(readyObserver).toBeTruthy();
      expect(observerServer).toBeTruthy();
      const served = await fetch(new URL("observer-data.json", observerServer!.url));
      const servedObserverData = (await served.json()) as {
        streams: Array<{ embed?: { kind: string; url?: string }; transport: string; url?: string }>;
      };
      expect(servedObserverData.streams).toHaveLength(3);
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
      const result = await runPromise;
      expect(result.ok).toBe(true);

      const finalObserverData = JSON.parse(
        await readFile(path.join(runRoot, "observer", "observer-data.json"), "utf8"),
      ) as {
        summary: { active: number };
        streams: Array<{ status: string }>;
      };
      expect(finalObserverData.summary.active).toBe(0);
      expect(finalObserverData.streams.map((stream) => stream.status)).toEqual([
        "passed",
        "passed",
        "passed",
      ]);
      const finalRunText = await readFile(path.join(runRoot, "run.json"), "utf8");
      expect(finalRunText).not.toContain("fake-auth-key");
      expect(finalRunText).not.toContain("stream.invalid");
    } finally {
      releaseActors();
      await observerServer?.close();
      await runPromise.catch(() => undefined);
    }
  });

  it("threads actor-default and per-participant stopWhen guards into concurrent shared-world actors", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    const actorDefault = { any: [{ id: "actor-done", textIncludes: "Saved" }] };
    const laneOverride = { any: [{ id: "second-done", urlIncludes: "/done" }] };
    config.actors[0]!.stopWhen = actorDefault;
    config.actors[0]!.lanes![1]!.stopWhen = laneOverride;

    // Keyed by participant persona, not call order: concurrent completion order is not a contract.
    const seen = new Map<string, CuaActorSessionOptions["stopWhen"]>();
    const runSession = deps.runSession!;
    deps.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      seen.set(options.persona.id, options.stopWhen);
      return runSession(options);
    };

    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, env, deps });

    expect(result.ok).toBe(true);
    expect(seen.size).toBe(3);
    expect(seen.get("persona-1")).toEqual(actorDefault);
    expect(seen.get("persona-2")).toEqual(laneOverride);
    expect(seen.get("persona-3")).toEqual(actorDefault);
  });

  it("threads actor-default and participant-level dwell windows into concurrent shared-world actors", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    const actorDefault = {
      when: { any: [{ id: "in-room", urlIncludes: "/room/" }] },
      ms: 30_000,
      everyMs: 10_000,
      then: "continue" as const,
    };
    const laneOverride = { ms: 5_000, everyMs: 1_000, then: "stop" as const };
    config.actors[0]!.dwell = actorDefault;
    config.actors[0]!.lanes![1]!.dwell = laneOverride;

    const seen = new Map<string, CuaActorSessionOptions["dwell"]>();
    const runSession = deps.runSession!;
    deps.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      seen.set(options.persona.id, options.dwell);
      return runSession(options);
    };

    const result = await runConcurrentSharedWorld({ cwd, config, dryRun: false, env, deps });

    expect(result.ok).toBe(true);
    expect(seen.size).toBe(3);
    expect(seen.get("persona-1")).toEqual(actorDefault);
    expect(seen.get("persona-2")).toEqual(laneOverride);
    expect(seen.get("persona-3")).toEqual(actorDefault);
  });

  it("adapter fail score turns a coherent concurrent shared-world run red while keeping evidence verifiable", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const scorer: BrowserScorer = {
      score: concurrentFailScore,
      deriveArtifacts: async (ctx) => {
        await mkdir(path.join(ctx.runDir, "adapter"), { recursive: true });
        await writeFile(
          path.join(ctx.runDir, "adapter", "concurrent-readback.json"),
          `${JSON.stringify(
            {
              schema: "example.concurrent-readback.v1",
              status: "review-required",
              route: ctx.route,
              participantCount: ctx.participantCount,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        return [
          {
            schema: "humanish.adapter-artifact.v1",
            namespace: CONCURRENT_ADAPTER_NAMESPACE,
            label: "Concurrent adapter readback",
            path: "adapter/concurrent-readback.json",
            kind: "state",
            note: "Adapter-owned concurrent shared-world readback.",
          },
        ];
      },
    };
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
      scorer,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");
    expect(result.overlapProven).toBe(true);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(CONCURRENT_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.adapterScore?.data?.route).toBe("shared-world");
    expect(bundle.adapterArtifacts?.[0]?.path).toBe("adapter/concurrent-readback.json");
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(
      true,
    );

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  // One judgment decides the bundle's verdict and the result's ok, and status.json repeats the
  // bundle's verdict. Participant 2 ends each way; participants 1 and 3 pass.
  it.each<[string, Parameters<typeof makeRunSession>[2], RunBundle["review"]["verdict"], boolean]>([
    ["every seat passes", undefined, "pass", true],
    [
      "a failed seat",
      (i) => (i === 1 ? { status: "failed", completionReason: "actor_error" } : undefined),
      "fail",
      false,
    ],
    [
      "a timed-out seat",
      (i) => (i === 1 ? { status: "timed_out", completionReason: "timed_out" } : undefined),
      "fail",
      false,
    ],
    [
      "a seat reporting a blocker",
      (i) =>
        i === 1
          ? { reason: "I could not complete the task; the save button was disabled." }
          : undefined,
      "fail",
      false,
    ],
    ["a hollow seat", (i) => (i === 1 ? { actions: 0, messages: 0 } : undefined), "fail", false],
    [
      "a seat whose session threw",
      (i) => (i === 1 ? { throwMessage: "synthetic provider failure" } : undefined),
      "fail",
      false,
    ],
  ])("agrees across bundle, result and status with %s", async (_name, override, verdict, ok) => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3), override);
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string; ok?: boolean };
    };
    expect(bundle.review.verdict).toBe(verdict);
    expect(status.outcome?.verdict).toBe(bundle.review.verdict);
    expect(result.ok).toBe(ok);
    expect(status.outcome?.ok).toBe(result.ok);
    expect(result.overlapProven).toBe(true);
  });

  // A shared-world pass requires what verify's shared-world check requires of one: two participants
  // live at once and, on this provisioned plane, a state change after they overlapped. Every
  // participant passes in each case below; only the world differs.
  type WorldCase = "overlap" | "no overlap" | "overlap without a state change";
  function worldSeams(world: WorldCase): { env: Record<string, string>; deps: StudyDeps } {
    const { env, deps } = baseSeams(
      { worldVersion: 0 },
      makeRendezvous(3),
      world === "overlap without a state change" ? () => ({ mutates: false }) : undefined,
    );
    // A clock that never advances gives every participant a zero-width window, so none overlap.
    return { env, deps: world === "no overlap" ? { ...deps, now: () => 1_000 } : deps };
  }
  const WORLD_CASES: Array<[WorldCase, RunBundle["review"]["verdict"], string | undefined]> = [
    ["overlap", "pass", undefined],
    ["no overlap", "fail", "No two participants were live at the same time"],
    ["overlap without a state change", "fail", "The shared state did not change"],
  ];

  it.each(WORLD_CASES)(
    "agrees across bundle, result and status with %s",
    async (world, verdict, shortfall) => {
      const result = await runConcurrentSharedWorld({
        cwd,
        config: concurrentConfig(3, 3),
        dryRun: false,
        ...worldSeams(world),
      });
      const runDir = path.join(cwd, ".humanish", "runs", result.runId);
      const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
      const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
        outcome?: { verdict?: string; ok?: boolean };
      };
      expect(bundle.review.verdict).toBe(verdict);
      expect(status.outcome?.verdict).toBe(verdict);
      expect(result.ok).toBe(verdict === "pass");
      expect(status.outcome?.ok).toBe(result.ok);
      expect(result.overlapProven).toBe(world !== "no overlap");
      expect(result.roles.every((role) => role.ok)).toBe(true);
      if (shortfall === undefined) {
        expect(result.error).toBeUndefined();
      } else {
        expect(result.error?.message).toContain(shortfall);
        expect(bundle.review.gaps).toEqual([expect.stringContaining(shortfall)]);
      }
      expect((await verifyRun(cwd, result.runId)).ok).toBe(true);
    },
  );

  // One test per world: a route run each, so each has its own timeout under load.
  it.each(WORLD_CASES.map(([world]) => world))(
    "gives a pass exactly where verify's shared-world check would accept one: %s",
    async (world) => {
      const result = await runConcurrentSharedWorld({
        cwd,
        config: concurrentConfig(3, 3),
        dryRun: false,
        ...worldSeams(world),
      });
      const bundle = JSON.parse(
        await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
      ) as RunBundle;
      // Verify's gate only reads a pass, so it is asked about the same bundle claiming one.
      const claimingPass = { ...bundle, review: { ...bundle.review, verdict: "pass" as const } };
      expect(sharedWorldEvidenceFindings(claimingPass).length === 0, world).toBe(
        bundle.review.verdict === "pass",
      );
    },
  );

  it("exits non-zero through the CLI when every participant passed but none overlapped", async () => {
    const exitCodes: Array<number | undefined> = [];
    for (const world of ["overlap", "no overlap"] as const) {
      const config = concurrentConfig(3, 3);
      const printed: string[] = [];
      let exitCode: number | undefined;
      // The lab command's path: the backend's setup, then its one runStudyWith call.
      const run = sharedWorldRouteRun({
        command: new Command(),
        io: {
          writeOut: (text) => printed.push(text),
          // The failure's error line goes to stderr; the overlap verdict is in it or in stdout.
          writeErr: (text) => printed.push(text),
          setExitCode: (code) => {
            exitCode = code;
          },
        },
        config,
        mode: "run",
        options: { cwd, dryRun: false, open: false },
      });
      if (run === undefined) throw new Error("expected the run setup to proceed");
      // runRoute takes no seams, so this is its plan-then-run step with the fakes added. Without a
      // phase sink, the phases go to the default sink and to the CLI's onEvent.
      const { env, deps } = worldSeams(world);
      const { subjectPhaseSink: _sink, ...seams } = deps;
      const prepared = await prepareStudy(config, { ...run.options, env }, seams);
      await run.present(prepared.ok ? await prepared.run() : prepared.outcome);
      exitCodes.push(exitCode);
      if (world === "no overlap") {
        expect(printed.join("")).toContain("No two participants were live at the same time");
      }
    }
    expect(exitCodes).toEqual([0, 2]);
  });

  it("fails review when a participant returns a terminal failed actor trace", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3), (index) =>
      index === 1 ? { status: "failed", completionReason: "actor_error" } : undefined,
    );
    const stderr = captureStderr();
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    }).finally(stderr.stop);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(
      "2/3 actors reached a terminal, engaged passed session",
    );

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.summary).toContain("2/3 actor sessions passed credibility checks");
    expect(bundle.review.summary).toContain("mission endpoint: 2/3 ended goal_satisfied");
    expect(bundle.review.summary).toContain(
      "completion reasons: actor_error 1/3, goal_satisfied 2/3",
    );
    expect(bundle.review.summary).not.toContain("reached their goal");
    expect(bundle.review.gaps.some((gap) => gap.includes("persona-02"))).toBe(true);
    expect(bundle.sharedWorld?.outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          roleId: "persona-02",
          status: "failed",
          completionReason: "actor_error",
          ok: false,
        }),
      ]),
    );
    await expectFailureGolden(
      "shared-world/seat-actor-error",
      path.join(cwd, ".humanish", "runs", result.runId),
      {
        result,
        stderr: stderr.text(),
        replace: [
          [result.runId, "[run]"],
          [cwd, "[cwd]"],
        ],
        // Participants tear down in parallel, so their sandbox receipts append in completion order.
        unorderedFiles: ["sandbox-receipts.ndjson"],
        // Desktop minutes are host-measured wall-clock spans of the fake sandboxes.
        maskKeys: ["minutes", "desktopMinutes"],
      },
    );
  });

  it("fails review when a participant self-reports a blocker while claiming goal_satisfied", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3), (index) =>
      index === 0
        ? {
            status: "passed",
            completionReason: "goal_satisfied",
            reason:
              "I cannot complete the approval because the app shows an error: APP_USER_ID is not set.",
          }
        : undefined,
    );
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });

    expect(result.ok).toBe(false);
    expect(result.roles[0]?.ok).toBe(false);
    expect(result.roles[0]?.error?.message).toContain("not a credible pass");

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("APP_USER_ID is not set"))).toBe(true);
    expect(
      bundle.events.some(
        (event) => event.level === "warn" && event.message.includes("does not count as a pass"),
      ),
    ).toBe(true);
  });

  it("routes through runLab to the concurrent backend", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    expect(routeOf(config)).toBe("shared-world");
    const outcome = await runStudyWith(config, { cwd, dryRun: false, env }, deps);
    expect(outcome.route).toBe("shared-world");
    if (outcome.route !== "shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });

  it("a participant without its own persona takes actors[0].persona, as independent participants do", async () => {
    const state = { worldVersion: 0 };
    const seen: Array<{ persona: string; instructions: string }> = [];
    const baseRun = makeRunSession(state, makeRendezvous(3));
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    config.actors[0]!.persona = "careful-reviewer";
    delete config.actors[0]!.lanes![1]!.persona;
    const result = await runConcurrentSharedWorld({
      cwd,
      config,
      dryRun: false,
      env,
      deps: {
        ...deps,
        runSession: async (options) => {
          seen.push({ persona: options.persona.id, instructions: options.instructions });
          return baseRun(options);
        },
      },
    });
    expect(result.ok).toBe(true);
    const personas = seen.map((entry) => entry.persona).sort();
    expect(personas).toEqual(["careful-reviewer", "persona-1", "persona-3"]);
    expect(seen.find((entry) => entry.persona === "careful-reviewer")?.instructions).toContain(
      "Persona: careful-reviewer.",
    );
  });

  it("runs a direct library config that omits concurrency, as the parser would fill it", async () => {
    // Library callers can skip parseStudy, so the route must default concurrency to the
    // participant count itself instead of treating the omission as the removed value 1.
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const config = concurrentConfig(3, 3);
    delete config.execution!.concurrency;
    expect(sharedWorldValidationReason(config)).toBeNull();
    const outcome = await runStudyWith(config, { cwd, dryRun: false, env }, deps);
    expect(outcome.route).toBe("shared-world");
    expect(outcome.result.ok).toBe(true);
  });

  it("the exported shared-world validator refuses what the route refuses", () => {
    const sequential = concurrentConfig(3, 3);
    sequential.execution!.concurrency = 1;
    expect(sharedWorldValidationReason(sequential)).toContain("at least 2 (got 1)");
    const unattested = concurrentConfig(3, 3);
    delete unattested.subject.exposure;
    expect(sharedWorldValidationReason(unattested)).toContain("exposure: synthetic");
  });

  it("independent actors: one actor's harness error does not block the swarm or suppress overlap", async () => {
    const state = { worldVersion: 0 };
    // Actor index 1 throws after entering the rendezvous (so all 3 windows still overlap).
    const { env, deps } = baseSeams(state, makeRendezvous(3), (index) =>
      index === 1 ? { throwMessage: "boom in actor 1" } : undefined,
    );
    const stderr = captureStderr();
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    }).finally(stderr.stop);

    // The swarm did not run fully coherently → ok false, but the other actors still ran (no gate).
    expect(result.ok).toBe(false);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    // All 3 windows + outcomes intact (no pipeline-gate / fail-fast corrupting the "M of N").
    expect(bundle.sharedWorld.laneWindows).toHaveLength(3);
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    const windows = bundle.sharedWorld.laneWindows as Array<{ startedAt: number; endedAt: number }>;
    expect(
      windows.some((a, i) =>
        windows.some((b, j) => i !== j && a.startedAt < b.endedAt && b.startedAt < a.endedAt),
      ),
    ).toBe(true);
    // 2 of 3 sessions passed the credibility checks; the failed one is recorded as data, not a
    // swarm-blocker. Mission and convergence claims remain separate in the review summary.
    const okCount = (bundle.sharedWorld.outcomes as Array<{ ok: boolean }>).filter(
      (o) => o.ok,
    ).length;
    expect(okCount).toBe(2);
    await expectFailureGolden(
      "shared-world/seat-harness-error",
      path.join(cwd, ".humanish", "runs", result.runId),
      {
        result,
        stderr: stderr.text(),
        replace: [
          [result.runId, "[run]"],
          [cwd, "[cwd]"],
        ],
        // Participants tear down in parallel, so their sandbox receipts append in completion order.
        unorderedFiles: ["sandbox-receipts.ndjson"],
        // Desktop minutes are host-measured wall-clock spans of the fake sandboxes.
        maskKeys: ["minutes", "desktopMinutes"],
      },
    );
  });

  it("literal-scrubs a provisioned value injected into a forced error before persist", async () => {
    const state = { worldVersion: 0 };
    const secret = "opaque-pw-7f3a9c2e-do-not-leak";
    const { env, deps } = baseSeams(state, makeRendezvous(3), (index) =>
      index === 0 ? { throwMessage: `connection failed using ${secret}` } : undefined,
    );
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });
    expect(result.ok).toBe(false);
    for (const file of ["run.json", "review.json", "review.md", "events.ndjson"]) {
      const text = await readFile(path.join(cwd, ".humanish", "runs", result.runId, file), "utf8");
      expect(text, file).not.toContain(secret);
    }
  });
});

// The same concurrent shared-world composition, but driven from the operator's own packed working
// tree (subject.source: local-tree) instead of a clone - the follow-up to the local-tree keystone
// that wires provisionLocalTreeSubject into the one subject sandbox. The N
// actor desktops still drive the getHost URL exactly as today - only the subject's provisioning +
// provenance source changes.
describe("runConcurrentSharedWorld (local-tree route: subject.source: local-tree)", () => {
  // 64-hex archiveSha256 and a 40-hex commit: shape-valid fixtures, not real digests.
  const FIXED_ARCHIVE: LocalTreeArchive = {
    archivePath: "/unused-in-fake/source.tar.gz",
    archiveSha256: "ef".repeat(32),
    fileCount: 5,
    totalBytes: 99,
    git: { commit: "12".repeat(20), dirty: false },
  };
  const FAKE_ARCHIVE_BYTES = new TextEncoder().encode("fake-packed-archive-bytes").buffer;

  function localTreeConcurrentConfig(roleCount = 3, concurrency = 3): StudyConfig {
    const lanes = Array.from({ length: roleCount }, (_unused, i) => ({
      id: `persona-${String(i + 1).padStart(2, "0")}`,
      persona: `persona-${i + 1}`,
      entry: `/seat-${i + 1}`,
    }));
    const parsed = parseStudyDocument({
      schema: V2_SCHEMA,
      id: "concurrent-shared-world-local-tree-proof",
      title: "Concurrent shared-world local-tree proof",
      subject: {
        source: "local-tree",
        topology: "shared-world",
        exposure: "synthetic",
        env: ["DATABASE_URL"],
        serve: {
          install: "pnpm install",
          start: "pnpm start -H 0.0.0.0",
          url: "http://127.0.0.1:3000/",
        },
        state: {
          seed: [{ name: "migrate", command: "pnpm db:migrate" }],
          checkpoint: [
            { name: "notes-count", command: "psql query notes" },
            { name: "reviews-count", command: "psql query reviews" },
          ],
        },
      },
      actors: [{ type: "openai-computer-use", mission: "Use the shared app.", lanes }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, concurrency },
      scenario: { mode: "live" },
    });
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  it("dry-run: subject.source local-tree, no archiveSha256, verified concurrent contract bundle", async () => {
    const result = await runConcurrentSharedWorld({
      cwd,
      config: localTreeConcurrentConfig(),
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.subjectSandbox).toBeUndefined();
    expect(result.subject?.source).toBe("local-tree");
    expect(result.subject && "archiveSha256" in result.subject).toBe(false);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });

  it("good run: packs once, uploads to the subject sandbox only, extracts, provisions via provisionLocalTreeSubject; provenance carries archiveSha256 + commit + dirty; N actors unaffected; verify ok", async () => {
    const state = { worldVersion: 0 };
    const { env, created, killed, sandboxes, deps } = baseSeams(state, makeRendezvous(3));
    const packCalls: Array<{ root: string }> = [];
    deps.packLocalTree = async (args) => {
      packCalls.push(args);
      return { archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES };
    };
    const result = await runConcurrentSharedWorld({
      cwd,
      config: localTreeConcurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // Packed exactly once, before any (subject or actor) sandbox is created.
    expect(packCalls).toHaveLength(1);
    expect(packCalls[0]?.root).toBe(cwd);

    // One subject sandbox + 3 actor sandboxes = 4 created; all torn down by exact id.
    expect(created).toHaveLength(4);
    const createdIds = sandboxes.map((s) => s.sandboxId).sort();
    expect([...killed].sort()).toEqual(createdIds);

    // The archive uploaded only to the subject sandbox (sandboxes[0]), never any actor sandbox.
    const subjectUploads = sandboxes[0]!.calls.filter(
      (call): call is [string, string, ArrayBuffer] =>
        call[0] === "files.write" && call[1] === "/home/user/.humanish-source.tar.gz",
    );
    expect(subjectUploads).toHaveLength(1);
    expect(subjectUploads[0]?.[2]).toBe(FAKE_ARCHIVE_BYTES);
    for (const actorSandbox of sandboxes.slice(1)) {
      const actorUploads = actorSandbox.calls.filter(
        (call) => call[0] === "files.write" && call[1] === "/home/user/.humanish-source.tar.gz",
      );
      expect(actorUploads).toHaveLength(0);
    }

    // The local-tree route never runs git: no clone script written on any sandbox.
    const cloneWrites = sandboxes
      .flatMap((s) => s.calls)
      .filter(([name, , data]) => name === "files.write" && String(data).includes("git clone"));
    expect(cloneWrites).toHaveLength(0);

    // Provenance: source local-tree + archiveSha256 (the pin - one archive, no per-participant
    // unanimity math needed) + commit/dirty from the host-packed archive; no repo/publicRepo for
    // local-tree.
    const expectedSubject = {
      source: "local-tree",
      archiveSha256: FIXED_ARCHIVE.archiveSha256,
      commit: FIXED_ARCHIVE.git!.commit,
      dirty: false,
      envNames: ["DATABASE_URL"],
      state: {
        provenance: "seeded",
        seed: [
          {
            name: "migrate",
            when: "before-start",
            commandDigest: expect.any(String),
            ok: true,
            exitCode: 0,
            durationMs: expect.any(Number),
          },
        ],
      },
    };
    expect(result.subject).toEqual(expectedSubject);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.subject).toEqual(expectedSubject);
    expect(bundle.sharedWorld.plane.commit).toBe(FIXED_ARCHIVE.git!.commit);
    // The concurrency-on-pass gate still holds on the local-tree route (real overlap + a state delta).
    expect(result.overlapProven).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("subjectPhaseSink: the one subject sandbox's provision reports upload/extract (never clone), then install/ready, in order", async () => {
    const state = { worldVersion: 0 };
    const { env, phaseEvents, deps } = baseSeams(state, makeRendezvous(3));
    deps.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    const result = await runConcurrentSharedWorld({
      cwd,
      config: localTreeConcurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });

    expect(result.ok).toBe(true);
    const uploadStarted = phaseEvents.findIndex((e) => e.type === "cua-lab.subject.upload.started");
    const extractCompleted = phaseEvents.findIndex(
      (e) => e.type === "cua-lab.subject.extract.completed",
    );
    const readyCompleted = phaseEvents.findIndex(
      (e) => e.type === "cua-lab.subject.ready.completed",
    );
    expect(uploadStarted).toBeGreaterThanOrEqual(0);
    expect(extractCompleted).toBeGreaterThan(uploadStarted);
    expect(readyCompleted).toBeGreaterThan(extractCompleted);
    expect(phaseEvents.some((e) => e.type.includes(".clone."))).toBe(false);
  });

  it("packing failure (hook throws) fails the run closed before any sandbox (subject or actor) is created", async () => {
    const state = { worldVersion: 0 };
    const { env, created, deps } = baseSeams(state, makeRendezvous(3));
    deps.packLocalTree = async () => {
      throw new Error(
        "Local tree root produced zero packable entries after the always-on denylist.",
      );
    };
    const analysis = automaticAnalysisBoundary();
    const result = await runConcurrentSharedWorld({
      cwd,
      config: localTreeConcurrentConfig(3, 3),
      dryRun: false,
      env,
      deps: { ...deps, analysis: { run: analysis } },
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_FAILED");
    expect(result.error?.message).toContain("zero packable entries");
    expect(created).toHaveLength(0);
    // Packing runs before the run starts: no run directory, no run id, and a refusal is never
    // analyzed.
    expect(analysis).not.toHaveBeenCalled();
    expect(result.runId).toBe("not-created");
    expect(await readdir(path.join(cwd, ".humanish", "runs")).catch(() => [])).toEqual([]);
  });

  it("engine re-enforcement (library API surface, bypassing the parser): a local-tree config missing subject.serve fails closed", async () => {
    const valid = localTreeConcurrentConfig();
    const subjectWithoutServe: Record<string, unknown> = { ...valid.subject };
    delete subjectWithoutServe.serve;
    const broken = { ...valid, subject: subjectWithoutServe } as unknown as StudyConfig;
    const result = await runConcurrentSharedWorld({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(result.error?.message).toContain("subject.serve");
  });

  it("engine re-enforcement rejects path-shaped role ids before loading a desktop", async () => {
    const valid = concurrentConfig(3, 3);
    const actor = valid.actors[0]!;
    const lanes = actor.lanes!.map((lane, index) =>
      index === 0 ? { ...lane, id: "..\\escape" } : lane,
    );
    const broken: StudyConfig = { ...valid, actors: [{ ...actor, lanes }] };
    let desktopLoads = 0;
    const result = await runConcurrentSharedWorld({
      cwd,
      config: broken,
      dryRun: false,
      deps: {
        desktopModule: async () => {
          desktopLoads += 1;
          throw new Error("must not load");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(result.runId).toBe("not-created");
    expect(desktopLoads).toBe(0);
  });

  it("engine re-enforcement refuses a positive scenario.caps.maxTotalUsd before loading a desktop", async () => {
    const valid = concurrentConfig(3, 3);
    const broken: StudyConfig = {
      ...valid,
      scenario: { ...valid.scenario, caps: { maxTotalUsd: 5 } },
    };
    let desktopLoads = 0;
    const result = await runConcurrentSharedWorld({
      cwd,
      config: broken,
      dryRun: false,
      deps: {
        desktopModule: async () => {
          desktopLoads += 1;
          throw new Error("must not load");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(result.error?.message).toContain("execution.caps.maxTotalUsd");
    expect(desktopLoads).toBe(0);
  });

  it("engine re-enforcement: a local-tree config declaring subject.localTree.keep on the concurrent route fails closed (would orphan the N actor sandboxes)", async () => {
    const valid = localTreeConcurrentConfig();
    const broken: StudyConfig = {
      ...valid,
      subject: { ...valid.subject, localTree: { keep: true } },
    };
    const result = await runConcurrentSharedWorld({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
    expect(result.error?.message).toContain("subject.localTree.keep");
  });

  it("engine re-enforcement: a local-tree config with a non-e2b-desktop execution.target fails closed", async () => {
    const valid = localTreeConcurrentConfig();
    const broken = {
      ...valid,
      execution: { ...valid.execution, target: "local" },
    } as unknown as StudyConfig;
    const result = await runConcurrentSharedWorld({ cwd, config: broken, dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("HUMANISH_SHARED_WORLD_INVALID");
  });

  it("routes through runLab to the concurrent-shared-world backend", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    deps.packLocalTree = async () => ({ archive: FIXED_ARCHIVE, buffer: FAKE_ARCHIVE_BYTES });
    const config = localTreeConcurrentConfig(3, 3);
    expect(routeOf(config)).toBe("shared-world");
    const outcome = await runStudyWith(config, { cwd, dryRun: false, env }, deps);
    expect(outcome.route).toBe("shared-world");
    if (outcome.route !== "shared-world") return;
    expect(outcome.result.ok).toBe(true);
  });
});

type BundleMutation = (bundle: Record<string, unknown>) => void;

const concurrentOverclaims: ReadonlyArray<readonly [string, BundleMutation]> = [
  [
    "(a) a 'concurrent' bundle whose laneWindows do NOT overlap",
    (bundle) => {
      const sw = bundle.sharedWorld as {
        laneWindows: Array<{ startedAt: number; endedAt: number }>;
      };
      sw.laneWindows.forEach((w, i) => {
        w.startedAt = i * 1000;
        w.endedAt = i * 1000 + 10;
      }); // sequential, no overlap
    },
  ],
  [
    "(b) missing best-effort-causal-attribution",
    (bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = sw.attributionLimits.filter(
        (l) => l !== "best-effort-causal-attribution",
      );
    },
  ],
  [
    "(b2) a FORBIDDEN limit present (sequential-only)",
    (bundle) => {
      const sw = bundle.sharedWorld as { attributionLimits: string[] };
      sw.attributionLimits = [...sw.attributionLimits, "sequential-only"];
    },
  ],
  [
    "(c) a value-shaped stateSeries field (allowed-keys tripwire)",
    (bundle) => {
      const sw = bundle.sharedWorld as { stateSeries: Array<Record<string, unknown>> };
      sw.stateSeries[0]!.rawCount = "42"; // a non-allowed field; the series is digest-only
    },
  ],
  [
    "(d) divergent plane provenance across laneWindows",
    (bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<Record<string, unknown>> };
      sw.laneWindows[0]!.commit = "deadbeefdeadbeef0000";
    },
  ],
  [
    "(e) a PASSED run with no stateSeries delta",
    (bundle) => {
      const sw = bundle.sharedWorld as { stateSeries: Array<{ digest: string }> };
      const d = sw.stateSeries[0]!.digest;
      for (const s of sw.stateSeries) s.digest = d; // flatten → no delta
    },
  ],
  [
    "(f) a persona with goal_satisfied + zero engagement",
    (bundle) => {
      const streams = bundle.streams as Array<{
        actor?: { completionReason?: string; counts?: Record<string, number>; items?: unknown[] };
      }>;
      const stream = streams.find((s) => s.actor)!;
      stream.actor!.completionReason = "goal_satisfied";
      stream.actor!.counts = { actions: 0, messages: 0, screenshots: 0 };
      stream.actor!.items = [];
    },
  ],
  [
    "(g) the topologyMode discriminator is enforced (sequential timeline smuggled onto a concurrent bundle)",
    (bundle) => {
      const sw = bundle.sharedWorld as Record<string, unknown>;
      sw.timeline = [
        {
          kind: "checkpoint",
          name: "cp-baseline",
          digest: "abc123def4567890",
          deltaFromPrev: false,
        },
      ];
    },
  ],
  [
    "(h) an actor that drove a host OTHER than the harness-minted plane (FIX-2 / invariant 2)",
    (bundle) => {
      const sw = bundle.sharedWorld as { laneWindows: Array<{ routeHostDigest: string }> };
      sw.laneWindows[0]!.routeHostDigest = "ffffffffffffffff"; // a different host than plane.hostDigest
    },
  ],
];

async function goodConcurrentRun(
  laneOverride?: Parameters<typeof baseSeams>[2],
  project = cwd,
): Promise<{ runId: string; bundlePath: string; ok: boolean }> {
  const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3), laneOverride);
  const result = await runConcurrentSharedWorld({
    cwd: project,
    config: concurrentConfig(3, 3),
    dryRun: false,
    env,
    deps,
  });
  return {
    runId: result.runId,
    bundlePath: path.join(project, ".humanish", "runs", result.runId, "run.json"),
    ok: result.ok,
  };
}

describe("verifyRun fails closed on each injected concurrent overclaim", () => {
  async function mutateAndVerify(mutate: BundleMutation): Promise<boolean> {
    const { runId, bundlePath, ok } = await goodConcurrentRun();
    expect(ok).toBe(true);
    const baseline = await verifyRun(cwd, runId);
    expect(baseline.ok).toBe(true); // the un-mutated bundle must verify (so a failure is attributable)
    const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
    mutate(bundle);
    await writeFile(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    return (await verifyRun(cwd, runId)).ok;
  }

  it.each(concurrentOverclaims)("%s", async (_name, mutate) => {
    expect(await mutateAndVerify(mutate)).toBe(false);
  });
});

describe("concurrent shared-world verify findings golden", () => {
  // The golden pins verify's failing checks for the good run, each variant and each failing
  // participant. Each case is its own test with its own timeout: run as one test, these timed out
  // at the 20 s default at load 26-78. The variants share one good run in its own project, made by
  // the first test that needs it, because the file's per-test cwd is removed after each test. The
  // last test asserts the golden in this order, so it needs every case to have run.
  let shared:
    | Promise<{ project: string; runId: string; bundlePath: string; original: string }>
    | undefined;
  const goodRun = () =>
    (shared ??= (async () => {
      const project = await mkdtemp(path.join(tmpdir(), "humanish-concurrent-golden-"));
      const run = await goodConcurrentRun(undefined, project);
      return { project, ...run, original: await readFile(run.bundlePath, "utf8") };
    })());
  afterAll(async () => {
    const good = await shared?.catch(() => undefined);
    if (good) await rm(good.project, { recursive: true, force: true });
  });
  const variants = [...concurrentOverclaims, ...LANE_SHAPE_VARIANTS];
  const failingLanes: ReadonlyArray<readonly [string, Parameters<typeof baseSeams>[2]]> = [
    [
      "lane 1 returns a terminal failed actor trace",
      (index) => (index === 1 ? { status: "failed", completionReason: "actor_error" } : undefined),
    ],
    [
      "lane 1 throws a harness error",
      (index) => (index === 1 ? { throwMessage: "boom in actor 1" } : undefined),
    ],
  ];
  const order = [
    "good run",
    ...variants.map(([name]) => name),
    "every variant at once",
    ...failingLanes.map(([name]) => name),
  ];
  const pinned = new Map<string, PinnedVerifyResult>();
  async function pinBundle(name: string, text: string): Promise<PinnedVerifyResult> {
    const good = await goodRun();
    await writeFile(good.bundlePath, text, "utf8");
    const result = await pinnedVerifyResult(good.project, good.runId);
    pinned.set(name, result);
    return result;
  }
  const bundleText = (bundle: Record<string, unknown>) => `${JSON.stringify(bundle, null, 2)}\n`;

  it("pins verify for the good run", async () => {
    expect((await pinBundle("good run", (await goodRun()).original)).ok).toBe(true);
  });

  it.each(variants)("pins verify's failing checks for %s", async (name, mutate) => {
    const bundle = JSON.parse((await goodRun()).original) as Record<string, unknown>;
    mutate(bundle);
    expect((await pinBundle(name, bundleText(bundle))).ok).toBe(false);
  });

  it("pins verify's failing checks for every variant at once", async () => {
    // Several invariants fail at once, so the golden also pins the order across them.
    const combined = JSON.parse((await goodRun()).original) as Record<string, unknown>;
    for (const [, mutate] of variants) mutate(combined);
    expect((await pinBundle("every variant at once", bundleText(combined))).ok).toBe(false);
  });

  it.each(failingLanes)("pins verify's failing checks when %s", async (name, laneOverride) => {
    const run = await goodConcurrentRun(laneOverride);
    const result = await pinnedVerifyResult(cwd, run.runId);
    pinned.set(name, result);
    // A run that recorded its failure still verifies: the golden pins that it reports no failing
    // check.
    expect(result.ok).toBe(true);
  });

  it("matches the golden for every case", async () => {
    expect([...pinned.keys()].sort()).toEqual([...order].sort());
    await expect(
      verifyGolden(order.map((name) => [name, pinned.get(name)!] as const)),
    ).toMatchFileSnapshot("../../golden/verify/shared-world-concurrent.json");
  });
});

describe("concurrent physical geometry guard", () => {
  it("starts no participant on clipped desktops and reclaims the host plus every actor desktop", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, async () => undefined);
    const handler = makeCommandHandler(state);
    const { module, sandboxes, killed } = makeFakeModule(
      (command) =>
        command.includes("xwininfo -id")
          ? {
              stdout:
                "Absolute upper-left X: 0\nAbsolute upper-left Y: 32\nWidth: 1440\nHeight: 950\nMap State: IsViewable\n",
            }
          : handler(command),
      false,
    );
    let participantSessions = 0;
    deps.desktopModule = async () => module;
    deps.runSession = async () => {
      participantSessions++;
      throw new Error("participant must not start");
    };
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(2, 2),
      dryRun: false,
      env,
      deps,
    });
    expect(result.ok).toBe(false);
    expect(participantSessions).toBe(0);
    expect(sandboxes).toHaveLength(3);
    expect(killed.sort()).toEqual(sandboxes.map((sandbox) => sandbox.sandboxId).sort());
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    for (const stream of bundle.streams) {
      expect(stream.desktopGeometry.warnings.join(" ")).toContain("outside the captured");
    }
  });
});

describe("committed live-fixture lab (deterministic $0 wiring proof)", () => {
  function loadLiveLab(): StudyConfig {
    const raw = parse(
      readFileSync(
        path.join(process.cwd(), "humanish/studies/shared-world-concurrent-live.yaml"),
        "utf8",
      ),
    );
    const parsed = parseStudyDocument(raw);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.config;
  }

  it("is well-formed: parses, routes to concurrent, and passes the synthetic/seeded/0.0.0.0 validations", () => {
    const config = loadLiveLab();
    expect(isSharedWorldComposition(config)).toBe(true);
    expect(routeOf(config)).toBe("shared-world");
    expect(concurrentSharedWorldValidationReason(config)).toBeNull();
    expect(config.subject.exposure).toBe("synthetic");
    expect(config.subject.serve?.start).toContain("0.0.0.0");
    expect(config.subject.serve?.start).toContain("humanish/fixtures/shared-world-app/server.py");
    expect(config.subject.repos).toEqual(["danielgwilson/humanish"]);
    expect((config.subject.state?.seed ?? []).length).toBeGreaterThan(0);
    expect((config.subject.state?.checkpoint ?? []).length).toBeGreaterThan(0);
    expect(config.actors[0]?.lanes).toHaveLength(3);
    expect(
      config.actors[0]?.lanes?.map((lane) => [lane.actorType, lane.surface, lane.caseGroup]),
    ).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"],
    ]);
    expect(config.execution?.concurrency).toBe(3);
  });

  it("dry-runs this exact committed config to a verified concurrent shared-world bundle at $0", async () => {
    const outcome = await runStudyWith(loadLiveLab(), { cwd, dryRun: true });
    expect(outcome.route).toBe("shared-world");
    if (outcome.route !== "shared-world") return;
    expect(outcome.result.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", outcome.result.runId, "run.json"), "utf8"),
    );
    expect(bundle.attributionClass).toBe("shared-world");
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(
      bundle.sharedWorld.laneWindows.map(
        (lane: { actorType?: string; surface?: string; caseGroup?: string }) => [
          lane.actorType,
          lane.surface,
          lane.caseGroup,
        ],
      ),
    ).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"],
    ]);
    const observerData = JSON.parse(
      await readFile(
        path.join(cwd, ".humanish", "runs", outcome.result.runId, "observer", "observer-data.json"),
        "utf8",
      ),
    );
    expect(
      observerData.laneGroups.map(
        (lane: { actorType?: string; surface?: string; caseGroup?: string }) => [
          lane.actorType,
          lane.surface,
          lane.caseGroup,
        ],
      ),
    ).toEqual([
      ["planner", "task-board", "board-001"],
      ["coordinator", "task-board", "board-001"],
      ["contributor", "task-board", "board-001"],
    ]);
    const verify = await verifyRun(cwd, outcome.result.runId);
    expect(verify.ok).toBe(true);
    expect(verify.checks.find((c) => c.name === "shared-world evidence")?.ok).toBe(true);
  });

  it("drives this exact committed config through the real orchestrator on a fake N+1 substrate ($0): one plane, real overlap, a state delta, verify ok", async () => {
    const state = { worldVersion: 0 };
    const { env, created, killed, sandboxes, deps } = baseSeams(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({
      cwd,
      config: loadLiveLab(),
      dryRun: false,
      env,
      deps,
    });

    expect(result.ok).toBe(true);
    // One subject sandbox + 3 actor sandboxes, all torn down by id (N+1).
    expect(created).toHaveLength(4);
    expect([...killed].sort()).toEqual(sandboxes.map((s) => s.sandboxId).sort());
    expect(result.subjectSandbox?.killed).toBe(true);
    expect(result.overlapProven).toBe(true);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.sharedWorld.topologyMode).toBe("concurrent");
    expect(bundle.sharedWorld.outcomes).toHaveLength(3);
    const series = bundle.sharedWorld.stateSeries as Array<{ digest: string }>;
    expect(series.some((s, i) => i > 0 && s.digest !== series[i - 1]!.digest)).toBe(true);

    const verify = await verifyRun(cwd, result.runId);
    expect(verify.ok).toBe(true);
  });
});

describe("lobby-code handoff relays (CDP-independent: narration + vision-off-frame)", () => {
  it("extractLobbyCodeFromNarration reads a /lobby/CODE or a labeled uppercase code, never lowercase prose", () => {
    expect(
      extractLobbyCodeFromNarration(
        "I'm in! The link is https://lobby-trivia.example.test/en/lobby/UDYCPH now.",
      ),
    ).toBe("UDYCPH");
    expect(extractLobbyCodeFromNarration("lobby code: MHDTP2")).toBe("MHDTP2");
    expect(extractLobbyCodeFromNarration("LOBBY_CODE=AB8K9Q done")).toBe("AB8K9Q");
    // A wrong latch fails the whole run: ordinary lowercase words after "lobby code" must not latch,
    // even though the label match is case-insensitive (the /i flag must not grab them).
    expect(
      extractLobbyCodeFromNarration("I clicked the lobby code screen to check"),
    ).toBeUndefined();
    expect(extractLobbyCodeFromNarration("the lobby code button was there")).toBeUndefined();
    expect(extractLobbyCodeFromNarration("no code here")).toBeUndefined();
    expect(extractLobbyCodeFromNarration(undefined)).toBeUndefined();
  });

  it("parseLobbyCodeReply is precision-first: only a bare code or an echoed /lobby/CODE, never prose", () => {
    expect(parseLobbyCodeReply("UDYCPH")).toBe("UDYCPH");
    expect(parseLobbyCodeReply("  mhdtp2 ")).toBe("MHDTP2");
    expect(parseLobbyCodeReply("/lobby/QW3RTY")).toBe("QW3RTY");
    expect(parseLobbyCodeReply("https://lobby-trivia.example.test/en/lobby/QW3RTY?x=1")).toBe(
      "QW3RTY",
    );
    // A wrong latch fails the whole run, so these must not match: a miss just retries next frame.
    expect(parseLobbyCodeReply("The code is ABC234")).toBeUndefined();
    expect(parseLobbyCodeReply("I see a home SCREEN")).toBeUndefined();
    expect(parseLobbyCodeReply("NONE")).toBeUndefined();
    expect(parseLobbyCodeReply("No lobby code visible: NONE")).toBeUndefined();
    expect(parseLobbyCodeReply("")).toBeUndefined();
    expect(parseLobbyCodeReply(undefined)).toBeUndefined();
  });

  it("extractResponsesOutputText handles the output_text convenience field and the output[] array", () => {
    expect(extractResponsesOutputText({ output_text: "AB8K9Q" })).toBe("AB8K9Q");
    expect(
      extractResponsesOutputText({
        output: [{ type: "message", content: [{ type: "output_text", text: "ZZ4T5U" }] }],
      }),
    ).toBe("ZZ4T5U");
    expect(extractResponsesOutputText({})).toBeUndefined();
    expect(extractResponsesOutputText(null)).toBeUndefined();
  });

  it("readLobbyCodeFromFrame POSTs the frame and returns the parsed code; fail-soft on non-ok / bad key", async () => {
    const frame = Buffer.from("fake-png-bytes");
    const calls: Array<{ url: string; body: string; signal: unknown }> = [];
    const okFetch = (async (url: string, init: { body: string; signal: unknown }) => {
      calls.push({ url, body: init.body, signal: init.signal });
      return {
        ok: true,
        status: 200,
        json: async () => ({ output_text: "QW3RTY" }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const code = await readLobbyCodeFromFrame(frame, "sk-test", { fetchFn: okFetch });
    expect(code).toBe("QW3RTY");
    expect(calls).toHaveLength(1);
    // The frame is sent as a base64 data URL (same shape the computer-use provider already uses); key never in body.
    expect(calls[0]!.body).toContain("data:image/png;base64,");
    expect(calls[0]!.body).not.toContain("sk-test");
    // A timeout signal is always attached even when the caller passes none, so a stalled request cannot
    // wedge the caller's in-flight guard.
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);

    const notOk = (async () =>
      ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }) as unknown as Response) as unknown as typeof fetch;
    expect(await readLobbyCodeFromFrame(frame, "sk-test", { fetchFn: notOk })).toBeUndefined();

    const threw = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await readLobbyCodeFromFrame(frame, "sk-test", { fetchFn: threw })).toBeUndefined();

    // No key / empty frame => no network call at all.
    let called = false;
    const spy = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    expect(await readLobbyCodeFromFrame(frame, "", { fetchFn: spy })).toBeUndefined();
    expect(
      await readLobbyCodeFromFrame(Buffer.alloc(0), "sk-test", { fetchFn: spy }),
    ).toBeUndefined();
    expect(called).toBe(false);
  });
});

// Exercise the actual first-party provider route: a custom runSession would bypass the
// output-limit contract. The response is a retained wire fixture; no network or paid compute.
it("routes actor output limits and per-participant reasoning to concurrent provider requests", async () => {
  const config = concurrentConfig();
  // Below the first request's own 1024 cap, so the first request carries the declared value.
  config.actors[0]!.maxOutputTokens = 512;
  config.actors[0]!.reasoningEffort = "low";
  config.actors[0]!.lanes![1]!.reasoningEffort = "high";
  const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
  delete deps.runSession;
  const prepareDesktop = async (desktop: E2BDesktopSandbox): Promise<void> => {
    desktop.screenshot = async () =>
      new Uint8Array(PNG.sync.write(new PNG({ width: 4, height: 4 })));
  };
  deps.readLobbyCodeFromFrame = async () => "AB2CD9";
  const captured = JSON.parse(
    readFileSync(
      new URL("../../fixtures/openai-closing-report/typed-closing-report.json", import.meta.url),
      "utf8",
    ),
  );
  const bodies: Array<{ max_output_tokens?: number; reasoning?: { effort?: string } }> = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => captured,
      text: async () => JSON.stringify(captured),
    };
  });
  try {
    const result = await runConcurrentSharedWorld({
      cwd,
      config,
      dryRun: false,
      env,
      prepareDesktop,
      deps,
    });
    expect(bodies).toHaveLength(3);
    expect(bodies.map((body) => body.max_output_tokens)).toEqual([512, 512, 512]);
    expect(bodies.map((body) => body.reasoning?.effort).sort()).toEqual(["high", "low", "low"]);
    expect(result.roles).toHaveLength(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("concurrent shared-world run cost", () => {
  it("prices every participant's model tokens and desktop plus the subject desktop, and stats reads it", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const inner = await deps.desktopModule!();
    const sized: E2BDesktopModule = {
      ...inner,
      Sandbox: {
        ...inner.Sandbox,
        create: async (
          templateOrOptions: string | E2BDesktopCreateOptions,
          maybeOptions?: E2BDesktopCreateOptions,
        ) => {
          const sandbox =
            typeof templateOrOptions === "string"
              ? await inner.Sandbox.create(templateOrOptions, maybeOptions!)
              : await inner.Sandbox.create(templateOrOptions);
          return Object.assign(sandbox, {
            getInfo: async () => ({ cpuCount: 8, memoryMB: 8192 }),
          });
        },
      },
    };
    const runSession = deps.runSession!;
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps: {
        ...deps,
        desktopModule: async () => sized,
        runSession: async (options) => {
          const session = await runSession(options);
          // A priced model id and reported usage; the participant runner turns them into the
          // estimate.
          session.trace.ids.model = "gpt-5.6-sol";
          session.trace.tokenUsage = { input: 1000, output: 200, total: 1200 };
          return session;
        },
      },
    });
    expect(result.ok).toBe(true);

    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    const lines = bundle.cost.breakdown as Array<{
      kind: string;
      laneId?: string;
      estimatedCostUsd: number | null;
    }>;
    expect(bundle.cost.fullyEstimated).toBe(true);
    expect(lines.filter((line) => line.kind === "model-tokens").map((line) => line.laneId)).toEqual(
      ["persona-01", "persona-02", "persona-03"],
    );
    expect(
      lines
        .filter((line) => line.kind === "desktop-minutes")
        .map((line) => line.laneId)
        .sort(),
    ).toEqual(["persona-01", "persona-02", "persona-03", "subject"]);
    expect(lines.every((line) => line.estimatedCostUsd !== null)).toBe(true);
    expect(bundle.cost.estimatedTotalUsd).toBeGreaterThan(0);

    const stats = await computeStats(cwd);
    if (!("costsByRun" in stats)) throw new Error("stats failed");
    const row = stats.costsByRun.find((entry) => entry.runId === result.runId);
    expect(row?.costs.runEstimatedUsd).toBe(bundle.cost.estimatedTotalUsd);
    expect(row?.warnings).not.toContain("RUN_COST_COMPLETENESS_UNKNOWN");
    expect(row?.warnings).not.toContain("RUN_COST_PARTIAL_OR_UNKNOWN");
  });
});

// Characterization: the complete run directory of a three-participant concurrent run on the fake
// E2B module, pinned so a refactor of bundle assembly or artifact writing shows up as a diff.
// Regenerate with `pnpm vitest run tests/routes/shared-world/concurrent.test.ts -u`.
describe("concurrent shared-world run directory goldens", () => {
  let goldenCwd: string;
  beforeEach(async () => {
    goldenCwd = await mkdtemp(path.join(tmpdir(), "humanish-csw-golden-"));
  });
  afterEach(async () => {
    await rm(goldenCwd, { recursive: true, force: true });
  });

  it.each([
    ["dry run", true, "shared-world-concurrent-dry-run.json"],
    ["live run", false, "shared-world-concurrent-live.json"],
  ] as const)("%s with three participants", async (_label, dryRun, golden) => {
    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const stderr = captureStderr();
    const result = await runConcurrentSharedWorld({
      cwd: goldenCwd,
      config: concurrentConfig(3, 3),
      dryRun,
      env,
      deps: { ...deps, analysis: { run: automaticAnalysisBoundary() } },
    }).finally(stderr.stop);
    // Participants tear down in parallel, so their sandbox receipts append in completion order.
    const snapshot = await runDirSnapshot(path.join(goldenCwd, ".humanish", "runs", result.runId), {
      result,
      stderr: stderr.text(),
      replace: [
        [result.runId, "[run]"],
        [goldenCwd, "[cwd]"],
      ],
      unorderedFiles: ["sandbox-receipts.ndjson"],
      // Desktop minutes are host-measured wall-clock spans of the fake sandboxes.
      maskKeys: ["minutes", "desktopMinutes"],
    });
    await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
      `../../golden/routes/${golden}`,
    );
  });
});

describe("concurrent run lifetime", () => {
  it("a throwing onObserverReady on the provisioned plane kills the subject, closes the run and runs no analysis", async () => {
    const { env, created, killed, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const analysis = automaticAnalysisBoundary();
    const failure = new Error("synthetic observer failure");
    await expect(
      runConcurrentSharedWorld({
        cwd,
        config: concurrentConfig(3, 3),
        dryRun: false,
        env,
        deps: { ...deps, analysis: { run: analysis } },
        onObserverReady: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    // Only the subject existed when the gate ran, and teardown still killed it.
    expect(created).toHaveLength(1);
    expect(killed).toEqual(["fake-sandbox-001"]);
    expect(analysis).not.toHaveBeenCalled();
    const runsRoot = path.join(cwd, ".humanish", "runs");
    const [runId] = (await readdir(runsRoot)).filter((entry) => entry !== "latest.json");
    const status = JSON.parse(await readFile(path.join(runsRoot, runId!, "status.json"), "utf8"));
    expect(status.state).toBe("finished");
    expect(status).not.toHaveProperty("outcome");
  });

  it("after every teardown kill fails, reclaim kills the subject and each participant", async () => {
    const { env, created, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const module = await deps.desktopModule!();
    const kill = module.Sandbox.kill!.bind(module.Sandbox);
    module.Sandbox.kill = async (sandboxId, options) => {
      await kill(sandboxId, options);
      throw new Error("synthetic kill failure");
    };
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
    });
    expect(created).toHaveLength(4);
    // No route's verdict reads cleanup: the failed kills leave the pass and the result's ok alone.
    const runDir = path.join(cwd, ".humanish", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as RunBundle;
    const status = JSON.parse(await readFile(path.join(runDir, "status.json"), "utf8")) as {
      outcome?: { verdict?: string; ok?: boolean };
    };
    expect(bundle.review.verdict).toBe("pass");
    expect(status.outcome?.verdict).toBe("pass");
    expect(result.ok).toBe(true);
    expect(status.outcome?.ok).toBe(result.ok);

    const reclaimed: string[] = [];
    await reclaimRunSandboxes(cwd, result.runId, {
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
    expect(reclaimed.sort()).toEqual([
      "fake-sandbox-001",
      "fake-sandbox-002",
      "fake-sandbox-003",
      "fake-sandbox-004",
    ]);
  });

  it("publishes the in-progress bundle and each participant's live trace with no Observer attached", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, async () => {});
    const runId = "concurrent-unattached-snapshot";
    const runsRoot = path.join(cwd, ".humanish", "runs");
    let seatsStarted = 0;
    let releaseSeats: () => void = () => {};
    const seatsReleased = new Promise<void>((resolve) => {
      releaseSeats = resolve;
    });
    deps.runSession = async (options: CuaActorSessionOptions): Promise<CuaLoopResult> => {
      seatsStarted += 1;
      options.onTrace?.(
        [{ id: "live-click", kind: "ui_action", lifecycle: "completed", title: "click" }],
        { input: 10, output: 2 },
      );
      await seatsReleased;
      state.worldVersion += 1;
      const trace = makeTrace({
        persona: options.persona,
        status: "passed",
        completionReason: "goal_satisfied",
        actions: 1,
        messages: 1,
      });
      return { status: "passed", completionReason: "goal_satisfied", reason: trace.reason, trace };
    };

    const runPromise = runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps,
      runId,
    });
    try {
      await waitForCondition("all seats started", () => seatsStarted === 3);
      const readBundle = async (): Promise<RunBundle> =>
        JSON.parse(await readFile(path.join(runsRoot, runId, "run.json"), "utf8")) as RunBundle;
      await waitForCondition(
        "every seat's live trace in run.json",
        async () =>
          (await readBundle()).streams.every((stream) =>
            stream.liveActor?.items.some((item) => item.id === "live-click"),
          ),
        // The participant flush writes at most every 2 s; with the 8 s wait above this stays under
        // the 20 s test timeout.
        10_000,
      );
      const midRun = await readBundle();
      expect(midRun.streams.map((stream) => stream.status)).toEqual([
        "running",
        "running",
        "running",
      ]);
      expect(midRun.streams.every((stream) => stream.actor === undefined)).toBe(true);
      const latest = JSON.parse(await readFile(path.join(runsRoot, "latest.json"), "utf8"));
      expect(latest.runId).toBe(runId);

      releaseSeats();
      const result = await runPromise;
      expect(result.ok).toBe(true);
      const final = await readBundle();
      expect(final.streams.every((stream) => stream.liveActor === undefined)).toBe(true);
      expect((await verifyRun(cwd, runId)).ok).toBe(true);
    } finally {
      releaseSeats();
      await runPromise.catch(() => undefined);
    }
  });
});

describe("concurrent shared-world project binding", () => {
  it("pins a symlink cwd before a subject phase can retarget the alias", async () => {
    const physicalA = path.join(cwd, "project-a");
    const physicalB = path.join(cwd, "project-b");
    const cwdAlias = path.join(cwd, "project-alias");
    const decoyRuns = path.join(physicalB, ".humanish", "runs");
    const decoyLatest = path.join(decoyRuns, "latest.json");
    const sentinel = "outside sentinel must stay unchanged\n";
    await mkdir(physicalA);
    await mkdir(decoyRuns, { recursive: true });
    await writeFile(decoyLatest, sentinel, "utf8");
    symlinkSync(physicalA, cwdAlias, "dir");
    const pinnedA = await realpath(physicalA);

    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const recordPhase = deps.subjectPhaseSink!;
    let retargeted = false;
    const retargetOnFirstPhase: StudyDeps = {
      ...deps,
      subjectPhaseSink: (event, participant) => {
        if (!retargeted) {
          retargeted = true;
          unlinkSync(cwdAlias);
          symlinkSync(physicalB, cwdAlias, "dir");
        }
        recordPhase(event, participant);
      },
    };

    const result = await runConcurrentSharedWorld({
      cwd: cwdAlias,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env,
      deps: retargetOnFirstPhase,
    });

    expect(retargeted).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.cwd).toBe(pinnedA);
    expect(result.observer?.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(physicalA, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    );
    expect(bundle.runId).toBe(result.runId);
    const latest = JSON.parse(
      await readFile(path.join(physicalA, ".humanish", "runs", "latest.json"), "utf8"),
    );
    expect(latest.runId).toBe(result.runId);
    expect(await readFile(decoyLatest, "utf8")).toBe(sentinel);
    expect(await readdir(decoyRuns)).toEqual(["latest.json"]);
  });
});

describe("the subject state prober", () => {
  it("snapshots the subject on its cadence while the participants run", async () => {
    const state = { worldVersion: 0 };
    const { env, deps } = baseSeams(state, makeRendezvous(3));
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(),
      dryRun: false,
      env,
      deps: { ...deps, proberCadenceMs: 1 },
    });

    expect(result.ok).toBe(true);
    const bundle = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "run.json"), "utf8"),
    ) as RunBundle;
    // The baseline and the teardown snapshot are taken either way; a third means the cadence fired.
    expect(bundle.sharedWorld?.stateSeries?.length).toBeGreaterThan(2);
  });
});

describe("RunLabOptions homes on the concurrent route", () => {
  it("prepareDesktop sees the subject, then each participant; onStream sees each participant's stream start and end", async () => {
    const { env, deps } = baseSeams({ worldVersion: 0 }, makeRendezvous(3));
    const targets: unknown[] = [];
    const streams: string[] = [];
    const outcome = await runStudyWith(
      concurrentConfig(3, 3),
      {
        cwd,
        dryRun: false,
        env,
        prepareDesktop: async (_desktop, target) => {
          targets.push(target);
        },
        onStream: (event) => {
          streams.push(`${event.type}:${event.participantId}`);
        },
      },
      deps,
    );

    expect(outcome.result.ok).toBe(true);
    expect(targets[0]).toEqual({ kind: "subject" });
    const seats = ["persona-01", "persona-02", "persona-03"];
    expect(targets.slice(1)).toHaveLength(3);
    expect(targets.slice(1)).toEqual(
      expect.arrayContaining(
        seats.map((id, index) => ({ kind: "participant", participant: { id, index, count: 3 } })),
      ),
    );
    expect(streams.filter((entry) => entry.startsWith("ready:")).sort()).toEqual(
      seats.map((id) => `ready:${id}`),
    );
    expect(streams.filter((entry) => entry.startsWith("ended:")).sort()).toEqual(
      seats.map((id) => `ended:${id}`),
    );
  });
});

describe("concurrent shared-world run failure naming", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "humanish-sw-run-failure-"));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it("names a desktop module that fails to load, not only the bundle verify then refused", async () => {
    const result = await runConcurrentSharedWorld({
      cwd,
      config: concurrentConfig(3, 3),
      dryRun: false,
      env: {
        OPENAI_API_KEY: "synthetic-openai",
        E2B_API_KEY: "synthetic-e2b",
        DATABASE_URL: "postgres://synthetic",
      },
      deps: {
        desktopModule: async () => {
          throw new Error("synthetic desktop module load failure");
        },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toEqual({
      code: "HUMANISH_SHARED_WORLD_FAILED",
      message: "synthetic desktop module load failure The run bundle it left failed verification.",
    });
    const status = JSON.parse(
      await readFile(path.join(cwd, ".humanish", "runs", result.runId, "status.json"), "utf8"),
    );
    expect(
      status.outcome.execution.failures.map((failure: { kind: string }) => failure.kind),
    ).toEqual(["run", "evidence"]);
  });
});
