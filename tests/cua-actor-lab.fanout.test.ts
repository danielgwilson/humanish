import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import { runCuaActorSession, type CuaActorSessionOptions } from "../src/computer-use-actor.js";
import {
  resolveCuaLanePlan,
  runCuaActorLab,
  type CuaActorLabHooks,
  type CuaLanePlan
} from "../src/cua-actor-lab.js";
import type { E2BDesktopCreateOptions, E2BDesktopModule, E2BDesktopSandbox } from "../src/e2b-desktop-launch.js";
import { LAB_CONFIG_SCHEMA, parseLabConfig, type LabConfig } from "../src/lab-config.js";
import { runLab } from "../src/lab-engine.js";
import type { FetchLike } from "../src/openai-responses-cu.js";
import type { BrowserLabScoringContext, RunAdapterScore, RunBundle } from "../src/index.js";
import { verifyRun } from "../src/run.js";

// ---------------------------------------------------------------------------
// Fan-out fakes: a desktop module that mints a DISTINCT sandbox per create()
// (unique sandboxId), records create options (per-lane metadata) and kill calls
// (by id), tracks peak concurrent live sandboxes, and answers xdpyinfo with the
// requested geometry (so the per-lane geometry assertion passes). It has NO
// `list` method — enumerate-and-kill is physically impossible.
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
    return { ok: true, status: 200, text: async () => JSON.stringify(value), json: async () => value };
  };
}

const TWO_TURN_SESSION = [
  { id: "resp_1", output: [{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 11, y: 22 }] }] },
  { id: "resp_2", output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }] }
];
const HOLLOW_SESSION = [{ id: "r1", output: [{ type: "message", content: [] }] }];
const FANOUT_ADAPTER_NAMESPACE = "fanout-browser-adapter-proof";

function fanoutFailScore(ctx: BrowserLabScoringContext): RunAdapterScore {
  return {
    schema: "mimetic.adapter-score.v1",
    namespace: FANOUT_ADAPTER_NAMESPACE,
    status: "fail",
    score: 15,
    summary: `${ctx.backend} fan-out adapter found no product-level success evidence.`,
    data: {
      backend: ctx.backend,
      laneCount: ctx.laneCount
    }
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

interface FanoutModuleOptions {
  /** Override the geometry a given sandbox reports (laneIndex from metadata). Default: matches. */
  geometryOverride?: (laneIndex: number, requested: [number, number]) => [number, number];
}

interface FanoutModuleHandle {
  module: E2BDesktopModule;
  created: E2BDesktopCreateOptions[];
  /** Parallel to `created`: the custom template each lane's create() got (undefined == default). */
  templates: (string | undefined)[];
  killed: string[];
  createdIds: string[];
  /** Peak count of simultaneously-live (created, not yet killed) sandboxes. */
  maxLive: () => number;
}

function makeFanoutModule(options: FanoutModuleOptions = {}): FanoutModuleHandle {
  const created: E2BDesktopCreateOptions[] = [];
  const templates: (string | undefined)[] = [];
  const createdIds: string[] = [];
  const killed: string[] = [];
  let serial = 0;
  let live = 0;
  let maxLive = 0;

  const makeSandbox = (id: string, createOptions: E2BDesktopCreateOptions): E2BDesktopSandbox => {
    const requested = createOptions.resolution ?? [1440, 950];
    const laneIndex = Number(createOptions.metadata?.laneIndex ?? "0");
    const reported = options.geometryOverride ? options.geometryOverride(laneIndex, requested) : requested;
    let frame = 0;
    const record = (name: string) => async (): Promise<void> => { void name; };
    return {
      sandboxId: id,
      commands: {
        run: async (command: string) => {
          if (command.includes("xdpyinfo")) {
            return { exitCode: 0, stdout: `  dimensions:    ${reported[0]}x${reported[1]} pixels (300x200 millimeters)\n` };
          }
          return { exitCode: 0, stdout: "" };
        }
      },
      files: { write: async () => undefined },
      launch: record("launch") as (application: string, uri?: string) => Promise<void>,
      open: (async () => undefined) as (fileOrUrl: string) => Promise<void>,
      async screenshot() {
        frame += 1;
        return makePng(frame);
      },
      async wait() { /* settle is instant in the fake */ },
      stream: {
        getAuthKey: () => "fake-auth-key",
        getUrl: () => "https://stream.invalid/fake-auth-key",
        start: async () => undefined
      },
      leftClick: record("leftClick"),
      rightClick: record("rightClick"),
      middleClick: record("middleClick"),
      doubleClick: record("doubleClick"),
      moveMouse: record("moveMouse"),
      scroll: record("scroll"),
      write: record("write"),
      press: record("press"),
      drag: record("drag")
    } as unknown as E2BDesktopSandbox;
  };

  const module: E2BDesktopModule = {
    Sandbox: {
      // Mirror the real @e2b/desktop overload: create(opts) OR create(template, opts).
      create: async (templateOrOptions: string | E2BDesktopCreateOptions, maybeOptions?: E2BDesktopCreateOptions) => {
        const template = typeof templateOrOptions === "string" ? templateOrOptions : undefined;
        const createOptions = typeof templateOrOptions === "string" ? maybeOptions! : templateOrOptions;
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
        killed.push(sandboxId);
        live -= 1;
        return undefined;
      }
      // NO `list` — the lab can only kill the exact ids it created, never enumerate.
    }
  };

  return { module, created, templates, killed, createdIds, maxLive: () => maxLive };
}

/** A 4-lane differentiated roster on a loopback app-url subject. */
function fanoutConfig(overrides?: { concurrency?: number; lanes?: LabConfig["actors"][0]["lanes"]; template?: string }): LabConfig {
  const parsed = parseLabConfig({
    schema: LAB_CONFIG_SCHEMA,
    id: "fanout-proof",
    title: "Fan-out proof",
    subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
    actors: [{
      type: "openai-computer-use",
      mission: "Explore the app and stop.",
      lanes: overrides?.lanes ?? [
        { id: "mobile-newcomer", persona: "first-time-visitor", device: "mobile", instruction: "Sign up from a phone." },
        { id: "small-skimmer", persona: "impatient-skimmer", device: "small-mobile", instruction: "Skim and bounce." },
        { id: "desktop-power", persona: "power-user", device: "desktop", instruction: "Open advanced settings." },
        { id: "wide-researcher", persona: "comparison-shopper", device: "wide", instruction: "Compare the plans." }
      ]
    }],
    execution: {
      target: "e2b-desktop",
      timeoutMs: 60_000,
      concurrency: overrides?.concurrency ?? 2,
      ...(overrides?.template === undefined ? {} : { desktop: { template: overrides.template } })
    },
    scenario: { mode: "live" }
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.config;
}

describe("cua fan-out — dry-run ($0 contract bundle)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "mimetic-fanout-dry-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("a 4-lane roster yields ONE bundle, simCount 4, per-lane persona/device/viewport, a plan event, contract statuses; verifyRun ok", async () => {
    const planSeen: CuaLanePlan[] = [];
    const outcome = await runLab(fanoutConfig(), { cwd, dryRun: true, cuaHooks: { onPreflight: (plan) => planSeen.push(plan) } });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.lanes).toHaveLength(4);
    expect(result.laneSummary?.total).toBe(4);

    // The pre-flight plan is observable BEFORE any provider call and marked $0 in dry-run.
    expect(planSeen).toHaveLength(1);
    expect(planSeen[0]?.dryRun).toBe(true);
    expect(planSeen[0]?.laneCount).toBe(4);
    expect(planSeen[0]?.concurrency).toBe(2);
    expect(planSeen[0]?.waves).toBe(2);

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8"));
    expect(bundle.schema).toBe("mimetic.run-bundle.v1");
    expect(bundle.mode).toBe("dry-run");
    expect(bundle.simCount).toBe(4);
    expect(bundle.streams).toHaveLength(4);
    expect(bundle.streams.map((s: { status: string }) => s.status)).toEqual([
      "contract_proof_only", "contract_proof_only", "contract_proof_only", "contract_proof_only"
    ]);
    // Per-lane persona + device viewport carried honestly.
    expect(bundle.streams.map((s: { viewport: { width: number; height: number } }) => [s.viewport.width, s.viewport.height])).toEqual([
      [414, 896], [360, 740], [1440, 950], [1920, 1080]
    ]);
    expect(bundle.simulations.map((s: { personaId: string }) => s.personaId)).toEqual([
      "first-time-visitor", "impatient-skimmer", "power-user", "comparison-shopper"
    ]);
    // The plan is recorded as a bundle event.
    expect(bundle.events.some((e: { type: string }) => e.type === "cua-lab.fanout.plan")).toBe(true);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("resolveCuaLanePlan is pure: concurrency default min(N,3), env override only LOWERS", () => {
    const config = fanoutConfig({ concurrency: undefined as unknown as number, lanes: [
      { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }
    ] });
    // No declared concurrency on a 5-lane roster → default min(5,3) = 3.
    const planDefault = resolveCuaLanePlan({ ...config, execution: { target: "e2b-desktop" } });
    expect(planDefault.concurrency).toBe(3);
    // Env override LOWERS to 2.
    const planLowered = resolveCuaLanePlan({ ...config, execution: { target: "e2b-desktop" } }, { env: { MIMETIC_CUA_MAX_CONCURRENCY: "2" } });
    expect(planLowered.concurrency).toBe(2);
    // Env override may NOT raise above the config/default (clamped to laneCount + the base).
    const planRaiseAttempt = resolveCuaLanePlan({ ...config, execution: { target: "e2b-desktop", concurrency: 2 } }, { env: { MIMETIC_CUA_MAX_CONCURRENCY: "9" } });
    expect(planRaiseAttempt.concurrency).toBe(2);
  });
});

describe("cua fan-out — live with FAKE substrate ($0, real orchestration)", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "mimetic-fanout-live-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  function passingHooks(handle: FanoutModuleHandle, extra?: Partial<CuaActorLabHooks> & { active?: { count: number; max: number } }): CuaActorLabHooks {
    const active = extra?.active ?? { count: 0, max: 0 };
    return {
      env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
      loadDesktopModule: async () => handle.module,
      runSession: async (options: CuaActorSessionOptions) => {
        active.count += 1;
        active.max = Math.max(active.max, active.count);
        try {
          await delay(20); // hold so concurrent lanes genuinely overlap
          // FRESH fetch per lane (each lane its own session transport).
          return await runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        } finally {
          active.count -= 1;
        }
      },
      ...extra
    };
  }

  it("execution.desktop.template: EVERY fan-out lane's Sandbox.create gets the template; bundle records it", async () => {
    const handle = makeFanoutModule();
    const outcome = await runLab(fanoutConfig({ concurrency: 2, template: "acme-desktop-with-runtimes" }), { cwd, cuaHooks: passingHooks(handle) });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    expect(outcome.result.ok).toBe(true);
    // All four per-lane desktops launched on the custom template (subject + every lane is uniform).
    expect(handle.created).toHaveLength(4);
    expect(handle.templates).toEqual([
      "acme-desktop-with-runtimes",
      "acme-desktop-with-runtimes",
      "acme-desktop-with-runtimes",
      "acme-desktop-with-runtimes"
    ]);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.desktopTemplate).toBe("acme-desktop-with-runtimes");
  });

  it("byte-stable default: NO template → every fan-out lane's create gets NO template arg, bundle omits desktopTemplate", async () => {
    const handle = makeFanoutModule();
    const outcome = await runLab(fanoutConfig({ concurrency: 2 }), { cwd, cuaHooks: passingHooks(handle) });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    expect(handle.created).toHaveLength(4);
    expect(handle.templates).toEqual([undefined, undefined, undefined, undefined]);
    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", outcome.result.runId, "run.json"), "utf8"));
    expect(bundle.desktopTemplate).toBeUndefined();
  });

  it("runs the REAL orchestration at N=4, concurrency 2: 4 per-lane sandboxes, bounded concurrency, teardown kills ONLY each lane's own id, verifyRun ok", async () => {
    const handle = makeFanoutModule();
    const active = { count: 0, max: 0 };
    const outcome = await runLab(fanoutConfig({ concurrency: 2 }), { cwd, cuaHooks: passingHooks(handle, { active }) });
    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;

    expect(result.ok).toBe(true);
    expect(result.laneSummary).toMatchObject({ total: 4, passed: 4, skipped: 0, harnessErrors: 0, hollow: 0, concurrency: 2, waves: 2 });

    // Four sandboxes created, each with per-lane metadata.
    expect(handle.created).toHaveLength(4);
    expect(handle.created.map((c) => c.metadata?.laneId)).toEqual([
      "mobile-newcomer", "small-skimmer", "desktop-power", "wide-researcher"
    ]);
    expect(handle.created.map((c) => c.metadata?.laneIndex)).toEqual(["0", "1", "2", "3"]);
    expect(handle.created.every((c) => c.metadata?.laneCount === "4")).toBe(true);
    // Per-lane device geometry drove each sandbox's resolution.
    expect(handle.created.map((c) => c.resolution)).toEqual([[414, 896], [360, 740], [1440, 950], [1920, 1080]]);
    // The model's key NEVER enters any sandbox.
    expect(handle.created.every((c) => c.envs === undefined)).toBe(true);

    // Bounded concurrency: never more than 2 lanes in flight at once (and genuinely parallel).
    expect(active.max).toBe(2);
    expect(handle.maxLive()).toBeLessThanOrEqual(2);

    // Teardown kills EXACTLY the four created ids, BY id — never an enumerate-and-kill (the fake
    // module exposes no `list`, and the killed set equals the created set).
    expect([...handle.killed].sort()).toEqual([...handle.createdIds].sort());
    expect(handle.createdIds).toEqual(["fake-sandbox-01", "fake-sandbox-02", "fake-sandbox-03", "fake-sandbox-04"]);

    // The bundle PASSES verifyRun (not merely written).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);

    // Per-lane evidence on disk: one screenshots/<laneId>/ dir + one actors/<streamId>.json each.
    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    expect(bundle.streams).toHaveLength(4);
    for (const laneId of ["mobile-newcomer", "small-skimmer", "desktop-power", "wide-researcher"]) {
      const shots = await readdir(path.join(runDir, "screenshots", laneId));
      expect(shots.length, laneId).toBeGreaterThan(0);
    }
    const traceFiles = await readdir(path.join(runDir, "actors"));
    expect(traceFiles).toHaveLength(4);
    // Per-lane provider-neutral actor seam filled per stream.
    expect(bundle.streams.every((s: { actor?: { lane: string } }) => s.actor?.lane === "computer-use")).toBe(true);
  });

  it("adapter fail score turns an otherwise green CUA fan-out run red while preserving the verified bundle", async () => {
    const handle = makeFanoutModule();
    const outcome = await runLab(fanoutConfig({ concurrency: 2 }), {
      cwd,
      cuaHooks: passingHooks(handle, { score: fanoutFailScore })
    });

    expect(outcome.backend).toBe("cua");
    if (outcome.backend !== "cua") return;
    const result = outcome.result;
    expect(result.laneSummary).toMatchObject({ total: 4, passed: 4, skipped: 0, harnessErrors: 0, hollow: 0 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("Adapter scorer failed the run");

    const bundle = JSON.parse(await readFile(path.join(cwd, ".mimetic", "runs", result.runId, "run.json"), "utf8")) as RunBundle;
    expect(bundle.adapterScore?.namespace).toBe(FANOUT_ADAPTER_NAMESPACE);
    expect(bundle.adapterScore?.status).toBe("fail");
    expect(bundle.adapterScore?.data?.laneCount).toBe(4);
    expect(bundle.review.verdict).toBe("fail");
    expect(bundle.review.gaps.some((gap) => gap.includes("Adapter scorer failed the run"))).toBe(true);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("pipeline gate: lane-1 provisioning failure ⇒ the remaining lanes never start a sandbox", async () => {
    const handle = makeFanoutModule();
    const outcome = await runLab(fanoutConfig({ concurrency: 2 }), {
      cwd,
      cuaHooks: {
        ...passingHooks(handle),
        // Fail provisioning for lane 0 (the gate owner) via the per-lane prepareDesktop context.
        prepareDesktop: async (_desktop, lane) => {
          if (lane.laneIndex === 0) throw new Error("lane-0 world failed to provision");
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    // Only lane 0's sandbox was ever created; the gate kept lanes 2-4 from starting.
    expect(handle.created).toHaveLength(1);
    expect(handle.created[0]?.metadata?.laneId).toBe("mobile-newcomer");
    // Lane 0's sandbox was still torn down by id.
    expect(handle.killed).toEqual(["fake-sandbox-01"]);
    // The other lanes are reported blocked.
    expect(result.laneSummary?.skipped).toBe(3);
    expect(result.lanes?.slice(1).every((lane) => lane.status === "blocked")).toBe(true);
    expect(result.lanes?.[1]?.skippedReason).toContain("pipeline gate");
  });

  it("fail-fast on a HARNESS error: in-flight lanes finish, queued lanes are blocked + a fail-fast event, run ok=false, completed evidence intact", async () => {
    const handle = makeFanoutModule();
    const outcome = await runLab(fanoutConfig({ concurrency: 2 }), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          // Lane "small-skimmer" (index 1) hits a HARNESS error; lane 0 finishes in flight.
          if (options.persona.id === "impatient-skimmer") {
            await delay(5);
            throw new Error("provider exploded mid-session");
          }
          await delay(25);
          return runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.laneSummary?.harnessErrors).toBe(1);
    expect(result.laneSummary?.skipped).toBeGreaterThanOrEqual(1);
    // Only the in-flight lanes (0 and 1) ever created a sandbox; queued lanes were skipped.
    expect(handle.created.length).toBeLessThanOrEqual(2);
    // Every created sandbox was torn down by id (no leak, no enumerate).
    expect([...handle.killed].sort()).toEqual([...handle.createdIds].sort());

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
    const bundle = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
    // A fail-fast event is recorded.
    expect(bundle.events.some((e: { type: string }) => e.type === "cua-lab.fanout.fail-fast")).toBe(true);
    // Completed evidence intact: lane 0 reached a terminal session with an actor trace.
    const laneZero = bundle.streams.find((s: { id: string }) => s.id === "stream-001");
    expect(laneZero?.actor?.lane).toBe("computer-use");
    // The bundle is still a verifiable record (the failure IS the evidence).
    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(true);
  });

  it("a hollow lane (zero actions/messages) ⇒ run ok=false AND verifyRun fails the engagement check", async () => {
    const handle = makeFanoutModule();
    const outcome = await runLab(fanoutConfig({ concurrency: 2 }), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: "test-openai-key", E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          const responses = options.persona.id === "power-user" ? HOLLOW_SESSION : TWO_TURN_SESSION;
          return runCuaActorSession({ ...options, openai: { apiKey: "test-openai-key", fetchFn: scriptedFetch(responses) } });
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.laneSummary?.hollow).toBe(1);
    // No fail-fast: a mission/hollow verdict never trips it — all lanes still ran.
    expect(handle.created).toHaveLength(4);

    const verified = await verifyRun(cwd, result.runId);
    expect(verified.ok).toBe(false);
    expect(verified.checks.find((check) => check.name === "actor engagement")?.ok).toBe(false);
  });

  it("geometry mismatch ⇒ DEVICE_GEOMETRY (the per-lane device claim is verified in-sandbox)", async () => {
    // Single lane whose desktop reports the WRONG dimensions.
    const handle = makeFanoutModule({ geometryOverride: () => [800, 600] });
    const config = parseLabConfig({
      schema: LAB_CONFIG_SCHEMA,
      id: "geometry-proof",
      subject: { source: "app-url", appUrl: "http://127.0.0.1:3000/" },
      actors: [{ type: "openai-computer-use", mission: "Explore." }],
      execution: { target: "e2b-desktop", timeoutMs: 60_000, desktop: { device: "mobile" } },
      scenario: { mode: "live" }
    });
    if (!config.ok) throw new Error(config.error.message);
    const outcome = await runLab(config.config, { cwd, cuaHooks: passingHooks(handle) });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_DEVICE_GEOMETRY");
    // The sandbox was still torn down by id (fail-closed never leaks).
    expect(handle.killed).toEqual(handle.createdIds);
  });

  it("per-lane secret scrub holds: a provisioned/actor key value never reaches any artifact", async () => {
    const handle = makeFanoutModule();
    const secret = "test-openai-key";
    const outcome = await runLab(fanoutConfig({ concurrency: 2 }), {
      cwd,
      cuaHooks: {
        env: { OPENAI_API_KEY: secret, E2B_API_KEY: "test-e2b-key" },
        loadDesktopModule: async () => handle.module,
        runSession: async (options: CuaActorSessionOptions) => {
          // One lane's harness error echoes the actor key value — it must be scrubbed everywhere.
          if (options.persona.id === "comparison-shopper") {
            throw new Error(`request failed using ${secret} while connecting`);
          }
          await delay(10);
          return runCuaActorSession({ ...options, openai: { apiKey: secret, fetchFn: scriptedFetch(TWO_TURN_SESSION) } });
        }
      }
    });
    if (outcome.backend !== "cua") throw new Error("expected cua backend");
    const result = outcome.result;

    const runDir = path.join(cwd, ".mimetic", "runs", result.runId);
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
    // The lane error is still diagnosable but scrubbed.
    expect(JSON.stringify(result.lanes)).not.toContain(secret);
  });
});

describe("cua fan-out — engine fail-closed guards", () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(path.join(tmpdir(), "mimetic-fanout-guard-")); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it("rejects multi-lane fan-out on the in-process route (buildExecutor) — single lane only", async () => {
    const handle = makeFanoutModule();
    const result = await runCuaActorLab({
      cwd,
      config: fanoutConfig({ concurrency: 2 }),
      dryRun: false,
      hooks: {
        loadDesktopModule: async () => handle.module,
        buildExecutor: async () => ({ observe: async () => ({ stateSignature: "x", appState: {} }), execute: async () => undefined }),
        buildProvider: async () => ({ id: "p", capabilities: { headless: true, structuredTrace: true, lanes: ["computer-use"], producesScreenshots: false, byoModel: true, preGrantableApprovals: false, inProcessTools: false, license: "open" }, async nextTurn() { return { actions: [], pendingSafetyChecks: [], done: true }; } })
      }
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_FANOUT_INVALID");
    // Nothing was provisioned.
    expect(handle.created).toHaveLength(0);
  });

  it("re-enforces clone.fanout rejection at the engine even if a config bypasses the parser", async () => {
    const base = fanoutConfig({ concurrency: 2 });
    const tampered = { ...base, subject: { ...base.subject, clone: { fanout: 2 } } } as LabConfig;
    const result = await runCuaActorLab({ cwd, config: tampered, dryRun: true });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("MIMETIC_CUA_LAB_FANOUT_INVALID");
  });
});
